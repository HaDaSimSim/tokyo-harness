/**
 * Tokyo tool definitions: `tokyo_phase` and `tokyo_delegate`.
 *
 * Built as factories that take the runtime hooks they need (phase transition,
 * consent prompt) so this module stays free of module-level pi state; index.ts
 * wires them in and registers them via pi.registerTool.
 *
 * Delegation model (B): planner/architect/critic run as isolated read-only
 * subagents and return their artifact text. The MAIN thread performs the actual
 * edit/write in EXECUTE — subagents never mutate the repo. STEP 8 evolves this.
 */
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Phase } from "../workflow/index.ts";
import { getRoleAgent, roleAgentNames } from "./agents.ts";

// ---- tokyo_phase --------------------------------------------------------------

export interface PhaseToolHooks {
	/** Current phase. */
	getPhase: () => Phase;
	/**
	 * Attempt a transition. Returns the new phase on success, or an object
	 * describing why it was refused. Consent is handled inside (may prompt).
	 */
	requestTransition: (to: Phase, ctx: ExtensionContext) => Promise<{ ok: true; phase: Phase } | { ok: false; reason: string }>;
}

const PhaseParams = Type.Object({
	to: Type.String({
		description:
			"Target phase: INTERVIEW, RESEARCH, PLAN, EXECUTE, VERIFY, REVIEW, or DONE. Legal flow is IDLE→INTERVIEW⇄RESEARCH→PLAN→(consent)→EXECUTE⇄VERIFY→REVIEW→DONE. PLAN→EXECUTE and REVIEW→DONE require explicit user consent (the tool prompts).",
	}),
	rationale: Type.Optional(
		Type.String({ description: "One sentence on why this transition is warranted now (e.g. ambiguity resolved)." }),
	),
});

interface PhaseDetails {
	from: Phase;
	to: string;
	applied: boolean;
	reason?: string;
}

export function makePhaseTool(hooks: PhaseToolHooks): ToolDefinition<typeof PhaseParams, PhaseDetails> {
	return {
		name: "tokyo_phase",
		label: "Tokyo Phase",
		description:
			"Advance the tokyo workflow phase. Move yourself: INTERVIEW→RESEARCH (investigate a target / clone-coding) or INTERVIEW→PLAN once ambiguity is resolved; RESEARCH→PLAN when investigation is done; PLAN→EXECUTE once the user approves the plan (prompts for consent); EXECUTE→VERIFY when work is done (or EXECUTE→PLAN to re-plan); VERIFY→REVIEW once verification evidence is recorded (or VERIFY→EXECUTE to fix); REVIEW→DONE once the user accepts (prompts), or REVIEW→PLAN/EXECUTE/INTERVIEW to iterate on requested changes.",
		parameters: PhaseParams,
		promptGuidelines: [
			"Drive your own phase transitions with tokyo_phase rather than waiting to be told.",
			"You cannot enter EXECUTE without user consent; the tool prompts for it.",
		],
		async execute(_id, params, _signal, _onUpdate, ctx): Promise<AgentToolResult<PhaseDetails>> {
			const from = hooks.getPhase();
			const to = params.to.trim().toUpperCase();
			const result = await hooks.requestTransition(to as Phase, ctx);
			if (!result.ok) {
				return {
					content: [{ type: "text", text: `Phase transition refused: ${result.reason} (still in ${from}).` }],
					details: { from, to, applied: false, reason: result.reason },
				};
			}
			return {
				content: [{ type: "text", text: `Phase: ${from} → ${result.phase}.` }],
				details: { from, to: result.phase, applied: true },
			};
		},
	};
}
