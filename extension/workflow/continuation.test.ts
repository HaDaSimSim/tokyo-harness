/**
 * Unit tests for the continuation-loop decision logic.
 * Run: bun test
 */
import { describe, expect, test } from "bun:test";
import {
	decideContinuation,
	freshContinuationState,
	MAX_CONTINUATION_ITERATIONS,
} from "./continuation.ts";
import type { Goal, GoalsState } from "./goals.ts";

function g(id: string, status: Goal["status"] = "active"): Goal {
	return { id, objective: `obj ${id}`, status, created_at: "t", updated_at: "t" };
}
function state(goals: Goal[]): GoalsState {
	return { goals, current_goal_id: goals.find((x) => x.status === "active")?.id ?? null };
}

describe("decideContinuation", () => {
	test("only EXECUTE continues", () => {
		const s = state([g("a")]);
		for (const phase of ["IDLE", "INTERVIEW", "PLAN", "VERIFY", "DONE"] as const) {
			expect(decideContinuation(phase, s, freshContinuationState()).action).toBe("stop");
		}
	});

	test("continues in EXECUTE with an active goal", () => {
		const d = decideContinuation("EXECUTE", state([g("a")]), freshContinuationState(), 1);
		expect(d.action).toBe("continue");
		if (d.action === "continue") {
			expect(d.prompt).toContain("a");
			expect(d.signature).toBe("ledger:1");
		}
	});

	test("stops when all goals settled", () => {
		const d = decideContinuation("EXECUTE", state([g("a", "complete"), g("b", "dropped")]), freshContinuationState(), 5);
		expect(d.action).toBe("stop");
		if (d.action === "stop") expect(d.reason).toContain("settled");
	});

	test("stops when the ledger did NOT grow since last prompt (truly stuck)", () => {
		const s = state([g("a"), g("b")]);
		// last prompt recorded ledger:3; this turn the ledger is still 3 → no progress
		const cont = { iterations: 1, lastSignature: "ledger:3" };
		const d = decideContinuation("EXECUTE", s, cont, 3);
		expect(d.action).toBe("stop");
		if (d.action === "stop") expect(d.reason).toContain("no durable progress");
	});

	test("CONTINUES on a multi-turn goal as long as the ledger grew (the CR8 fix)", () => {
		const s = state([g("a"), g("b")]); // same goals, none completed yet
		// last prompt recorded ledger:3; this turn the ledger is 4 (e.g. a sub-event
		// was appended) → progress was made, keep going even though no goal settled
		const cont = { iterations: 1, lastSignature: "ledger:3" };
		const d = decideContinuation("EXECUTE", s, cont, 4);
		expect(d.action).toBe("continue");
		if (d.action === "continue") expect(d.signature).toBe("ledger:4");
	});

	test("first continuation never trips the dedup guard (empty lastSignature)", () => {
		const d = decideContinuation("EXECUTE", state([g("a")]), freshContinuationState(), 0);
		expect(d.action).toBe("continue");
	});

	test("stops at the hard iteration cap", () => {
		const cont = { iterations: MAX_CONTINUATION_ITERATIONS, lastSignature: "" };
		const d = decideContinuation("EXECUTE", state([g("a")]), cont, 99);
		expect(d.action).toBe("stop");
		if (d.action === "stop") expect(d.reason).toContain("max continuation");
	});

	test("stops on an empty ledger (no active goal)", () => {
		const d = decideContinuation("EXECUTE", { goals: [], current_goal_id: null }, freshContinuationState());
		expect(d.action).toBe("stop");
	});
});
