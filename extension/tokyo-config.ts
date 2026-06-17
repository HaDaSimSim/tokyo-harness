/**
 * tokyo user config — global (~/.tokyo/config.json) + project (.tokyo/config.json).
 *
 * Merged at startup. Project overrides global. Powers category→model resolution
 * for subagents, team workers, and hyperplan members.
 *
 * Schema (both files same shape; partial ok):
 * {
 *   "categories": {
 *     "standard": { "model": "relay/claude-sonnet-4.5" },
 *     "deep":     { "model": "relay/claude-opus-4.8" },
 *     "fast":     { "model": "relay/claude-haiku-4.5" },
 *     "creative": { "model": "relay/claude-opus-4.8" }
 *   },
 *   "agents": {
 *     "executor":  { "category": "standard" },
 *     "reviewer":  { "category": "deep", "excludeTools": ["edit","write"] },
 *     "architect": { "category": "deep", "excludeTools": ["edit","write"] }
 *   },
 *   "defaults": { "model": "relay/claude-opus-4.8" }
 * }
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ── types ────────────────────────────────────────────────────────────────────

export interface CategoryConfig {
	model: string;
	thinking?: string;
}

export interface AgentConfig {
	category: string;
	excludeTools?: string[];
}

export interface TokyoUserConfig {
	categories: Record<string, CategoryConfig>;
	agents: Record<string, AgentConfig>;
	defaults: {
		model: string;
		thinking?: string;
	};
}

// ── built-in defaults ────────────────────────────────────────────────────────

const BUILTIN: TokyoUserConfig = {
	categories: {
		standard: { model: "relay/claude-sonnet-4.5" },
		deep: { model: "relay/claude-opus-4.8", thinking: "xhigh" },
		creative: { model: "relay/claude-opus-4.8" },
		fast: { model: "relay/claude-haiku-4.5" },
	},
	agents: {
		executor: { category: "standard" },
		reviewer: { category: "deep", excludeTools: ["edit", "write"] },
		architect: { category: "deep", excludeTools: ["edit", "write"] },
		critic: { category: "creative", excludeTools: ["edit", "write"] },
		skeptic: { category: "fast" },
		validator: { category: "deep" },
		researcher: { category: "deep" },
	},
	defaults: {
		model: "relay/claude-opus-4.8",
	},
};

// ── load & merge ─────────────────────────────────────────────────────────────

let _config: TokyoUserConfig | null = null;

function loadJson(path: string): Partial<TokyoUserConfig> {
	try {
		if (!existsSync(path)) return {};
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return {};
	}
}

function deepMerge<T extends Record<string, any>>(base: T, override: Partial<T>): T {
	const out = { ...base };
	for (const key of Object.keys(override) as (keyof T)[]) {
		const v = override[key];
		if (v && typeof v === "object" && !Array.isArray(v) && typeof base[key] === "object" && !Array.isArray(base[key])) {
			(out as any)[key] = deepMerge(base[key] as any, v as any);
		} else if (v !== undefined) {
			(out as any)[key] = v;
		}
	}
	return out;
}

export function loadUserConfig(projectDir?: string): TokyoUserConfig {
	if (_config) return _config;
	const global = loadJson(join(homedir(), ".tokyo", "config.json"));
	const project = projectDir ? loadJson(join(projectDir, ".tokyo", "config.json")) : {};
	let merged = deepMerge(BUILTIN, global);
	merged = deepMerge(merged, project);
	_config = merged;
	return merged;
}

export function reloadUserConfig(projectDir?: string): TokyoUserConfig {
	_config = null;
	return loadUserConfig(projectDir);
}

// ── resolution ───────────────────────────────────────────────────────────────

export function resolveCategory(config: TokyoUserConfig, category: string): CategoryConfig {
	return config.categories[category] ?? config.categories.standard ?? { model: config.defaults.model };
}

export function resolveAgent(config: TokyoUserConfig, agentName: string): { category: CategoryConfig; excludeTools?: string[] } {
	const agent = config.agents[agentName];
	const catName = agent?.category ?? "standard";
	return {
		category: resolveCategory(config, catName),
		excludeTools: agent?.excludeTools,
	};
}

export function resolveWorkerModel(config: TokyoUserConfig, workerId: string, explicitModel?: string | null): string {
	if (explicitModel) return explicitModel;
	const agent = config.agents[workerId];
	if (agent) return resolveCategory(config, agent.category).model;
	return config.defaults.model;
}
