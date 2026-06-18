/**
 * Tokyo team coordination runtime — fs-backed via StateWriter.
 *
 * Persists the pure data-plane logic (coordination-logic.ts) under
 * `.tokyo/team/<team>/`. No central broker; coordination is filesystem state:
 *   - tasks/task-<id>.json     one file per task (atomic writes)
 *   - workers/<id>/status.json + heartbeat.json
 *   - mailbox/<id>/<seq>.json  per-worker inbox (append-only sequence)
 *   - events.jsonl             append-only audit/trace
 *   - manifest.json            team membership + phase
 *
 * All writes route through the StateWriter (gate G1, .tokyo/ containment + audit).
 */
import { randomUUID } from "node:crypto";
import type { StateWriter } from "../state/index.ts";
import {
	type ClaimResult,
	canClaim,
	findStaleClaims,
	nextClaimable,
	type TaskEvidence,
	type TeamTask,
	validateTaskCompletion,
	type Worker,
} from "./coordination-logic.ts";

export const HEARTBEAT_TIMEOUT_MS = 60_000;

export interface TeamManifest {
	team: string;
	created_at: string;
	phase: string;
	workers: Worker[];
}

function teamBase(team: string): string {
	return `team/${team}`;
}

export class TeamCoordinator {
	constructor(
		private readonly state: StateWriter,
		readonly team: string,
	) {}

	private p(rel: string): string {
		return `${teamBase(this.team)}/${rel}`;
	}

	// ---- lifecycle -----------------------------------------------------------

	async create(workers: Array<{ id: string; role?: string }>): Promise<TeamManifest> {
		const now = new Date().toISOString();
		const manifest: TeamManifest = {
			team: this.team,
			created_at: now,
			phase: "active",
			workers: workers.map((w) => ({ id: w.id, role: w.role, status: "starting", last_heartbeat: Date.now() })),
		};
		await this.state.writeJsonAtomic(this.p("manifest.json"), manifest, {
			audit: { category: "agents", verb: "team_create", skill: "team", owner: "tokyo-runtime" },
		});
		await this.event({ type: "team_created", workers: manifest.workers.map((w) => w.id) });
		return manifest;
	}

	async readManifest(): Promise<TeamManifest | null> {
		const res = await this.state.readTokyoJson(this.p("manifest.json"));
		if (res && res.ok) return res.value as unknown as TeamManifest;
		return null;
	}

	/**
	 * Mark the given workers as live (idle) in the manifest — called after the
	 * orchestrator confirms it spawned real RPC workers, so the dashboard stops
	 * showing them stuck at "starting". Workers not in `ids` are left untouched.
	 */
	async markWorkersLive(ids: string[]): Promise<void> {
		await this.setWorkersStatus(ids, "idle");
	}

	/**
	 * Set the status of the given workers in the manifest (e.g. "busy" while a
	 * hyperplan run is in flight, "idle" when it finishes). Workers not in `ids`
	 * are left untouched. Drives the live dashboard so members don't look idle
	 * while they're actually grinding through rounds.
	 */
	async setWorkersStatus(ids: string[], status: "idle" | "busy" | "starting" | "stopped"): Promise<void> {
		const m = await this.readManifest();
		if (!m) return;
		const target = new Set(ids);
		for (const w of m.workers) {
			if (target.has(w.id)) {
				w.status = status;
				w.last_heartbeat = Date.now();
			}
		}
		await this.state.writeJsonAtomic(this.p("manifest.json"), m, {
			audit: { category: "agents", verb: "team_workers_status", skill: "team", owner: "tokyo-runtime" },
		});
	}

	async delete(): Promise<void> {
		await this.event({ type: "team_deleted" });
		// leave the audit/events trail in place; just mark the manifest stopped
		const m = await this.readManifest();
		if (m) {
			m.phase = "stopped";
			for (const w of m.workers) w.status = "stopped";
			await this.state.writeJsonAtomic(this.p("manifest.json"), m, {
				audit: { category: "agents", verb: "team_delete", skill: "team" },
			});
		}
	}

