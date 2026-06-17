/**
 * tokyo_ambiguity tool — the numeric clarity gate for the INTERVIEW phase.
 *
 * The model scores the interview transcript across dimensions (0..1) and calls
 * this tool. The tool computes ambiguity with the locked GJC weighting, compares
 * against the active threshold profile, reports a progress table, and — when the
 * gate clears — auto-advances INTERVIEW→PLAN so the model flows on without a
 * manual phase call.
 *
 * Factory style (like the other tokyo tools): index.ts injects the runtime hooks.
 */
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { StateWriter } from "../state/index.ts";
import {
	type DimensionScores,
	evaluateClarity,
	type Phase,
	type ProfileName,
	type ProjectKind,
	renderProgress,
	resolveThreshold,
} from "../workflow/index.ts";

export interface AmbiguityHooks {
	getPhase: () => Phase;
	/** Project root + dot-dir for threshold resolution. */
	cwd: () => string;
	dotDir: string;
	/** Per-run profile override (set by the interview skill flag), if any. */
	runProfile: () => ProfileName | undefined;
	/** Advance INTERVIEW→PLAN when clarity clears (no consent needed for this edge). */
	advanceToPlan: (_ctx: ExtensionContext) => Promise<boolean>;
	/** StateWriter for persisting interview progress to disk. */
	state: StateWriter;
}

const AmbiguityParams = Type.Object({
	kind: Type.Union([Type.Literal("greenfield"), Type.Literal("brownfield")], {
		description: "greenfield (new project) or brownfield (modifying existing code). Brownfield adds a context dimension.",
	}),
	goal: Type.Number({ description: "Goal clarity 0..1: is the primary objective unambiguous and stateable in one sentence?" }),
	constraints: Type.Number({ description: "Constraint clarity 0..1: are boundaries, limits, and non-goals clear?" }),
	criteria: Type.Number({ description: "Success-criteria clarity 0..1: could you write a test that verifies success?" }),
	context: Type.Optional(
		Type.Number({ description: "Context clarity 0..1 (brownfield only): do we understand the existing system well enough to modify it safely?" }),
	),
	components: Type.Optional(
		Type.Array(
			Type.Object({
				name: Type.String({ description: "Component name (e.g. 'auth', 'API', 'database')." }),
				goal: Type.Number(),
				constraints: Type.Number(),
				criteria: Type.Number(),
				context: Type.Optional(Type.Number()),
			}),
			{ description: "Topology locking: per-component scores. When provided, ALL components must clear threshold independently. Prevents one well-understood component from hiding ambiguity in another." },
		),
	),
	rationale: Type.Optional(Type.String({ description: "One sentence justifying the scores / naming the biggest remaining gap." })),
});

interface AmbiguityDetails {
	kind: ProjectKind;
	ambiguity: number;
	threshold: number;
	profile: ProfileName;
	clear: boolean;
	weakestDimension: string;
	advanced: boolean;
}

