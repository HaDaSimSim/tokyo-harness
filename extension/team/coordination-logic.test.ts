/**
 * Unit tests for the pure team coordination logic (claim gate, stale recovery,
 * evidence-gated task completion).
 * Run: bun test
 */
import { describe, expect, test } from "bun:test";
import {
	allTasksComplete,
	canClaim,
	findStaleClaims,
	isStale,
	nextClaimable,
	type TaskEvidence,
	type TeamTask,
	validateTaskCompletion,
	type Worker,
} from "./coordination-logic.ts";

function task(id: string, over: Partial<TeamTask> = {}): TeamTask {
	return {
		id,
		objective: `obj ${id}`,
		status: "pending",
		owner: null,
		depends_on: [],
		leased_at: null,
		created_at: "t",
		updated_at: "t",
		...over,
	};
}
function worker(id: string, over: Partial<Worker> = {}): Worker {
	return { id, status: "idle", last_heartbeat: Date.now(), ...over };
}

describe("claim gate ordering", () => {
	test("can claim a free pending task", () => {
		expect(canClaim(task("a"), worker("w1"), [task("a")]).ok).toBe(true);
	});

	test("cannot claim a task owned by someone else", () => {
		const t = task("a", { status: "claimed", owner: "w2" });
		expect(canClaim(t, worker("w1"), [t]).ok).toBe(false);
	});

	test("cannot claim a complete task", () => {
		const t = task("a", { status: "complete" });
		expect(canClaim(t, worker("w1"), [t]).ok).toBe(false);
	});

	test("role gate blocks a mismatched worker", () => {
		const t = task("a", { required_role: "backend" });
		const r = canClaim(t, worker("w1", { role: "frontend" }), [t]);
		expect(r.ok).toBe(false);
		expect(r.reason).toContain("role");
	});

	test("role gate allows a matching worker", () => {
		const t = task("a", { required_role: "backend" });
		expect(canClaim(t, worker("w1", { role: "backend" }), [t]).ok).toBe(true);
	});

	test("role gate blocks an unroled worker from a role-required task", () => {
		const t = task("a", { required_role: "backend" });
		const r = canClaim(t, worker("w1"), [t]); // no role
		expect(r.ok).toBe(false);
		expect(r.reason).toContain("role");
	});

	test("dependency gate blocks until deps complete", () => {
		const dep = task("d1");
		const t = task("a", { depends_on: ["d1"] });
		expect(canClaim(t, worker("w1"), [t, dep]).ok).toBe(false);
		dep.status = "complete";
		expect(canClaim(t, worker("w1"), [t, dep]).ok).toBe(true);
	});

	test("missing task is unclaimable", () => {
		expect(canClaim(undefined, worker("w1"), []).ok).toBe(false);
	});
});

describe("stale detection + recovery", () => {
	test("isStale respects the timeout", () => {
		const now = 1_000_000;
		expect(isStale(worker("w", { last_heartbeat: now - 70_000 }), now, 60_000)).toBe(true);
		expect(isStale(worker("w", { last_heartbeat: now - 10_000 }), now, 60_000)).toBe(false);
	});

	test("findStaleClaims requeues tasks of stale owners", () => {
		const now = 1_000_000;
		const w = worker("w1", { last_heartbeat: now - 90_000 });
		const t = task("a", { status: "in_progress", owner: "w1" });
		expect(findStaleClaims([t], [w], now, 60_000)).toEqual(["a"]);
	});

	test("findStaleClaims requeues tasks of stopped workers", () => {
		const now = 1_000_000;
		const w = worker("w1", { status: "stopped", last_heartbeat: now });
		const t = task("a", { status: "claimed", owner: "w1" });
		expect(findStaleClaims([t], [w], now, 60_000)).toEqual(["a"]);
	});

	test("fresh heartbeat keeps the claim", () => {
		const now = 1_000_000;
		const w = worker("w1", { status: "busy", last_heartbeat: now - 5_000 });
		const t = task("a", { status: "in_progress", owner: "w1" });
		expect(findStaleClaims([t], [w], now, 60_000)).toEqual([]);
	});
});

describe("evidence-gated task completion", () => {
	const ok: TaskEvidence[] = [{ kind: "command", status: "passed", detail: "tests" }];
	test("accepts passed/verified evidence", () => {
		expect(validateTaskCompletion(ok).ok).toBe(true);
	});
	test("rejects empty", () => {
		expect(validateTaskCompletion([]).ok).toBe(false);
	});
	test("rejects todo/failed", () => {
		expect(validateTaskCompletion([{ kind: "command", status: "todo", detail: "x" }]).ok).toBe(false);
		expect(validateTaskCompletion([{ kind: "command", status: "failed", detail: "x" }]).ok).toBe(false);
	});
});

describe("scheduling helpers", () => {
	test("nextClaimable picks the first eligible pending task", () => {
		const tasks = [
			task("a", { status: "complete" }),
			task("b", { depends_on: ["a"] }),
			task("c"),
		];
		expect(nextClaimable(tasks, worker("w1"))?.id).toBe("b");
	});

	test("allTasksComplete only true when every task is complete", () => {
		expect(allTasksComplete([task("a", { status: "complete" })])).toBe(true);
		expect(allTasksComplete([task("a", { status: "complete" }), task("b")])).toBe(false);
		expect(allTasksComplete([])).toBe(false);
	});
});