	// ---- tasks ---------------------------------------------------------------

	async createTask(input: {
		objective: string;
		required_role?: string;
		depends_on?: string[];
		files?: string[];
	}): Promise<TeamTask> {
		const now = new Date().toISOString();
		const task: TeamTask = {
			id: randomUUID().slice(0, 8),
			objective: input.objective,
			status: "pending",
			owner: null,
			required_role: input.required_role,
			depends_on: input.depends_on ?? [],
			files: input.files,
			leased_at: null,
			created_at: now,
			updated_at: now,
		};
		await this.writeTask(task, "task_create");
		await this.event({ type: "task_created", task_id: task.id, objective: task.objective });
		return task;
	}

	async listTasks(): Promise<TeamTask[]> {
		// tasks are individual files; we track ids in the manifest-adjacent index
		const idx = await this.state.readJsonl<{ task_id: string }>(this.p("tasks/index.jsonl"));
		const ids = [...new Set(idx.map((e) => e.task_id))];
		const tasks: TeamTask[] = [];
		for (const id of ids) {
			const res = await this.state.readTokyoJson(this.p(`tasks/task-${id}.json`));
			if (res && res.ok) tasks.push(res.value as unknown as TeamTask);
		}
		return tasks;
	}

	private async writeTask(task: TeamTask, verb: string): Promise<void> {
		await this.state.writeJsonAtomic(this.p(`tasks/task-${task.id}.json`), task, {
			audit: { category: "state", verb, skill: "team", owner: "tokyo-runtime" },
		});
		await this.state.appendJsonl(this.p("tasks/index.jsonl"), { task_id: task.id });
	}

	// ---- claim / transition (the ordered lease gate) -------------------------

	async claimTask(taskId: string, worker: Worker): Promise<ClaimResult> {
		const tasks = await this.listTasks();
		const task = tasks.find((t) => t.id === taskId);
		const verdict = canClaim(task, worker, tasks);
		if (!verdict.ok || !task) return verdict;
		// Atomic mutual exclusion: only one worker can O_EXCL-create the lease file.
		// The loser gets AlreadyExistsError → claim refused (no last-writer-wins race).
		const token = randomUUID();
		try {
			await this.state.createJsonNoClobber(
				this.p(`claims/${taskId}.json`),
				{ task_id: taskId, owner: worker.id, token, leased_at: Date.now() },
				{ audit: { category: "state", verb: "task_lease", skill: "team" } },
			);
		} catch {
			return { ok: false, reason: `task ${taskId} already leased` };
		}
		// Re-read after acquiring the lease and re-validate (defends against a state
		// change between the snapshot and the lease).
		const fresh = (await this.listTasks()).find((t) => t.id === taskId);
		const recheck = canClaim(fresh, worker, await this.listTasks());
		if (!recheck.ok || !fresh) {
			await this.state.removeFileAudited(this.p(`claims/${taskId}.json`));
			return recheck.ok ? { ok: false, reason: "task vanished" } : recheck;
		}
		fresh.status = "claimed";
		fresh.owner = worker.id;
		fresh.claim_token = token;
		fresh.leased_at = Date.now();
		fresh.updated_at = new Date().toISOString();
		await this.writeTask(fresh, "task_claim");
		await this.event({ type: "task_claimed", task_id: taskId, worker: worker.id });
		return { ok: true };
	}

	async transitionTask(
		taskId: string,
		status: TeamTask["status"],
		evidence?: TaskEvidence[],
		token?: string,
	): Promise<ClaimResult> {
		const tasks = await this.listTasks();
		const task = tasks.find((t) => t.id === taskId);
		if (!task) return { ok: false, reason: "task not found" };
		// Ownership proof: a leased task (claim_token set) REQUIRES the matching token
		// on every transition. Missing or mismatched token is refused — a worker can't
		// transition another worker's leased task.
		if (task.claim_token) {
			if (!token) return { ok: false, reason: "task is leased; the owning worker's claim token is required" };
			if (task.claim_token !== token) return { ok: false, reason: "claim token mismatch" };
		}
		if (status === "complete") {
			const check = validateTaskCompletion(evidence);
			if (!check.ok) return check;
			task.completion_evidence = evidence;
		}
		task.status = status;
		task.updated_at = new Date().toISOString();
		if (status === "complete" || status === "failed") {
			task.owner = status === "complete" ? task.owner : null;
			task.leased_at = null;
			task.claim_token = null;
			// release the lease file so a failed task can be re-claimed
			await this.state.removeFileAudited(this.p(`claims/${taskId}.json`));
		}
		await this.writeTask(task, "task_transition");
		await this.event({ type: "task_transition", task_id: task.id, status });
		return { ok: true };
	}

