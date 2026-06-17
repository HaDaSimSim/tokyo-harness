/**
 * Unit tests for the tokyo state layer (schema + writer).
 * Run: bun test
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
	AlreadyExistsError,
	canonicalizeJson,
	detectWorkflowEnvelopeIntegrityMismatch,
	InvalidEnvelopeError,
	PathContainmentError,
	RequiredOnWriteEnvelopeSchema,
	stampWorkflowEnvelopeChecksum,
	StateWriter,
	WORKFLOW_STATE_VERSION,
	workflowEnvelopeContentSha256,
	WorkflowStateEnvelopeSchema,
} from "./index.ts";

let root: string;
let w: StateWriter;

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "tokyo-state-"));
	w = new StateWriter(root, ".tokyo");
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

// ---- schema: read-lenient / write-strict asymmetry ---------------------------

describe("schema asymmetry", () => {
	test("read schema accepts an evolving/old envelope with unknown keys", () => {
		const result = WorkflowStateEnvelopeSchema.safeParse({
			current_phase: "INTERVIEW",
			some_future_field: { nested: true },
		});
		expect(result.success).toBe(true);
		// unknown keys preserved (.passthrough)
		expect((result.data as Record<string, unknown>).some_future_field).toEqual({ nested: true });
	});

	test("read schema accepts an empty object (no state yet)", () => {
		expect(WorkflowStateEnvelopeSchema.safeParse({}).success).toBe(true);
	});

	test("write schema rejects a missing required field", () => {
		const bad = RequiredOnWriteEnvelopeSchema.safeParse({
			skill: "interview",
			version: WORKFLOW_STATE_VERSION,
			updated_at: new Date().toISOString(),
			current_phase: "INTERVIEW",
			active: true,
			// receipt missing
		});
		expect(bad.success).toBe(false);
	});

	test("write schema rejects an unknown skill", () => {
		const bad = RequiredOnWriteEnvelopeSchema.safeParse({
			skill: "not-a-skill",
			version: WORKFLOW_STATE_VERSION,
			updated_at: new Date().toISOString(),
			current_phase: "X",
			active: true,
			receipt: { content_sha256: { algorithm: "sha256", value: "x", covered_path: "p", computed_at: "t" } },
		});
		expect(bad.success).toBe(false);
	});

	test("write schema accepts a fully-anchored envelope and preserves extra keys", () => {
		const ok = RequiredOnWriteEnvelopeSchema.safeParse({
			skill: "execute",
			version: WORKFLOW_STATE_VERSION,
			updated_at: new Date().toISOString(),
			current_phase: "EXECUTE",
			active: true,
			receipt: { content_sha256: { algorithm: "sha256", value: "abc", covered_path: "p", computed_at: "t" } },
			payload: { goals: 3 },
		});
		expect(ok.success).toBe(true);
		expect((ok.data as Record<string, unknown>).payload).toEqual({ goals: 3 });
	});
});

// ---- checksum helpers --------------------------------------------------------

describe("content checksum", () => {
	test("canonicalizeJson sorts keys and drops undefined", () => {
		const a = canonicalizeJson({ b: 1, a: 2, c: undefined });
		expect(JSON.stringify(a)).toBe(JSON.stringify({ a: 2, b: 1 }));
	});

	test("checksum is stable across key ordering", () => {
		const e1 = { skill: "plan", current_phase: "PLAN", active: true };
		const e2 = { active: true, current_phase: "PLAN", skill: "plan" };
		expect(workflowEnvelopeContentSha256(e1)).toBe(workflowEnvelopeContentSha256(e2));
	});

	test("stamp then detect: no mismatch on a freshly stamped envelope", () => {
		const stamped = stampWorkflowEnvelopeChecksum({ skill: "plan", current_phase: "PLAN", active: true }, "state.json");
		expect(detectWorkflowEnvelopeIntegrityMismatch(stamped)).toBe(false);
	});

	test("detect mismatch after an out-of-band edit", () => {
		const stamped = stampWorkflowEnvelopeChecksum({ skill: "plan", current_phase: "PLAN", active: true }, "state.json");
		(stamped as Record<string, unknown>).current_phase = "EXECUTE"; // tamper
		expect(detectWorkflowEnvelopeIntegrityMismatch(stamped)).toBe(true);
	});

	test("missing stamp counts as a mismatch", () => {
		expect(detectWorkflowEnvelopeIntegrityMismatch({ skill: "plan" })).toBe(true);
	});
});

// ---- path gate ---------------------------------------------------------------

describe("path containment gate", () => {
	test("resolves a normal relative path inside .tokyo", () => {
		const abs = w.resolveTarget("state/workflow.json");
		expect(abs).toBe(path.join(root, ".tokyo", "state", "workflow.json"));
	});

	test("rejects .. traversal", () => {
		expect(() => w.resolveTarget("../escape.json")).toThrow(PathContainmentError);
	});

	test("rejects absolute path", () => {
		expect(() => w.resolveTarget("/etc/passwd")).toThrow(PathContainmentError);
	});

	test("rejects the state root itself", () => {
		expect(() => w.resolveTarget(".")).toThrow(PathContainmentError);
	});

	test("rejects nested .. escape", () => {
		expect(() => w.resolveTarget("a/b/../../../out.json")).toThrow(PathContainmentError);
	});
});

// ---- atomic write ------------------------------------------------------------

describe("atomic write", () => {
	test("writes JSON and reads it back; no temp files left behind", async () => {
		await w.writeJsonAtomic("state/data.json", { hello: "world" });
		const target = path.join(root, ".tokyo", "state", "data.json");
		expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ hello: "world" });
		const leftovers = (await import("node:fs")).readdirSync(path.dirname(target)).filter((f) => f.includes(".tmp."));
		expect(leftovers).toEqual([]);
	});

	test("updateJsonAtomic creates then mutates", async () => {
		await w.updateJsonAtomic<{ n: number }>("counter.json", (cur) => ({ n: (cur?.n ?? 0) + 1 }));
		await w.updateJsonAtomic<{ n: number }>("counter.json", (cur) => ({ n: (cur?.n ?? 0) + 1 }));
		const got = await w.readTokyoJson("counter.json");
		expect(got && got.ok && (got.value as Record<string, unknown>).n).toBe(2);
	});
});

// ---- JSONL append ------------------------------------------------------------

describe("appendJsonl", () => {
	test("appends ordered ledger lines", async () => {
		await w.appendJsonl("ledger.jsonl", { event: "a" });
		await w.appendJsonl("ledger.jsonl", { event: "b" });
		const rows = await w.readJsonl<{ event: string }>("ledger.jsonl");
		expect(rows.map((r) => r.event)).toEqual(["a", "b"]);
	});

	test("readJsonl skips corrupt lines (fail-open)", async () => {
		const target = path.join(root, ".tokyo", "ledger.jsonl");
		(await import("node:fs")).mkdirSync(path.dirname(target), { recursive: true });
		writeFileSync(target, '{"event":"ok"}\nNOT JSON\n{"event":"ok2"}\n');
		const rows = await w.readJsonl<{ event: string }>("ledger.jsonl");
		expect(rows.map((r) => r.event)).toEqual(["ok", "ok2"]);
	});
});

// ---- O_EXCL no-clobber -------------------------------------------------------

describe("createJsonNoClobber", () => {
	test("creates once", async () => {
		await w.createJsonNoClobber("journal/txn.json", { id: 1 });
		const got = await w.readTokyoJson("journal/txn.json");
		expect(got && got.ok).toBe(true);
	});

	test("throws AlreadyExistsError on second create", async () => {
		await w.createJsonNoClobber("journal/txn.json", { id: 1 });
		await expect(w.createJsonNoClobber("journal/txn.json", { id: 2 })).rejects.toBeInstanceOf(AlreadyExistsError);
	});
});

// ---- workflow envelope write gate --------------------------------------------

describe("writeWorkflowEnvelopeAtomic (write gate)", () => {
	test("stamps checksum, validates, writes, and round-trips clean", async () => {
		await w.writeWorkflowEnvelopeAtomic("state/workflow.json", {
			skill: "interview",
			current_phase: "INTERVIEW",
			active: true,
		});
		const got = await w.readTokyoJson("state/workflow.json");
		expect(got && got.ok).toBe(true);
		if (got && got.ok) {
			expect(got.value.skill).toBe("interview");
			expect(got.value.version).toBe(WORKFLOW_STATE_VERSION);
			// stamped checksum present and verifies
			expect(detectWorkflowEnvelopeIntegrityMismatch(got.value)).toBe(false);
		}
	});

	test("refuses to write an envelope with an invalid skill", async () => {
		await expect(
			w.writeWorkflowEnvelopeAtomic("state/workflow.json", {
				skill: "bogus",
				current_phase: "X",
				active: true,
			}),
		).rejects.toBeInstanceOf(InvalidEnvelopeError);
		// nothing written
		expect(await w.readTokyoJson("state/workflow.json")).toBeNull();
	});

	test("an out-of-band edit to a written envelope is detectable", async () => {
		const target = await w.writeWorkflowEnvelopeAtomic("state/workflow.json", {
			skill: "plan",
			current_phase: "PLAN",
			active: true,
		});
		const tampered = JSON.parse(readFileSync(target, "utf8"));
		tampered.current_phase = "EXECUTE";
		const reparsed = WorkflowStateEnvelopeSchema.parse(tampered);
		expect(detectWorkflowEnvelopeIntegrityMismatch(reparsed)).toBe(true);
	});
});

// ---- reads fail-open ---------------------------------------------------------

describe("read fail-open", () => {
	test("ENOENT returns null", async () => {
		expect(await w.readTokyoJson("nope.json")).toBeNull();
	});

	test("invalid JSON returns ok:false with raw", async () => {
		const target = path.join(root, ".tokyo", "broken.json");
		(await import("node:fs")).mkdirSync(path.dirname(target), { recursive: true });
		writeFileSync(target, "{ not json");
		const got = await w.readTokyoJson("broken.json");
		expect(got && got.ok).toBe(false);
		if (got && !got.ok) expect(got.error).toContain("invalid JSON");
	});
});

// ---- conditional deletes -----------------------------------------------------

describe("deletes", () => {
	test("deleteIfOwned deletes only when predicate matches", async () => {
		await w.writeJsonAtomic("owned.json", { owner: "me" });
		expect(await w.deleteIfOwned("owned.json", (c) => (c as { owner: string }).owner === "you")).toBe(false);
		expect(await w.deleteIfOwned("owned.json", (c) => (c as { owner: string }).owner === "me")).toBe(true);
		expect(await w.readTokyoJson("owned.json")).toBeNull();
	});

	test("deleteIfOwned on missing file returns false", async () => {
		expect(await w.deleteIfOwned("ghost.json", () => true)).toBe(false);
	});

	test("removeFileAudited returns existence", async () => {
		await w.writeJsonAtomic("tmp.json", {});
		expect(await w.removeFileAudited("tmp.json")).toBe(true);
		expect(await w.removeFileAudited("tmp.json")).toBe(false);
	});
});

// ---- force override ----------------------------------------------------------

describe("forceOverwrite", () => {
	test("wraps value in a forced envelope by default", async () => {
		await w.forceOverwrite("state/workflow.json", { current_phase: "DONE" });
		const got = await w.readTokyoJson("state/workflow.json");
		expect(got && got.ok).toBe(true);
		if (got && got.ok) {
			const raw = got.value as Record<string, unknown>;
			expect(raw.forced).toBe(true);
			expect(raw.value).toEqual({ current_phase: "DONE" });
		}
	});

	test("raw mode writes value verbatim", async () => {
		await w.forceOverwrite("raw.json", { a: 1 }, { raw: true });
		const got = await w.readTokyoJson("raw.json");
		if (got && got.ok) expect(got.value as Record<string, unknown>).toEqual({ a: 1 });
	});
});

// ---- audit trail -------------------------------------------------------------

describe("audit trail", () => {
	test("mutations with audit options append to state/audit.jsonl with relative paths", async () => {
		await w.writeJsonAtomic("artifacts/spec.json", { x: 1 }, {
			audit: { category: "artifact", verb: "write_spec", skill: "interview", owner: "tokyo-runtime" },
		});
		await w.appendJsonl("ledger.jsonl", { event: "goal_created" }, {
			audit: { category: "ledger", verb: "append_event" },
		});
		const audit = (await w.readAudit()) as Array<Record<string, unknown>>;
		expect(audit.length).toBe(2);
		expect(audit[0].category).toBe("artifact");
		expect(audit[0].verb).toBe("write_spec");
		expect(audit[0].owner).toBe("tokyo-runtime");
		expect(audit[0].mutation_id).toBeTruthy();
		// paths are relative to the state root, never absolute
		expect((audit[0].paths as string[])[0]).toBe(path.join("artifacts", "spec.json"));
		expect(audit[1].owner).toBe("tokyo-runtime"); // default owner
	});

	test("writes without audit options leave no audit entries", async () => {
		await w.writeJsonAtomic("quiet.json", {});
		expect((await w.readAudit()).length).toBe(0);
	});

	test("forceOverwrite always audits with forced=true", async () => {
		await w.forceOverwrite("state/workflow.json", { current_phase: "DONE" });
		const audit = (await w.readAudit()) as Array<Record<string, unknown>>;
		expect(audit.length).toBe(1);
		expect(audit[0].forced).toBe(true);
		expect(audit[0].category).toBe("force");
		expect(audit[0].owner).toBe("tokyo-state-cli");
	});
});
