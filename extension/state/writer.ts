/**
 * Tokyo state writer — ported from GJC's `state-writer.ts`.
 *
 * SOLE SANCTIONED `.tokyo/**` writer module (gate G1). Every native `.tokyo/**`
 * filesystem mutation must route through these primitives. No lockfiles are used;
 * isolation is by:
 *   - atomic rename (write temp → fsync → rename),
 *   - O_EXCL no-clobber creates,
 *   - conditional (owned) deletes,
 *   - append-only JSONL for ledgers/audit,
 *   - sha256 content stamping for tamper-evidence,
 *   - hard path-gating: refuse any target outside `.tokyo/`.
 *
 * Pure node fs + the pure `schema.ts` module. No pi API import — `index.ts`
 * stays the only file that touches pi.
 */
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import {
	type AuditCategory,
	AuditEntrySchema,
	type AuditOwner,
	type RequiredOnWriteEnvelope,
	RequiredOnWriteEnvelopeSchema,
	WORKFLOW_STATE_VERSION,
	type WorkflowStateEnvelope,
	WorkflowStateEnvelopeSchema,
} from "./schema.ts";

// ---- errors -------------------------------------------------------------------

/** Thrown when a target path escapes the `.tokyo/` containment. */
export class PathContainmentError extends Error {
	constructor(target: string, root: string) {
		super(`Refusing to operate on path outside ${root}: ${target}`);
		this.name = "PathContainmentError";
	}
}

/** Thrown by createJsonNoClobber when the target already exists (EEXIST). */
export class AlreadyExistsError extends Error {
	constructor(target: string) {
		super(`Refusing to clobber existing file: ${target}`);
		this.name = "AlreadyExistsError";
	}
}

/** Thrown by writeWorkflowEnvelopeAtomic when the strict write schema rejects. */
export class InvalidEnvelopeError extends Error {
	constructor(detail: string) {
		super(`Refusing to write invalid workflow state envelope: ${detail}`);
		this.name = "InvalidEnvelopeError";
	}
}

// ---- audit options ------------------------------------------------------------

export interface AuditOptions {
	category: AuditCategory;
	verb: string;
	owner?: AuditOwner;
	skill?: string;
	from_phase?: string;
	to_phase?: string;
	forced?: boolean;
}

interface WriteOptions {
	audit?: AuditOptions;
}

// ---- pure checksum helpers (exported for tests) -------------------------------

/**
 * Canonicalize a JSON value: recursively sort object keys and drop `undefined`,
 * so logically equal payloads hash identically regardless of key order.
 */
export function canonicalizeJson(value: unknown): unknown {
	if (value === null || typeof value !== "object") return value;
	if (Array.isArray(value)) return value.map(canonicalizeJson);
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(value as Record<string, unknown>).sort()) {
		const v = (value as Record<string, unknown>)[key];
		if (v === undefined) continue;
		out[key] = canonicalizeJson(v);
	}
	return out;
}

/**
 * Compute the sha256 of an envelope's canonicalized JSON, with the receipt's own
 * `content_sha256` stripped (so the stamp never covers itself).
 */