	/** First task this worker may claim, or null. */
	async nextFor(worker: Worker): Promise<TeamTask | null> {
		return nextClaimable(await this.listTasks(), worker);
	}

	// ---- heartbeat / stale recovery -----------------------------------------

	async heartbeat(workerId: string, status = "busy"): Promise<void> {
		const m = await this.readManifest();
		if (!m) return;
		const w = m.workers.find((x) => x.id === workerId);
		if (!w) return;
		w.last_heartbeat = Date.now();
		w.status = status;
		await this.state.writeJsonAtomic(this.p("manifest.json"), m, {
			audit: { category: "log", verb: "heartbeat", skill: "team" },
		});
	}

	/** Requeue tasks held by stale/stopped workers. Returns requeued task ids. */
	async recoverStaleClaims(now = Date.now(), timeoutMs = HEARTBEAT_TIMEOUT_MS): Promise<string[]> {
		const m = await this.readManifest();
		if (!m) return [];
		const tasks = await this.listTasks();
		// Liveness comes from per-worker heartbeat files (written by the worker
		// runner loop), not the manifest's frozen create-time stamp. Fold the
		// freshest heartbeat into each worker before computing staleness.
		const workers = await Promise.all(
			m.workers.map(async (w) => {
				const hb = await this.state.readTokyoJson(this.p(`workers/${w.id}/heartbeat.json`));
				const ts = hb && hb.ok ? Number((hb.value as { ts?: unknown }).ts) : NaN;
				return Number.isFinite(ts) ? { ...w, last_heartbeat: ts } : w;
			}),
		);
		const stale = findStaleClaims(tasks, workers, now, timeoutMs);
		for (const id of stale) {
			const task = tasks.find((t) => t.id === id)!;
			task.status = "pending";
			task.owner = null;
			task.leased_at = null;
			task.claim_token = null;
			task.updated_at = new Date().toISOString();
			await this.writeTask(task, "task_requeue");
			// release the O_EXCL lease file so the requeued task can actually be
			// re-claimed (otherwise createJsonNoClobber EEXIST bricks it forever).
			await this.state.removeFileAudited(this.p(`claims/${id}.json`));
			await this.event({ type: "task_requeued", task_id: id, reason: "stale_claim" });
		}
		return stale;
	}

	// ---- mailbox -------------------------------------------------------------
	// The live mailbox path is deliver() -> inbox.jsonl (tailed by the worker runner)
	// and the worker's outbox.jsonl (read by the tokyo_team `replies` op). The old
	// per-seq sendMessage/readMailbox store was dead + clobber-prone and was removed.

	/** Append a message to a worker's durable inbox jsonl (the read path). */
	async deliver(toWorker: string, from: string, body: string): Promise<void> {
		await this.state.appendJsonl(this.p(`mailbox/${toWorker}/inbox.jsonl`), {
			from,
			body,
			ts: new Date().toISOString(),
		}, { audit: { category: "log", verb: "mailbox_deliver", skill: "team" } });
		await this.event({ type: "message_delivered", to: toWorker, from });
	}

	// ---- events --------------------------------------------------------------

	async event(payload: Record<string, unknown>): Promise<void> {
		await this.state.appendJsonl(this.p("events.jsonl"), { ts: new Date().toISOString(), ...payload });
	}

	async readEvents(): Promise<unknown[]> {
		return this.state.readJsonl(this.p("events.jsonl"));
	}
}
