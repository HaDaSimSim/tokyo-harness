/**
 * Category → model map (OmO-style indirection).
 *
 * Agents and workers request a CATEGORY (quick / standard / deep / heavy /
 * creative) and the harness owns the concrete model mapping. This decouples the
 * prompts from the volatile model landscape: rebranding to another provider or
 * swapping models is a one-file change here, not scattered literals.
 *
 * Override the whole map (or any single category) via TOKYO_MODEL_<CATEGORY>
 * env vars, e.g. TOKYO_MODEL_DEEP=relay/gpt-5.2.
 */

export type ModelCategory = "quick" | "standard" | "deep" | "heavy" | "creative";

const DEFAULTS: Record<ModelCategory, string> = {
	quick: "relay/claude-opus-4.8",
	standard: "relay/claude-opus-4.8",
	deep: "relay/claude-opus-4.8",
	heavy: "relay/claude-opus-4.8",
	creative: "relay/claude-opus-4.8",
};

export function isModelCategory(v: unknown): v is ModelCategory {
	return typeof v === "string" && v in DEFAULTS;
}

/** Resolve a category (or an explicit provider/model string) to a concrete model. */
export function resolveModel(categoryOrModel: string | undefined, fallback: ModelCategory = "standard"): string {
	if (categoryOrModel && categoryOrModel.includes("/")) return categoryOrModel; // already a concrete model
	const category = isModelCategory(categoryOrModel) ? categoryOrModel : fallback;
	const envKey = `TOKYO_MODEL_${category.toUpperCase()}`;
	return process.env[envKey] || DEFAULTS[category];
}

export function categoryDefaults(): Record<ModelCategory, string> {
	return { ...DEFAULTS };
}
