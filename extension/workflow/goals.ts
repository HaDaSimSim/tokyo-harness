/**
 * Tokyo goal ledger types + evidence/receipt validation (pure: no fs, no pi API).
 *
 * Ported in spirit from GJC ultragoal (gjc-workflow §4-5): a durable goal ledger
 * where completion is EVIDENCE-GATED and hash-bound, so "done" cannot be forged.
 *
 * A goal can only be completed with:
 *   - a completion receipt carrying ≥1 passed/verified evidence item
 *     (kind: command | inspection | artifact), and
 *   - a content hash binding the receipt to the goal snapshot, and
 *   - a matching `goal_checkpointed` event appended to the ledger.
 *
 * This module owns the shapes + the guard logic; the tool (state-tools side)
 * does the fs writes through the StateWriter and calls validateReceipt here.
 */
import { createHash } from "node:crypto";

export type GoalStatus = "active" | "complete" | "dropped";

export interface Goal {
	id: string;
	objective: string;
	status: GoalStatus;
	created_at: string;
	updated_at: string;
	/** sha256 of the completion receipt, set when completed. */
	receipt_sha256?: string;
}

export interface GoalsState {
	goals: Goal[];
	/** id of the goal currently being worked, if any. */
	current_goal_id: string | null;
}

export type EvidenceKind = "command" | "inspection" | "artifact";
export type EvidenceStatus = "passed" | "verified" | "failed" | "todo";

export interface EvidenceItem {
	kind: EvidenceKind;
	status: EvidenceStatus;
	/** What was checked (a command, a file path, an inspection note). */
	detail: string;
}

export interface CompletionReceipt {
	goal_id: string;
	objective: string;
	verified_at: string;
	evidence: EvidenceItem[];
	/** sha256 over the canonicalized {goal_id, objective, evidence}. */
	content_sha256: string;
	/** UUID of the goal_checkpointed ledger event this receipt is bound to. */
	checkpoint_ledger_event_id?: string;
}

/** A ledger event as appended to events.jsonl. */
export interface LedgerEvent {
	ts: string;
	type: string;
	eventId?: string;
	goal_id?: string;
	status?: string;
	receipt_sha256?: string;
	[k: string]: unknown;
}

// ---- helpers ------------------------------------------------------------------

export function emptyGoalsState(): GoalsState {
	return { goals: [], current_goal_id: null };
}

function canonical(value: unknown): string {
	const norm = (v: unknown): unknown => {
		if (v === null || typeof v !== "object") return v;
		if (Array.isArray(v)) return v.map(norm);
		const o: Record<string, unknown> = {};
		for (const k of Object.keys(v as Record<string, unknown>).sort()) {
			const val = (v as Record<string, unknown>)[k];
			if (val !== undefined) o[k] = norm(val);
		}
		return o;
	};
	return JSON.stringify(norm(value));
}

/** Compute the receipt content hash over the binding fields (excludes the hash itself). */
export function receiptContentSha256(goalId: string, objective: string, evidence: EvidenceItem[]): string {
	return createHash("sha256").update(canonical({ goal_id: goalId, objective, evidence }), "utf8").digest("hex");
}

export function buildReceipt(goal: Goal, evidence: EvidenceItem[]): CompletionReceipt {
	const content_sha256 = receiptContentSha256(goal.id, goal.objective, evidence);
	return {
		goal_id: goal.id,
		objective: goal.objective,
		verified_at: new Date().toISOString(),
		evidence,
		content_sha256,
	};
}

export interface ReceiptValidation {
	ok: boolean;
	reason?: string;
}

/**
 * The completion guard. Enforces, in order:
 *   1. there is at least one evidence item;
 *   2. no evidence item is `todo` (no unfinished work claimed as done);
 *   3. at least one item is `passed` or `verified`;
 *   4. no item is `failed`;
 *   5. the receipt's content hash recomputes correctly (tamper-evidence).
 * Mirrors GJC's "no vibes — completion is a validated, hash-bound assertion".
 */
