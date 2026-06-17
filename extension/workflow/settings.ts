/**
 * Tokyo settings — threshold profiles for the interview ambiguity gate.
 *
 * Profiles (user-selectable, locked in DECISION §7): Quick / Standard / Deep.
 * Precedence for the active profile/threshold:
 *   project `.tokyo/settings.json` → user `~/.tokyo/settings.json` → default (Standard).
 *
 * A per-run override (e.g. the interview skill invoked with --quick|--standard|--deep,
 * or the ambiguity tool's `profile` arg) takes precedence over all of the above for
 * that run only.
 *
 * Pure-ish: node fs + os only, no pi API.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const PROFILES = {
	quick: 0.3,
	standard: 0.2,
	deep: 0.15,
} as const;
export type ProfileName = keyof typeof PROFILES;

export const DEFAULT_PROFILE: ProfileName = "standard";

export function isProfileName(v: unknown): v is ProfileName {
	return typeof v === "string" && v in PROFILES;
}

export interface ResolvedThreshold {
	profile: ProfileName;
	threshold: number;
	/** Where the value came from, for the Phase-0 disclosure line. */
	source: string;
}

interface TokyoSettings {
	interview?: {
		profile?: string;
		/** Optional explicit threshold override (0..1); wins over profile when valid. */
		threshold?: number;
	};
}

function readSettings(file: string): TokyoSettings | null {
	try {
		const raw = fs.readFileSync(file, "utf8");
		return JSON.parse(raw) as TokyoSettings;
	} catch {
		return null;
	}
}

function validThreshold(n: unknown): n is number {
	return typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;
}

/**
 * Resolve the active threshold + profile + source.
 *
 * @param cwd          project root (for project `.tokyo/settings.json`)
 * @param dotDir       dot-dir name (".tokyo")
 * @param runOverride  per-run profile override (highest precedence)
 */
export function resolveThreshold(cwd: string, dotDir: string, runOverride?: string): ResolvedThreshold {
	// 1. per-run override wins
	if (isProfileName(runOverride)) {
		return { profile: runOverride, threshold: PROFILES[runOverride], source: "run override" };
	}

	const projectFile = path.join(cwd, dotDir, "settings.json");
	const userFile = path.join(os.homedir(), dotDir, "settings.json");

	for (const [file, label] of [
		[projectFile, projectFile],
		[userFile, userFile],
	] as const) {
		const s = readSettings(file);
		if (!s?.interview) continue;
		// explicit numeric threshold beats profile
		if (validThreshold(s.interview.threshold)) {
			const profile = profileForThreshold(s.interview.threshold);
			return { profile, threshold: s.interview.threshold, source: label };
		}
		if (isProfileName(s.interview.profile)) {
			return { profile: s.interview.profile, threshold: PROFILES[s.interview.profile], source: label };
		}
	}

	return { profile: DEFAULT_PROFILE, threshold: PROFILES[DEFAULT_PROFILE], source: "default" };
}

/** Nearest named profile for a raw threshold (for display only). */
function profileForThreshold(t: number): ProfileName {
	let best: ProfileName = DEFAULT_PROFILE;
	let bestDiff = Infinity;
	for (const [name, val] of Object.entries(PROFILES) as Array<[ProfileName, number]>) {
		const d = Math.abs(val - t);
		if (d < bestDiff) {
			bestDiff = d;
			best = name;
		}
	}
	return best;
}

/** Parse a leading --quick|--standard|--deep flag from a skill argument string. */
export function parseProfileFlag(args: string): { profile?: ProfileName; rest: string } {
	const m = args.trim().match(/^--(quick|standard|deep)\b\s*/i);
	if (!m) return { rest: args.trim() };
	return { profile: m[1].toLowerCase() as ProfileName, rest: args.slice(m[0].length).trim() };
}
