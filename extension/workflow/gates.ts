/**
 * Tokyo mutation gate (pure: no fs, no pi API).
 *
 * Given the active phase's ToolPolicy and a tool call, decide whether to block it.
 * This is the hard veto that backs the phase contract — stronger than prose alone,
 * mirroring GJC's tool-capability barring of planning skills.
 *
 * Two layers:
 *   1. Mutation tools (edit/write) are blocked outright when `mutationsAllowed` is
 *      false. (We also remove them from the active set via setActiveTools, but the
 *      tool_call block is the belt-and-suspenders backstop in case the model still
 *      emits a call — e.g. a parallel batch.)
 *   2. Bash, when policy is "readonly", is blocked unless the command is a known
 *      read-only command AND not a known destructive one (deny ∩ allow), ported
 *      from plan-mode's isSafeCommand.
 */
import type { ToolPolicy } from "./phases.ts";

export interface GateDecision {
	block: boolean;
	reason?: string;
}

const ALLOW: GateDecision = { block: false };

// ---- bash safety (ported from plan-mode utils.ts) -----------------------------

const DESTRUCTIVE_PATTERNS: RegExp[] = [
	/\brm\b/i,
	/\brmdir\b/i,
	/\bmv\b/i,
	/\bcp\b/i,
	/\bmkdir\b/i,
	/\btouch\b/i,
	/\bchmod\b/i,
	/\bchown\b/i,
	/\bchgrp\b/i,
	/\bln\b/i,
	/\btee\b/i,
	/\btruncate\b/i,
	/\bdd\b/i,
	/\bshred\b/i,
	/(^|[^<])>(?!>)/, // single > redirect
	/>>/, // append redirect
	/\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
	/\byarn\s+(add|remove|install|publish)/i,
	/\bpnpm\s+(add|remove|install|publish)/i,
	/\bbun\s+(add|remove|install|i|link|publish)/i,
	/\bpip\s+(install|uninstall)/i,
	/\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
	/\bbrew\s+(install|uninstall|upgrade)/i,
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)/i,
	/\bsudo\b/i,
	/\bsu\b/i,
	/\bkill\b/i,
	/\bpkill\b/i,
	/\bkillall\b/i,
	/\breboot\b/i,
	/\bshutdown\b/i,
	/\bsystemctl\s+(start|stop|restart|enable|disable)/i,
	/\bservice\s+\S+\s+(start|stop|restart)/i,
	/\b(vim?|nano|emacs|code|subl)\b/i,
];

const SAFE_PATTERNS: RegExp[] = [
	/^\s*cat\b/,
	/^\s*head\b/,
	/^\s*tail\b/,
	/^\s*less\b/,
	/^\s*more\b/,
	/^\s*grep\b/,
	/^\s*find\b/,
	/^\s*ls\b/,
	/^\s*pwd\b/,
	/^\s*echo\b/,
	/^\s*printf\b/,
	/^\s*wc\b/,
	/^\s*sort\b/,
	/^\s*uniq\b/,
	/^\s*diff\b/,
	/^\s*file\b/,
	/^\s*stat\b/,
	/^\s*du\b/,
	/^\s*df\b/,
	/^\s*tree\b/,
	/^\s*which\b/,
	/^\s*whereis\b/,
	/^\s*type\b/,
	/^\s*env\b/,
	/^\s*printenv\b/,
	/^\s*uname\b/,
	/^\s*whoami\b/,
	/^\s*id\b/,
	/^\s*date\b/,
	/^\s*cal\b/,
	/^\s*uptime\b/,
	/^\s*ps\b/,
	/^\s*top\b/,
	/^\s*htop\b/,
	/^\s*free\b/,
	/^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get)/i,
	/^\s*git\s+ls-/i,
	/^\s*npm\s+(list|ls|view|info|search|outdated|audit)/i,
	/^\s*yarn\s+(list|info|why|audit)/i,
	/^\s*bun\s+(pm\s+ls|--version)/i,
	/^\s*node\s+--version/i,
	/^\s*python\s+--version/i,
	/^\s*curl\s/i,
	/^\s*wget\s+-O\s*-/i,
	/^\s*jq\b/,
	/^\s*sed\s+-n/i,
	/^\s*awk\b/,
	/^\s*rg\b/,
	/^\s*fd\b/,
	/^\s*bat\b/,
	/^\s*eza\b/,
];

export function isSafeCommand(command: string): boolean {
	const isDestructive = DESTRUCTIVE_PATTERNS.some((p) => p.test(command));
	const isSafe = SAFE_PATTERNS.some((p) => p.test(command));
	return !isDestructive && isSafe;
}

// ---- the gate -----------------------------------------------------------------

/** Tool names considered source mutations. */
const MUTATION_TOOL_NAMES = new Set(["edit", "write"]);

export interface ToolCallLike {
	toolName: string;
	input: Record<string, unknown> | undefined;
}