export function validateReceipt(goal: Goal, receipt: CompletionReceipt): ReceiptValidation {
	if (receipt.goal_id !== goal.id) return { ok: false, reason: "receipt goal_id does not match the goal" };
	if (!Array.isArray(receipt.evidence) || receipt.evidence.length === 0) {
		return { ok: false, reason: "no evidence provided (need ≥1 passed/verified item)" };
	}
	if (receipt.evidence.some((e) => e.status === "todo")) {
		return { ok: false, reason: "evidence contains a 'todo' item — work is not finished" };
	}
	if (receipt.evidence.some((e) => e.status === "failed")) {
		return { ok: false, reason: "evidence contains a 'failed' item — fix it before completing" };
	}
	if (!receipt.evidence.some((e) => e.status === "passed" || e.status === "verified")) {
		return { ok: false, reason: "no passed/verified evidence item" };
	}
	const recomputed = receiptContentSha256(receipt.goal_id, receipt.objective, receipt.evidence);
	if (recomputed !== receipt.content_sha256) {
		return { ok: false, reason: "receipt content hash mismatch (tampered or malformed)" };
	}
	return { ok: true };
}

/** Are all goals complete or dropped? (drives the continuation-loop termination.) */
export function allGoalsSettled(state: GoalsState): boolean {
	return state.goals.length > 0 && state.goals.every((g) => g.status !== "active");
}

/** The next active goal to work, or null. */
export function nextActiveGoal(state: GoalsState): Goal | null {
	return state.goals.find((g) => g.status === "active") ?? null;
}

/**
 * Re-validate a completion FROM DISK (the real tamper/replay guard, fixing the
 * CR1 tautology + CR2 missing ledger match). The caller re-reads goals.json and
 * events.jsonl from disk after the write and passes them here. We check, against
 * independent durable state:
 *   1. the goal is marked complete and carries a receipt hash;
 *   2. a goal_checkpointed ledger event exists with matching goal_id + status
 *      "complete" + the same receipt hash AND a matching eventId binding;
 *   3. the receipt hash recomputes from the goal's own objective + the event's
 *      evidence (so a forged goals.json can't claim a hash the evidence doesn't
 *      produce).
 * Returns ok only when the on-disk goal, the on-disk ledger event, and the
 * recomputed hash all agree.
 */
export function verifyCompletionFromDisk(
	goalId: string,
	diskGoals: GoalsState,
	diskEvents: LedgerEvent[],
): ReceiptValidation {
	const goal = diskGoals.goals.find((g) => g.id === goalId);
	if (!goal) return { ok: false, reason: "goal not found on disk after write" };
	if (goal.status !== "complete") return { ok: false, reason: `goal status on disk is ${goal.status}, not complete` };
	if (!goal.receipt_sha256) return { ok: false, reason: "goal on disk has no receipt hash" };

	const events = diskEvents.filter(
		(e) => e.type === "goal_checkpointed" && e.goal_id === goalId && e.status === "complete",
	);
	if (events.length === 0) return { ok: false, reason: "no matching goal_checkpointed ledger event on disk" };
	// bind to the event carrying the same receipt hash
	const match = events.find((e) => e.receipt_sha256 === goal.receipt_sha256);
	if (!match) return { ok: false, reason: "no ledger event matches the goal's receipt hash" };
	if (!match.eventId) return { ok: false, reason: "matching ledger event has no eventId binding" };

	// recompute the hash from the goal's objective + the event's recorded evidence
	const evidence = (match.evidence as EvidenceItem[] | undefined) ?? [];
	const shape = validateReceipt(goal, {
		goal_id: goalId,
		objective: goal.objective,
		verified_at: match.ts,
		evidence,
		content_sha256: goal.receipt_sha256,
	});
	if (!shape.ok) return { ok: false, reason: `disk evidence fails the gate: ${shape.reason}` };
	const recomputed = receiptContentSha256(goalId, goal.objective, evidence);
	if (recomputed !== goal.receipt_sha256) {
		return { ok: false, reason: "receipt hash does not recompute from on-disk evidence (forged or mismatched)" };
	}
	return { ok: true };
}