export function makeAmbiguityTool(hooks: AmbiguityHooks): ToolDefinition<typeof AmbiguityParams, AmbiguityDetails> {
	return {
		name: "tokyo_ambiguity",
		label: "Tokyo Ambiguity",
		description: [
			"Score the interview's clarity and gate progression to planning.",
			"Call this after each interview answer with your 0..1 scores for each dimension.",
			"It computes a weighted ambiguity, compares it to the active threshold profile,",
			"and auto-advances to PLAN once ambiguity ≤ threshold. While above threshold, keep interviewing the weakest dimension it reports.",
		].join(" "),
		parameters: AmbiguityParams,
		promptGuidelines: [
			"In INTERVIEW, score clarity with tokyo_ambiguity after each answer instead of guessing when to move on.",
			"Do not advance to PLAN yourself in INTERVIEW; let tokyo_ambiguity gate it numerically.",
		],
		async execute(_id, params, _signal, _onUpdate, ctx): Promise<AgentToolResult<AmbiguityDetails>> {
			const phase = hooks.getPhase();
			const resolved = resolveThreshold(hooks.cwd(), hooks.dotDir, hooks.runProfile());
			const scores: DimensionScores = {
				goal: params.goal,
				constraints: params.constraints,
				criteria: params.criteria,
				context: params.context,
			};
			const kind = params.kind as ProjectKind;

			// TOPOLOGY LOCKING: if components provided, evaluate each independently.
			// ALL components must clear threshold; aggregate score is the worst component.
			let topologyNote = "";
			if (params.components && params.components.length > 0) {
				const componentResults = params.components.map((c) => {
					const cScores: DimensionScores = { goal: c.goal, constraints: c.constraints, criteria: c.criteria, context: c.context };
					const cGate = evaluateClarity(kind, cScores, resolved.threshold);
					return { name: c.name, gate: cGate, scores: cScores };
				});
				const blocked = componentResults.filter((c) => !c.gate.clear);
				const lines = componentResults.map((c) =>
					`  ${c.gate.clear ? "\u2705" : "\u274c"} ${c.name}: ${(c.gate.ambiguity * 100).toFixed(1)}% (weakest: ${c.gate.weakestDimension})`,
				);
				topologyNote = `\n\nTOPOLOGY (${componentResults.length} components, ${blocked.length} blocked):\n${lines.join("\n")}`;
				if (blocked.length > 0) {
					// Override: don't clear even if aggregate is fine
					const worstComponent = blocked.sort((a, b) => b.gate.ambiguity - a.gate.ambiguity)[0];
					const header = `Threshold: ${(resolved.threshold * 100).toFixed(0)}% (profile: ${resolved.profile}, source: ${resolved.source})`;
					const table = renderProgress(kind, scores, { ...evaluateClarity(kind, scores, resolved.threshold), clear: false });

					// Persist interview state
					try {
						await hooks.state.writeJsonAtomic("specs/interview-state.json", {
							ts: new Date().toISOString(), kind, scores, ambiguity: worstComponent.gate.ambiguity,
							threshold: resolved.threshold, profile: resolved.profile, clear: false,
							weakestDimension: `${worstComponent.name}/${worstComponent.gate.weakestDimension}`,
							rationale: params.rationale ?? "", components: params.components.map((c) => c.name),
						}, { audit: { category: "state", verb: "interview_progress", skill: "interview" } });
					} catch { /* best-effort */ }

					return {
						content: [{ type: "text", text: `${header}\n\n${table}${topologyNote}\n\nBLOCKED by topology: ${blocked.map((b) => b.name).join(", ")}. Focus on ${worstComponent.name} (${worstComponent.gate.weakestDimension}).` }],
						details: { kind, ambiguity: worstComponent.gate.ambiguity, threshold: resolved.threshold, profile: resolved.profile, clear: false, weakestDimension: `${worstComponent.name}/${worstComponent.gate.weakestDimension}`, advanced: false },
					};
				}
			}

			const gate = evaluateClarity(kind, scores, resolved.threshold);
			const table = renderProgress(kind, scores, gate);

			let advanceNote = "";
			if (gate.clear) {
				if (phase === "INTERVIEW") {
					// Don't auto-advance — let the model decide PLAN vs RESEARCH
					advanceNote = "\n\n✅ Clarity threshold met. Now decide:\n" +
						"- If this task needs codebase/reference investigation: advance to RESEARCH with tokyo_phase.\n" +
						"- If you have enough context to plan: advance to PLAN with tokyo_phase.\n" +
						"Save the spec first with tokyo_spec_save before advancing.";
				} else {
					advanceNote = `\n\n(Clarity met, but phase is ${phase}, not INTERVIEW.)`;
				}
			}

			const header = `Threshold: ${(resolved.threshold * 100).toFixed(0)}% (profile: ${resolved.profile}, source: ${resolved.source})`;

			// Persist interview state for compaction survival
			try {
				// Ontology tracking: extract entities from rationale for stability measurement
				const rationale = params.rationale ?? "";
				const currentEntities = extractEntities(rationale);
				let prevState: { entities?: string[][]; stabilityRatio?: number } = {};
				try {
					const prev = await hooks.state.readTokyoJson("specs/interview-state.json");
					if (prev?.ok && prev.value) prevState = prev.value as typeof prevState;
				} catch { /* first round */ }
				const entityHistory = [...(prevState.entities ?? []), currentEntities];
				const stabilityRatio = entityHistory.length >= 2
					? computeStability(entityHistory[entityHistory.length - 2], currentEntities)
					: 1.0;

				const interviewState = {
					ts: new Date().toISOString(),
					kind,
					scores,
					ambiguity: gate.ambiguity,
					threshold: resolved.threshold,
					profile: resolved.profile,
					clear: gate.clear,
					weakestDimension: gate.weakestDimension,
					rationale,
					entities: entityHistory,
					stabilityRatio,
				};
				await hooks.state.writeJsonAtomic("specs/interview-state.json", interviewState, {
					audit: { category: "state", verb: "interview_progress", skill: "interview" },
				});
			} catch { /* best-effort */ }

			// Ontology stability warning
			let ontologyNote = "";
			try {
				const prev = await hooks.state.readTokyoJson("specs/interview-state.json");
				if (prev?.ok && prev.value) {
					const st = (prev.value as { stabilityRatio?: number }).stabilityRatio;
					if (typeof st === "number" && st < 0.5) {
						ontologyNote = `\n\n⚠️ ONTOLOGY UNSTABLE (stability: ${(st * 100).toFixed(0)}%). Key concepts are still shifting between rounds — the spec is not converging. Ask clarifying questions to stabilize the terminology before advancing.`;
					}
				}
			} catch { /* no prior state */ }

			return {
				content: [{ type: "text", text: `${header}\n\n${table}${topologyNote}${ontologyNote}${advanceNote}` }],
				details: {
					kind,
					ambiguity: gate.ambiguity,
					threshold: resolved.threshold,
					profile: resolved.profile,
					clear: gate.clear,
					weakestDimension: gate.weakestDimension,
					advanced: false,
				},
			};
		},
	};
}

