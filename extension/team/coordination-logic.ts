/**
 * Tokyo team coordination — pure data-plane logic (no fs, no pi API).
 *
 * Ported in spirit from GJC team-runtime (gjc-workflow §6): file-based lease +
 * heartbeat coordination with no central broker. This module owns the PURE
 * decision logic (claim gate ordering, stale detection, evidence-gated task
 * completion); the fs-backed runtime (coordination.ts) persists it via StateWriter.
 *
 * Layout (written by the runtime under .tokyo/team/<team>/):
 *   config.json, manifest.json, phase.json,
 *   events.jsonl (append-only),
 *   tasks/task-<id>.json,
 *   workers/<id>/{status,heartbeat}.json,
 *   mailbox/<id>/<seq>.json
 */

export type TaskStatus = "pending" | "claimed" | "in_progress" | "complete" | "failed" | "blocked";

export interface TeamTask {
	id: string;
	objective: string;
	status: TaskStatus;
	/** Worker id that holds the lease, if claimed. */
	owner: string | null;
	/** Role required to claim (optional gate). */
	required_role?: string;
	/** Task ids that must be complete before this can be claimed. */
	depends_on: string[];
	/** Lease timestamp (ms) when claimed; used for stale detection. */
	leased_at: number | null;
	/** Claim token (set on O_EXCL lease); required to transition a leased task. */
	claim_token?: string | null;
	created_at: string;
	updated_at: string;
	completion_evidence?: TaskEvidence[];
}

export interface TaskEvidence {
	kind: "command" | "inspection" | "artifact";
	status: "passed" | "verified" | "failed" | "todo";
	detail: string;
}

export interface Worker {
	id: string;
	role?: string;
	/** "starting" | "idle" | "busy" | "stopped". */
	status: string;
	last_heartbeat: number;
}

export interface ClaimResult {
	ok: boolean;
	reason?: string;
}

/**
 * The ordered claim gate (GJC's lease-based ordered claim). A claim must pass,
 * in order: existence → not terminal/owned → role match → dependencies satisfied.
 * Pure: returns whether the claim is allowed; the runtime then writes the lease.
 */
export function canClaim(task: TeamTask | undefined, worker: Worker, allTasks: TeamTask[]): ClaimResult {
	if (!task) return { ok: false, reason: "task not found" };
	if (task.status === "complete") return { ok: false, reason: "task already complete" };
	if (task.status === "failed") return { ok: false, reason: "task failed; requeue first" };
	if (task.owner && task.owner !== worker.id) return { ok: false, reason: `task owned by ${task.owner}` };
	if (task.status === "in_progress" && task.owner === worker.id) {
		return { ok: false, reason: "already in progress by you" };
	}
	if (task.required_role && task.required_role !== worker.role) {
		return { ok: false, reason: `requires role ${task.required_role}, worker is ${worker.role ?? "unroled"}` };
	}
	const unmet = task.depends_on.filter((depId) => {
		const dep = allTasks.find((t) => t.id === depId);
		return !dep || dep.status !== "complete";
	});
	if (unmet.length > 0) return { ok: false, reason: `blocked on dependencies: ${unmet.join(", ")}` };
	return { ok: true };
}

/** A heartbeat is stale if older than the timeout (ms). */
export function isStale(worker: Worker, now: number, timeoutMs: number): boolean {
	return now - worker.last_heartbeat > timeoutMs;
}

/**
 * Find tasks whose owner has a stale heartbeat (or is stopped) and should be
 * requeued. Returns the task ids to reset to pending. Pure.
 */
export function findStaleClaims(
	tasks: TeamTask[],
	workers: Worker[],
	now: number,
	timeoutMs: number,
): string[] {
	const out: string[] = [];
	for (const task of tasks) {
		if ((task.status !== "claimed" && task.status !== "in_progress") || !task.owner) continue;
		const owner = workers.find((w) => w.id === task.owner);
		if (!owner || owner.status === "stopped" || isStale(owner, now, timeoutMs)) {
			out.push(task.id);
		}
	}
	return out;
}

/**
 * Evidence-gated task completion (mirrors goal completion): need a summary +
 * ≥1 passed/verified item; no todo/failed. Pure validation.
 */
export function validateTaskCompletion(evidence: TaskEvidence[] | undefined): ClaimResult {
	if (!evidence || evidence.length === 0) return { ok: false, reason: "no completion evidence" };
	if (evidence.some((e) => e.status === "todo")) return { ok: false, reason: "evidence contains a todo item" };
	if (evidence.some((e) => e.status === "failed")) return { ok: false, reason: "evidence contains a failed item" };
	if (!evidence.some((e) => e.status === "passed" || e.status === "verified")) {
		return { ok: false, reason: "no passed/verified evidence" };
	}
	return { ok: true };
}

/** Next claimable task for a worker (first pending whose deps are met + role fits). */
export function nextClaimable(tasks: TeamTask[], worker: Worker): TeamTask | null {
	for (const task of tasks) {
		if (task.status !== "pending") continue;
		if (canClaim(task, worker, tasks).ok) return task;
	}
	return null;
}

/** Are all tasks terminal (complete or dropped/failed-acknowledged)? */
export function allTasksComplete(tasks: TeamTask[]): boolean {
	return tasks.length > 0 && tasks.every((t) => t.status === "complete");
}