export function workflowEnvelopeContentSha256(envelope: WorkflowStateEnvelope): string {
	const clone = structuredClone(envelope) as WorkflowStateEnvelope;
	if (clone.receipt && typeof clone.receipt === "object") {
		const receipt = clone.receipt as Record<string, unknown>;
		delete receipt.content_sha256;
		// An emptied receipt must not perturb the hash: an envelope that never had
		// a receipt and one whose receipt held only the (now-stripped) checksum must
		// canonicalize identically. So drop the receipt key when nothing remains.
		if (Object.keys(receipt).length === 0) delete clone.receipt;
	}
	const canonical = JSON.stringify(canonicalizeJson(clone));
	return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Return a copy of the envelope with `receipt.content_sha256` set to the freshly
 * computed checksum block. Pure (does not mutate the input).
 */
export function stampWorkflowEnvelopeChecksum(
	envelope: WorkflowStateEnvelope,
	coveredPath: string,
): WorkflowStateEnvelope {
	const clone = structuredClone(envelope) as WorkflowStateEnvelope;
	const value = workflowEnvelopeContentSha256(clone);
	const receipt = (clone.receipt && typeof clone.receipt === "object" ? clone.receipt : {}) as Record<
		string,
		unknown
	>;
	receipt.content_sha256 = {
		algorithm: "sha256",
		value,
		covered_path: coveredPath,
		computed_at: new Date().toISOString(),
	};
	clone.receipt = receipt;
	return clone;
}

/**
 * Recompute the checksum and compare against the stored stamp.
 * Returns true when they DIFFER (i.e. an out-of-band edit was detected),
 * false when they match. A missing stamp counts as a mismatch.
 */
export function detectWorkflowEnvelopeIntegrityMismatch(envelope: WorkflowStateEnvelope): boolean {
	const stored = (envelope.receipt as { content_sha256?: { value?: string } } | undefined)?.content_sha256?.value;
	if (!stored) return true;
	return stored !== workflowEnvelopeContentSha256(envelope);
}

// ---- read result --------------------------------------------------------------

export type ReadResult<T> =
	| { ok: true; value: T }
	| { ok: false; raw: unknown; error: string }
	| null;

// ---- the writer ---------------------------------------------------------------

export class StateWriter {
	/** Absolute path to the project root that contains the dot-dir. */
	readonly root: string;
	/** Dot-dir name, e.g. ".tokyo". */
	readonly dotDir: string;
	/** Absolute path to the dot-dir. */
	readonly stateRoot: string;

	constructor(root: string, dotDir: string) {
		this.root = path.resolve(root);
		this.dotDir = dotDir;
		this.stateRoot = path.join(this.root, dotDir);
	}

	// ---- path gate ------------------------------------------------------------

	/**
	 * Resolve a `.tokyo/`-relative path to an absolute path, refusing anything
	 * that escapes containment (absolute inputs, `..` traversal, symlink-style
	 * escapes via normalization).
	 */
	resolveTarget(relativePath: string): string {
		const abs = path.resolve(this.stateRoot, relativePath);
		const rel = path.relative(this.stateRoot, abs);
		if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
			throw new PathContainmentError(abs, this.stateRoot);
		}
		return abs;
	}

	private async ensureDirFor(absPath: string): Promise<void> {
		await fsp.mkdir(path.dirname(absPath), { recursive: true });
	}

	// ---- atomic primitives ----------------------------------------------------

	/**
	 * Atomic file write: write to a unique temp sibling, fsync, then rename over
	 * the target (atomic on POSIX). On any error the temp file is removed.
	 */
	async atomicWrite(relativePath: string, content: string, options?: WriteOptions): Promise<string> {
		const target = this.resolveTarget(relativePath);
		await this.ensureDirFor(target);
		const tmp = `${target}.tmp.${process.pid}.${Date.now()}.${randomUUID()}`;
		let handle: fsp.FileHandle | undefined;
		try {
			handle = await fsp.open(tmp, "wx");
			await handle.writeFile(content, "utf8");
			await handle.sync();
			await handle.close();
			handle = undefined;
			await fsp.rename(tmp, target);
		} catch (err) {
			if (handle) await handle.close().catch(() => {});
			await fsp.rm(tmp, { force: true }).catch(() => {});
			throw err;
		}
		await this.maybeAudit(options?.audit, [target]);
		return target;
	}

	async writeTextAtomic(relativePath: string, text: string, options?: WriteOptions): Promise<string> {
		return this.atomicWrite(relativePath, text, options);
	}

	async writeJsonAtomic(relativePath: string, value: unknown, options?: WriteOptions): Promise<string> {
		return this.atomicWrite(relativePath, `${JSON.stringify(value, null, 2)}\n`, options);
	}

	/**
	 * Read-modify-write a JSON file atomically. The mutator receives the current
	 * value (or `undefined` if the file does not exist) and returns the next value.
	 */
	async updateJsonAtomic<T>(
		relativePath: string,
		mutator: (current: T | undefined) => T,
		options?: WriteOptions,
	): Promise<string> {
		const target = this.resolveTarget(relativePath);
		let current: T | undefined;
		try {
			const raw = await fsp.readFile(target, "utf8");
			current = JSON.parse(raw) as T;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
			current = undefined;
		}
		const next = mutator(current);
		return this.writeJsonAtomic(relativePath, next, options);
	}

	/**
	 * Append one JSON line to a JSONL file (the ledger/audit primitive). Creates
	 * the file and parent dirs if missing. Appends are atomic per write on POSIX
	 * for small lines and never clobber existing content.
	 */
	async appendJsonl(relativePath: string, entry: unknown, options?: WriteOptions): Promise<string> {
		const target = this.resolveTarget(relativePath);
		await this.ensureDirFor(target);
		await fsp.appendFile(target, `${JSON.stringify(entry)}\n`, "utf8");
		await this.maybeAudit(options?.audit, [target]);
		return target;
	}

	/**
	 * Create a JSON file with O_EXCL semantics: fails with AlreadyExistsError if
	 * the path already exists. Used for once-only creates / transaction journals.
	 */
	async createJsonNoClobber(relativePath: string, value: unknown, options?: WriteOptions): Promise<string> {
		const target = this.resolveTarget(relativePath);
		await this.ensureDirFor(target);
		try {
			const handle = await fsp.open(target, "wx");
			try {
				await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
				await handle.sync();
			} finally {
				await handle.close();
			}
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "EEXIST") {
				throw new AlreadyExistsError(target);
			}
			throw err;
		}
		await this.maybeAudit(options?.audit, [target]);
		return target;
	}

	// ---- workflow envelope ----------------------------------------------------

	/**
	 * Stamp the content checksum, then VALIDATE against the strict write schema
	 * and throw (InvalidEnvelopeError) before touching disk. This is the
	 * fail-closed write gate: only well-formed, fully-anchored, checksum-bearing
	 * envelopes are ever written.
	 */
	async writeWorkflowEnvelopeAtomic(
		relativePath: string,
		envelope: WorkflowStateEnvelope,
		options?: WriteOptions,
	): Promise<string> {
		const withVersion: WorkflowStateEnvelope = {
			version: WORKFLOW_STATE_VERSION,
			updated_at: new Date().toISOString(),
			...envelope,
		};
		const stamped = stampWorkflowEnvelopeChecksum(withVersion, relativePath);
		const parsed = RequiredOnWriteEnvelopeSchema.safeParse(stamped);
		if (!parsed.success) {
			throw new InvalidEnvelopeError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
		}
		return this.writeJsonAtomic(relativePath, stamped, options);
	}

	// ---- reads (fail-open) ----------------------------------------------------

	/**
	 * Read + lenient-parse a JSON file under `.tokyo/`.
	 *   - ENOENT → null ("no state").
	 *   - parse/validation failure → { ok:false, raw, error } (fail OPEN; caller
	 *     normalizes or logs — never throws to crash the agent loop).
	 *   - success → { ok:true, value }.
	 */
	async readTokyoJson(relativePath: string): Promise<ReadResult<WorkflowStateEnvelope>> {
		const target = this.resolveTarget(relativePath);
		let raw: string;
		try {
			raw = await fsp.readFile(target, "utf8");
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw err;
		}
		let parsedJson: unknown;
		try {
			parsedJson = JSON.parse(raw);
		} catch (err) {
			return { ok: false, raw, error: `invalid JSON: ${(err as Error).message}` };
		}
		const result = WorkflowStateEnvelopeSchema.safeParse(parsedJson);
		if (!result.success) {
			return { ok: false, raw: parsedJson, error: result.error.issues.map((i) => i.message).join("; ") };
		}
		return { ok: true, value: result.data };
	}

	/** Read an array-of-objects JSONL file. Bad lines are skipped (fail-open). */
	async readJsonl<T = unknown>(relativePath: string): Promise<T[]> {
		const target = this.resolveTarget(relativePath);
		let raw: string;
		try {
			raw = await fsp.readFile(target, "utf8");
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw err;
		}
		const out: T[] = [];
		for (const line of raw.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				out.push(JSON.parse(trimmed) as T);
			} catch {
				// skip corrupt line, keep reading
			}
		}
		return out;
	}

	// ---- deletes (conditional / audited) --------------------------------------

	/**
	 * Delete a file under the state root. Best-effort — no error if absent.
	 */
	async deleteJson(relativePath: string): Promise<void> {
		const target = this.resolveTarget(relativePath);
		if (!target) return;
		try { await fsp.rm(target, { force: true }); } catch { /* absent → no-op */ }
	}

	/**
	 * Delete a file only if the predicate (run against its current parsed JSON
	 * content) returns true. Returns true if deleted, false if the predicate
	 * rejected or the file was absent.
	 */
	async deleteIfOwned(
		relativePath: string,
		predicate: (current: unknown) => boolean,
		options?: WriteOptions,
	): Promise<boolean> {
		const target = this.resolveTarget(relativePath);
		let current: unknown;
		try {
			current = JSON.parse(await fsp.readFile(target, "utf8"));
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
			throw err;
		}
		if (!predicate(current)) return false;
		await fsp.rm(target, { force: true });
		await this.maybeAudit(options?.audit, [target]);
		return true;
	}

	/** Unconditional audited remove. Returns true if a file was removed. */
	async removeFileAudited(relativePath: string, options?: WriteOptions): Promise<boolean> {
		const target = this.resolveTarget(relativePath);
		let existed = true;
		try {
			await fsp.access(target);
		} catch {
			existed = false;
		}
		await fsp.rm(target, { force: true });
		if (existed) await this.maybeAudit(options?.audit, [target]);
		return existed;
	}

	/**
	 * The only sanctioned escape hatch: forcibly overwrite a target, wrapping the
	 * value in a forced envelope (unless `raw`). Always audited with forced=true.
	 */
	async forceOverwrite(
		relativePath: string,
		value: unknown,
		options?: { raw?: boolean; audit?: Omit<AuditOptions, "forced"> },
	): Promise<string> {
		const payload = options?.raw ? value : { forced: true, forced_at: new Date().toISOString(), value };
		const audit: AuditOptions = {
			category: "force",
			verb: "force_overwrite",
			owner: "tokyo-state-cli",
			...options?.audit,
			forced: true,
		};
		return this.writeJsonAtomic(relativePath, payload, { audit });
	}

	// ---- audit ----------------------------------------------------------------

	/** Build + validate + append an audit entry to `.tokyo/state/audit.jsonl`. */
	private async maybeAudit(audit: AuditOptions | undefined, paths: string[]): Promise<void> {
		if (!audit) return;
		const entry = {
			ts: new Date().toISOString(),
			skill: audit.skill,
			category: audit.category,
			verb: audit.verb,
			owner: audit.owner ?? "tokyo-runtime",
			mutation_id: randomUUID(),
			from_phase: audit.from_phase,
			to_phase: audit.to_phase,
			forced: audit.forced ?? false,
			// store paths relative to the state root for portability
			paths: paths.map((p) => path.relative(this.stateRoot, p)),
		};
		// validate our own entry shape (defensive; throws on programmer error)
		AuditEntrySchema.parse(entry);
		const auditTarget = path.join(this.stateRoot, "state", "audit.jsonl");
		await fsp.mkdir(path.dirname(auditTarget), { recursive: true });
		await fsp.appendFile(auditTarget, `${JSON.stringify(entry)}\n`, "utf8");
	}

	/** Read the full audit trail (fail-open; bad lines skipped). */
	async readAudit(): Promise<unknown[]> {
		return this.readJsonl(path.join("state", "audit.jsonl"));
	}
}

export type { RequiredOnWriteEnvelope, WorkflowStateEnvelope };
