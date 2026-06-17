/**
 * Unit tests for ambiguity scoring + threshold settings.
 * Run: bun test
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { computeAmbiguity, evaluateClarity } from "./ambiguity.ts";
import { DEFAULT_PROFILE, parseProfileFlag, PROFILES, resolveThreshold } from "./settings.ts";

describe("ambiguity formula", () => {
	test("greenfield perfect clarity = 0 ambiguity", () => {
		expect(computeAmbiguity("greenfield", { goal: 1, constraints: 1, criteria: 1 })).toBe(0);
	});

	test("greenfield zero clarity = 1 ambiguity", () => {
		expect(computeAmbiguity("greenfield", { goal: 0, constraints: 0, criteria: 0 })).toBe(1);
	});

	test("greenfield weighting matches GJC formula (0.40/0.30/0.30)", () => {
		// goal=1, others=0 → clarity 0.40 → ambiguity 0.60
		expect(computeAmbiguity("greenfield", { goal: 1, constraints: 0, criteria: 0 })).toBe(0.6);
		// criteria=1, others=0 → clarity 0.30 → ambiguity 0.70
		expect(computeAmbiguity("greenfield", { goal: 0, constraints: 0, criteria: 1 })).toBe(0.7);
	});

	test("brownfield weighting matches GJC formula (0.35/0.25/0.25/0.15)", () => {
		expect(computeAmbiguity("brownfield", { goal: 1, constraints: 1, criteria: 1, context: 1 })).toBe(0);
		// goal=1 only → clarity 0.35 → ambiguity 0.65
		expect(computeAmbiguity("brownfield", { goal: 1, constraints: 0, criteria: 0, context: 0 })).toBe(0.65);
	});

	test("brownfield missing context treated as 0 (can't hide ambiguity)", () => {
		// goal/constraints/criteria perfect, context absent → clarity 0.85 → ambiguity 0.15
		expect(computeAmbiguity("brownfield", { goal: 1, constraints: 1, criteria: 1 })).toBe(0.15);
	});

	test("scores are clamped to 0..1", () => {
		expect(computeAmbiguity("greenfield", { goal: 5, constraints: -3, criteria: 0.5 })).toBe(
			computeAmbiguity("greenfield", { goal: 1, constraints: 0, criteria: 0.5 }),
		);
	});
});

describe("clarity gate", () => {
	test("clears when ambiguity ≤ threshold", () => {
		const g = evaluateClarity("greenfield", { goal: 0.9, constraints: 0.9, criteria: 0.9 }, 0.2);
		expect(g.ambiguity).toBeCloseTo(0.1, 5);
		expect(g.clear).toBe(true);
	});

	test("does not clear when above threshold", () => {
		const g = evaluateClarity("greenfield", { goal: 0.5, constraints: 0.5, criteria: 0.5 }, 0.2);
		expect(g.clear).toBe(false);
	});

	test("identifies the weakest dimension", () => {
		const g = evaluateClarity("greenfield", { goal: 0.9, constraints: 0.3, criteria: 0.8 }, 0.2);
		expect(g.weakestDimension).toBe("constraints");
		expect(g.weakestScore).toBeCloseTo(0.3, 5);
	});

	test("brownfield can pick context as weakest", () => {
		const g = evaluateClarity("brownfield", { goal: 0.9, constraints: 0.9, criteria: 0.9, context: 0.2 }, 0.2);
		expect(g.weakestDimension).toBe("context");
	});
});

describe("threshold profiles", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(path.join(tmpdir(), "tokyo-settings-"));
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	test("profile values match the locked decision", () => {
		expect(PROFILES.quick).toBe(0.3);
		expect(PROFILES.standard).toBe(0.2);
		expect(PROFILES.deep).toBe(0.15);
	});

	test("default is Standard when nothing is configured", () => {
		const r = resolveThreshold(root, ".tokyo");
		expect(r.profile).toBe(DEFAULT_PROFILE);
		expect(r.threshold).toBe(0.2);
		expect(r.source).toBe("default");
	});

	test("run override wins over everything", () => {
		const r = resolveThreshold(root, ".tokyo", "deep");
		expect(r.profile).toBe("deep");
		expect(r.threshold).toBe(0.15);
		expect(r.source).toBe("run override");
	});

	test("project settings.json profile is read", () => {
		mkdirSync(path.join(root, ".tokyo"), { recursive: true });
		writeFileSync(path.join(root, ".tokyo", "settings.json"), JSON.stringify({ interview: { profile: "quick" } }));
		const r = resolveThreshold(root, ".tokyo");
		expect(r.profile).toBe("quick");
		expect(r.threshold).toBe(0.3);
	});

	test("explicit numeric threshold beats profile name", () => {
		mkdirSync(path.join(root, ".tokyo"), { recursive: true });
		writeFileSync(
			path.join(root, ".tokyo", "settings.json"),
			JSON.stringify({ interview: { profile: "quick", threshold: 0.05 } }),
		);
		const r = resolveThreshold(root, ".tokyo");
		expect(r.threshold).toBe(0.05);
	});

	test("invalid settings fall back to default", () => {
		mkdirSync(path.join(root, ".tokyo"), { recursive: true });
		writeFileSync(path.join(root, ".tokyo", "settings.json"), "{ not json");
		const r = resolveThreshold(root, ".tokyo");
		expect(r.profile).toBe(DEFAULT_PROFILE);
	});
});

describe("parseProfileFlag", () => {
	test("extracts a leading profile flag", () => {
		expect(parseProfileFlag("--deep build a thing")).toEqual({ profile: "deep", rest: "build a thing" });
	});
	test("no flag leaves rest intact", () => {
		expect(parseProfileFlag("build a thing")).toEqual({ rest: "build a thing" });
	});
});
