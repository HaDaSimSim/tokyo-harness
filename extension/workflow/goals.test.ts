/**
 * Unit tests for the goal ledger + evidence-gated completion guard.
 * Run: bun test
 */
import { describe, expect, test } from "bun:test";
import {
	allGoalsSettled,
	buildReceipt,
	type EvidenceItem,
	type Goal,
	type GoalsState,
	emptyGoalsState,
	nextActiveGoal,
	receiptContentSha256,
	validateReceipt,
} from "./goals.ts";

function goal(id: string, status: Goal["status"] = "active"): Goal {
	return { id, objective: `obj ${id}`, status, created_at: "t", updated_at: "t" };
}

const passing: EvidenceItem[] = [{ kind: "command", status: "passed", detail: "bun test" }];

describe("receipt building + hashing", () => {
	test("buildReceipt stamps a content hash over the binding fields", () => {
		const g = goal("a");
		const r = buildReceipt(g, passing);
		expect(r.content_sha256).toBe(receiptContentSha256("a", "obj a", passing));
	});

	test("hash is stable regardless of evidence object key order", () => {
		const e1: EvidenceItem[] = [{ kind: "command", status: "passed", detail: "x" }];
		const e2: EvidenceItem[] = [{ detail: "x", status: "passed", kind: "command" } as EvidenceItem];
		expect(receiptContentSha256("a", "o", e1)).toBe(receiptContentSha256("a", "o", e2));
	});
});

describe("evidence-gated completion guard", () => {
	const g = goal("a");

	test("accepts a valid receipt with ≥1 passed item", () => {
		expect(validateReceipt(g, buildReceipt(g, passing)).ok).toBe(true);
	});

	test("accepts verified evidence too", () => {
		expect(validateReceipt(g, buildReceipt(g, [{ kind: "inspection", status: "verified", detail: "read output" }])).ok).toBe(true);
	});

	test("rejects empty evidence", () => {
		const r = validateReceipt(g, buildReceipt(g, []));
		expect(r.ok).toBe(false);
		expect(r.reason).toContain("no evidence");
	});

	test("rejects a todo item (work not finished)", () => {
		const r = validateReceipt(g, buildReceipt(g, [{ kind: "command", status: "todo", detail: "later" }]));
		expect(r.ok).toBe(false);
		expect(r.reason).toContain("todo");
	});

	test("rejects a failed item", () => {
		const r = validateReceipt(g, buildReceipt(g, [
			{ kind: "command", status: "passed", detail: "a" },
			{ kind: "command", status: "failed", detail: "b" },
		]));
		expect(r.ok).toBe(false);
		expect(r.reason).toContain("failed");
	});

	test("rejects evidence with no passed/verified item", () => {
		// all items are non-failed, non-todo, but also none passed/verified is impossible
		// given the status union; simulate by tampering after build:
		const receipt = buildReceipt(g, passing);
		receipt.evidence = [{ kind: "command", status: "todo", detail: "x" }];
		// hash now mismatches AND no passed item — guard should reject
		expect(validateReceipt(g, receipt).ok).toBe(false);
	});

	test("rejects a tampered receipt (hash mismatch)", () => {
		const receipt = buildReceipt(g, passing);
		receipt.objective = "something else"; // tamper after stamping
		const r = validateReceipt(g, receipt);
		expect(r.ok).toBe(false);
		expect(r.reason).toContain("hash mismatch");
	});

	test("rejects a receipt whose goal_id does not match", () => {
		const receipt = buildReceipt(goal("b"), passing);
		expect(validateReceipt(g, receipt).ok).toBe(false);
	});
});

describe("ledger queries", () => {
	test("nextActiveGoal returns the first active goal", () => {
		const s: GoalsState = { goals: [goal("a", "complete"), goal("b"), goal("c")], current_goal_id: null };
		expect(nextActiveGoal(s)?.id).toBe("b");
	});

	test("nextActiveGoal returns null when none active", () => {
		const s: GoalsState = { goals: [goal("a", "complete"), goal("b", "dropped")], current_goal_id: null };
		expect(nextActiveGoal(s)).toBeNull();
	});

	test("allGoalsSettled is false with an active goal", () => {
		expect(allGoalsSettled({ goals: [goal("a"), goal("b", "complete")], current_goal_id: "a" })).toBe(false);
	});

	test("allGoalsSettled is true when every goal is complete/dropped", () => {
		expect(allGoalsSettled({ goals: [goal("a", "complete"), goal("b", "dropped")], current_goal_id: null })).toBe(true);
	});

	test("allGoalsSettled is false for an empty ledger", () => {
		expect(allGoalsSettled(emptyGoalsState())).toBe(false);
	});
});