/**
 * Extract entity-like terms from a rationale string.
 * Simple heuristic: capitalized words, quoted terms, and backtick-wrapped identifiers.
 */
function extractEntities(rationale: string): string[] {
	const entities = new Set<string>();
	// Backtick-wrapped identifiers
	for (const m of rationale.matchAll(/`([^`]+)`/g)) {
		entities.add(m[1].toLowerCase());
	}
	// Quoted terms
	for (const m of rationale.matchAll(/["']([^"']+)["']/g)) {
		if (m[1].length > 2 && m[1].length < 40) entities.add(m[1].toLowerCase());
	}
	// Capitalized multi-word phrases (likely proper nouns / concepts)
	for (const m of rationale.matchAll(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g)) {
		entities.add(m[1].toLowerCase());
	}
	// Single capitalized words that aren't sentence starters (heuristic: preceded by space)
	for (const m of rationale.matchAll(/\s([A-Z][a-z]{2,})\b/g)) {
		entities.add(m[1].toLowerCase());
	}
	return [...entities].sort();
}

/**
 * Compute ontology stability ratio between two rounds.
 * Returns 0..1 where 1 = perfect stability (no new/removed entities).
 */
function computeStability(prev: string[], current: string[]): number {
	if (prev.length === 0 && current.length === 0) return 1.0;
	const _prevSet = new Set(prev);
	const currSet = new Set(current);
	const stable = prev.filter((e) => currSet.has(e)).length;
	const total = new Set([...prev, ...current]).size;
	return total > 0 ? stable / total : 1.0;
}
