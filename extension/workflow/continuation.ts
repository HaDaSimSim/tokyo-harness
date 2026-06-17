/**
 * Tokyo continuation-loop decision logic (pure: no fs, no pi API).
 *
 * The agent_end hook reads durable goal state and asks this module whether to
 * re-prompt the agent to keep working, and with what message. Termination is
 * driven by DURABLE STATE (goals settled), not by "the model stopped talking",
 * with two guards from the research (omx §6 / pi-capabilities §2):
 *   - signature dedup: if the same next-step signature repeats with no progress,
 *     stop (prevents spinning on a stuck goal);
 *   - hard iteration cap: an absolute ceiling so a pathological loop always ends.
 *
 * Only EXECUTE drives the loop. Other phases never auto-continue (interview/plan
 * are human-paced; verify/done are terminal-ish).
 */
import type { GoalsState, Phase } from "./index.ts";
import { allGoalsSettled, nextActiveGoal } from "./goals.ts";

export const MAX_CONTINUATION_ITERATIONS = 50;

export interface ContinuationState {
	/** How many times we've auto-continued this run. */
	iterations: number;
	/** Signature of the last step we re-prompted for (dedup guard). */
	lastSignature: string;
}

export function freshContinuationState(): ContinuationState {
	return { iterations: 0, lastSignature: "" };
}

export type ContinuationDecision =
	| { action: "stop"; reason: string }
	| { action: "continue"; prompt: string; signature: string };

/**
 * Decide whether to re-prompt. Pure: takes the current phase, goal state, and the
 * mutable continuation counters; returns a decision. The caller applies the
 * counter updates it returns implicitly (iterations++ and lastSignature set) only
 * when the action is "continue".
 */
export function decideContinuation(
	phase: Phase,
	goals: GoalsState,
	cont: ContinuationState,
	ledgerEventCount = 0,
): ContinuationDecision {
	if (phase !== "EXECUTE") {
		return { action: "stop", reason: `phase ${phase} does not auto-continue` };
	}
	if (cont.iterations >= MAX_CONTINUATION_ITERATIONS) {
		return { action: "stop", reason: `hit max continuation iterations (${MAX_CONTINUATION_ITERATIONS})` };
	}
	if (allGoalsSettled(goals)) {
		return { action: "stop", reason: "all goals settled" };
	}
	const next = nextActiveGoal(goals);
	if (!next) {
		return { action: "stop", reason: "no active goal to continue" };
	}
	// Progress signal = the durable ledger event count. A goal legitimately takes
	// many turns; we must NOT stop just because it isn't done yet. We only stop
	// when the ledger has not grown AT ALL since the last re-prompt (truly stuck).
	const remaining = goals.goals.filter((g) => g.status === "active").length;
	const signature = `ledger:${ledgerEventCount}`;
	if (cont.lastSignature !== "" && signature === cont.lastSignature) {
		return {
			action: "stop",
			reason: `no durable progress since last prompt (ledger unchanged at ${ledgerEventCount} events)`,
		};
	}
	const prompt = [
		`Continue executing the approved plan. ${remaining} goal(s) remain.`,
		`Current goal [${next.id}]: ${next.objective}`,
		`Implement it, then complete it with tokyo_complete and real evidence.`,
		``,
		`COMPLETION AUDIT (before calling tokyo_complete):`,
		`1. Restate the goal objective as concrete deliverables`,
		`2. For each deliverable, cite the specific evidence (test output, file:line, command result)`,
		`3. Verify the CURRENT state matches your claim (re-run the check, don't rely on memory)`,
		`4. Confirm verification scope matches claim scope (a unit test doesn't prove integration)`,
		`5. If ANY uncertainty remains, it is NOT yet complete — keep working`,
		``,
		`When all goals are settled, advance to VERIFY with tokyo_phase.`,
	].join("\n");
	return { action: "continue", prompt, signature };
}
