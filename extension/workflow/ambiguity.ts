/**
 * Tokyo ambiguity scoring (pure: no fs, no pi API).
 *
 * Ported from GJC deep-interview §"Calculate ambiguity":
 *   Greenfield: ambiguity = 1 - (goal*0.40 + constraints*0.30 + criteria*0.30)
 *   Brownfield: ambiguity = 1 - (goal*0.35 + constraints*0.25 + criteria*0.25 + context*0.15)
 *
 * The per-dimension 0..1 scores are produced by the model (it scores the
 * transcript and calls the `ambiguity` tool with them); this module owns the
 * weighting math, validation, and the gate decision so the numbers can't drift.
 */

export type ProjectKind = "greenfield" | "brownfield";

export interface DimensionScores {
	/** Primary objective clarity (0..1). */
	goal: number;
	/** Boundaries / non-goals clarity (0..1). */
	constraints: number;
	/** Acceptance-criteria / testability clarity (0..1). */
	criteria: number;
	/** Existing-system understanding (0..1). Brownfield only. */
	context?: number;
}

export const GREENFIELD_WEIGHTS = { goal: 0.4, constraints: 0.3, criteria: 0.3 } as const;
export const BROWNFIELD_WEIGHTS = { goal: 0.35, constraints: 0.25, criteria: 0.25, context: 0.15 } as const;

function clamp01(n: number): number {
	if (!Number.isFinite(n)) return 0;
	return n < 0 ? 0 : n > 1 ? 1 : n;
}

/**
 * Compute ambiguity (0..1, where 0 = perfectly clear) from dimension scores.
 * Brownfield uses the 4-dimension weighting; a missing `context` on brownfield
 * is treated as 0 (maximally unclear) so an unscored context can't hide ambiguity.
 */
export function computeAmbiguity(kind: ProjectKind, scores: DimensionScores): number {
	const goal = clamp01(scores.goal);
	const constraints = clamp01(scores.constraints);
	const criteria = clamp01(scores.criteria);
	if (kind === "brownfield") {
		const context = clamp01(scores.context ?? 0);
		const w = BROWNFIELD_WEIGHTS;
		const clarity = goal * w.goal + constraints * w.constraints + criteria * w.criteria + context * w.context;
		return round3(1 - clarity);
	}
	const w = GREENFIELD_WEIGHTS;
	const clarity = goal * w.goal + constraints * w.constraints + criteria * w.criteria;
	return round3(1 - clarity);
}

function round3(n: number): number {
	return Math.round(n * 1000) / 1000;
}

export interface GateResult {
	ambiguity: number;
	threshold: number;
	/** True when ambiguity ≤ threshold (clear enough to proceed to PLAN). */
	clear: boolean;
	/** The weakest dimension, to steer the next question. */
	weakestDimension: keyof DimensionScores;
	weakestScore: number;
}

/** Decide whether clarity is sufficient and identify the weakest dimension. */
export function evaluateClarity(kind: ProjectKind, scores: DimensionScores, threshold: number): GateResult {
	const ambiguity = computeAmbiguity(kind, scores);
	const dims: Array<[keyof DimensionScores, number]> = [
		["goal", clamp01(scores.goal)],
		["constraints", clamp01(scores.constraints)],
		["criteria", clamp01(scores.criteria)],
	];
	if (kind === "brownfield") dims.push(["context", clamp01(scores.context ?? 0)]);
	let weakest = dims[0];
	for (const d of dims) if (d[1] < weakest[1]) weakest = d;
	return {
		ambiguity,
		threshold,
		clear: ambiguity <= threshold,
		weakestDimension: weakest[0],
		weakestScore: weakest[1],
	};
}

/** Render a compact progress table for the user (used by the tool result). */
export function renderProgress(kind: ProjectKind, scores: DimensionScores, gate: GateResult): string {
	const w = kind === "brownfield" ? BROWNFIELD_WEIGHTS : GREENFIELD_WEIGHTS;
	const rows: string[] = [
		"| Dimension | Score | Weight | Weighted |",
		"|-----------|-------|--------|----------|",
	];
	const line = (name: string, score: number, weight: number) =>
		`| ${name} | ${clamp01(score).toFixed(2)} | ${weight.toFixed(2)} | ${(clamp01(score) * weight).toFixed(3)} |`;
	rows.push(line("Goal", scores.goal, w.goal));
	rows.push(line("Constraints", scores.constraints, w.constraints));
	rows.push(line("Criteria", scores.criteria, w.criteria));
	if (kind === "brownfield") rows.push(line("Context", scores.context ?? 0, (w as typeof BROWNFIELD_WEIGHTS).context));
	rows.push(`| **Ambiguity** | | | **${(gate.ambiguity * 100).toFixed(1)}%** |`);
	const verdict = gate.clear
		? `Clarity threshold met (≤ ${(gate.threshold * 100).toFixed(0)}%). Ready to advance to PLAN.`
		: `Above threshold (${(gate.threshold * 100).toFixed(0)}%). Weakest: ${gate.weakestDimension} (${gate.weakestScore.toFixed(2)}). Ask about that next.`;
	return `${rows.join("\n")}\n\n${verdict}`;
}