/**
 * Decide whether a write/edit targets inside the dot-dir, which must only be
 * mutated through the StateWriter (gate G1). Pure: the runtime resolves the
 * absolute target + stateRoot and passes them in. Blocks when the resolved
 * target is the state root or contained within it.
 */
export function guardsDotDirWrite(
	toolName: string,
	resolvedTarget: string | undefined,
	stateRoot: string,
	sep: string,
): GateDecision {
	if (toolName !== "write" && toolName !== "edit") return ALLOW;
	if (!resolvedTarget) return ALLOW;
	if (resolvedTarget === stateRoot || resolvedTarget.startsWith(stateRoot + sep)) {
		return {
			block: true,
			reason: `That path is inside tokyo's state dir, which is managed by the harness. Use the tokyo_* tools (tokyo_goal/tokyo_plan_save/tokyo_complete/...), not write/edit, to change harness state.`,
		};
	}
	return ALLOW;
}

/**
 * Decide whether a bash command would mutate the dot-dir. BEST-EFFORT guard:
 * it blocks the realistic accidental/lazy writes a non-adversarial model makes,
 * NOT a determined adversary. A model with full bash can ultimately evade any
 * textual gate (env-var indirection, cd-then-redirect, arbitrary interpreters),
 * so this is a discipline aid, not a security boundary — real adversarial
 * integrity requires restricting the model's bash or OS-level sandboxing.
 * Reads (cat/grep/ls of the dot-dir) are always allowed.
 */
export function guardsDotDirBash(toolName: string, command: string | undefined, dotDir: string): GateDecision {
	if (toolName !== "bash" || !command) return ALLOW;
	if (!command.includes(dotDir)) return ALLOW;
	const escaped = dotDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const block = (): GateDecision => ({
		block: true,
		reason: `That command writes inside tokyo's state dir (${dotDir}/), which is managed by the harness. Use the tokyo_* tools to change harness state; bash may read ${dotDir}/ but not mutate it.`,
	});
	const writePatterns: RegExp[] = [
		// redirection into the dot-dir:  > .tokyo/...   >> .tokyo/...   >| .tokyo/...
		new RegExp(`>>?\\|?\\s*["']?[^\\s"'|;&]*${escaped}\\b`),
		// tee into the dot-dir
		new RegExp(`\\btee\\b[^|;&]*${escaped}\\b`),
		// mutating commands that name the dot-dir as an operand
		new RegExp(
			`\\b(rm|rmdir|mv|cp|mkdir|touch|chmod|chown|ln|truncate|dd|sed\\s+-i|install|rsync|tar|ed|ex|sponge)\\b[^|;&]*${escaped}\\b`,
		),
		// cd / pushd INTO the dot-dir (a subsequent relative redirect would escape
		// the per-segment checks, so treat entering the dir as suspect when paired
		// with any write later in the command).
		new RegExp(`\\b(cd|pushd)\\s+["']?[^\\s"'|;&]*${escaped}\\b.*(>|\\btee\\b|\\bcp\\b|\\bmv\\b|\\brm\\b)`),
		// an interpreter whose inline script references the dot-dir (python/node/etc).
		new RegExp(`\\b(python3?|node|bun|deno|perl|ruby|php)\\b[^|;&]*${escaped}\\b`),
		// env-var assignment of the dot-dir name (D=.tokyo; ... > $D/...): conservative
		// — if the command assigns a var to a dot-dir path AND later redirects, block.
		new RegExp(`=["']?[^\\s"';&]*${escaped}\\b[^\\n]*(>|\\btee\\b)`),
	];
	if (writePatterns.some((p) => p.test(command))) return block();
	return ALLOW;
}
export function evaluateToolCall(policy: ToolPolicy, call: ToolCallLike, phaseLabel: string): GateDecision {
	// 1. Mutation tools.
	if (MUTATION_TOOL_NAMES.has(call.toolName) && !policy.mutationsAllowed) {
		return {
			block: true,
			reason: `Tokyo ${phaseLabel} phase is read-only: \`${call.toolName}\` is disabled. File modifications are barred until the plan is approved (EXECUTE phase).`,
		};
	}

	// 2. Bash under a readonly or research policy.
	if (call.toolName === "bash" && (policy.bash === "readonly" || policy.bash === "research")) {
		const command = typeof call.input?.command === "string" ? call.input.command : "";
		// research mode additionally allows fetch commands for clone-coding/analysis.
		const researchAllowed =
			policy.bash === "research" &&
			/^\s*git\s+(clone|fetch|ls-remote|sparse-checkout)\b/.test(command);
		if (!researchAllowed && !isSafeCommand(command)) {
			return {
				block: true,
				reason: `Tokyo ${phaseLabel} phase: command blocked (not an allowlisted ${policy.bash} command).\nCommand: ${command}`,
			};
		}
	}

	return ALLOW;
}
