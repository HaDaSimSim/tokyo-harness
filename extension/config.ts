/**
 * Central config for the harness. Change NAME here to rebrand everything:
 * the activation command, the status label, the dot-dir, and the auto-activate
 * env var the shell launcher sets.
 */
export const HARNESS = {
	/** Harness name. Rebrand in one place. */
	name: "tokyo",
	/** Slash command to activate in-session: /tokyo */
	command: "tokyo",
	/** Env var the terminal launcher sets to auto-activate this session. */
	autoEnv: "TOKYO_AUTO",
	/** In-project durable state dir (gitignored). */
	dotDir: ".tokyo",
	/** customType used for the per-session active-state entry. */
	stateEntryType: "tokyo:active",
	/** customType used for the durable per-branch phase entry. */
	phaseEntryType: "tokyo:phase",
	/** customType used for the durable per-branch planning-depth entry. */
	planModeEntryType: "tokyo:planmode",
	/** customType used for the durable per-branch continuation-counter entry. */
	contEntryType: "tokyo:cont",
	/** customType used for the branch-correct goals-state snapshot entry. */
	goalsEntryType: "tokyo:goals",
	/** customType used for the branch-correct events snapshot entry. */
	eventsEntryType: "tokyo:events",
	/** customType used for the per-session autonomous-mode toggle entry. */
	autoModeEntryType: "tokyo:automode",
	/** Status-bar key. */
	statusKey: "tokyo",
	/** Widget key for the phase/progress panel. */
	widgetKey: "tokyo:phase",
} as const;
