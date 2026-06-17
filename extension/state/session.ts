/**
 * tokyo session state — persisted independently of pi session.
 *
 * Lives at .tokyo/sessions/current/state.json and survives pi session
 * compaction, restart, and new pi sessions. The pi session JSONL is only
 * for conversation history; tokyo owns its own state lifecycle.
 *
 * Written atomically via StateWriter on every state change. Read on startup
 * to restore phase/planMode/autoMode/cont without pi session dependency.
 */

import type { StateWriter } from "../state/index.ts";
import type { Phase, PlanMode } from "../workflow/index.ts";
import type { ContinuationState } from "../workflow/continuation.ts";

export interface TokyoSessionState {
	phase: Phase;
	planMode: PlanMode;
	autoMode: boolean;
	cont: ContinuationState;
	planRef?: string; // path to current plan file (e.g. plans/plan-xxx.md)
}

const STATE_PATH = "sessions/current/state.json";

export function freshSessionState(): TokyoSessionState {
	return {
		phase: "IDLE" as Phase,
		planMode: "consensus" as PlanMode,
		autoMode: false,
		cont: { iterations: 0, lastSignature: "" },
	};
}

export async function readSessionState(state: StateWriter): Promise<TokyoSessionState | null> {
	const res = await state.readTokyoJson(STATE_PATH);
	if (res?.ok && res.value) {
		const s = res.value as Partial<TokyoSessionState>;
		return {
			phase: (s.phase ?? "IDLE") as Phase,
			planMode: (s.planMode ?? "consensus") as PlanMode,
			autoMode: s.autoMode === true,
			cont: {
				iterations: typeof s.cont?.iterations === "number" ? s.cont.iterations : 0,
				lastSignature: typeof s.cont?.lastSignature === "string" ? s.cont.lastSignature : "",
			},
			planRef: s.planRef,
		};
	}
	return null;
}

export async function writeSessionState(state: StateWriter, session: TokyoSessionState): Promise<void> {
	await state.writeJsonAtomic(STATE_PATH, session, {
		audit: { category: "state", verb: "session_state_write", skill: "system" },
	});
}
