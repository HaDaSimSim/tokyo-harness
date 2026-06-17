/**
 * Harness extension entry — SOLE pi-API boundary.
 *
 * Activation model (per-session, option A):
 *   - The extension is always LOADED (auto-discovery or -e), but does nothing
 *     unless `active` is true.
 *   - `active` is per-session: stored via pi.appendEntry into the session JSONL
 *     and restored in session_start. /new starts off; /resume restores; /fork
 *     inherits the branch's state.
 *   - The terminal launcher sets HARNESS.autoEnv=1 to auto-activate on start.
 *   - In pi-gui (or plain pi), the user activates a session with /<command>.
 *
 * All harness behavior (phase gating, continuation loop, tools) lives behind
 * the `active` gate. When off, every handler returns immediately, so a plain
 * pi session is unaffected even though the module is loaded.
 *
 * STEP 3 adds the phase machine: IDLE→INTERVIEW→PLAN→(consent)→EXECUTE→VERIFY→DONE.
 *   - Phase is persisted per-branch via appendEntry (branch-correct, invisible to
 *     the LLM) and restored in session_start.
 *   - `before_agent_start` injects the phase contract into the system prompt.
 *   - `tool_call` hard-blocks mutations while the phase policy is read-only, and
 *     `setActiveTools` removes the barred tools from the active set as a coarse
 *     first layer (belt and suspenders).
 *   - A status entry + widget reflect the current phase.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as nodePath from "node:path";
import { HARNESS } from "./config.ts";
import { makeAmbiguityTool } from "./team/interview.ts";
import { makePlanSaveTool, makeCompleteTool, makeGoalTool, makeSpecSaveTool, makeVerifyTool, hasVerifyEvidence, readGoals } from "./team/state-tools.ts";
import { makeMemoryTool, readMemories } from "./team/memory.ts";
import { makeNotepadTool } from "./team/notepad.ts";
import { readSessionState, writeSessionState } from "./state/session.ts";
import { makeTeamTool, teardownAllTeams } from "./team/team-tools.ts";
import { TeamCoordinator } from "./team/coordination.ts";
import { makePhaseTool } from "./team/tools.ts";
import { StateWriter } from "./state/index.ts";
import { resolveModel } from "./team/models.ts";
import {
	canTransition,
	decideContinuation,
	evaluateToolCall,
	guardsDotDirBash,
	guardsDotDirWrite,
	freshContinuationState,
	isPhase,
	isPlanMode,
	isProfileName,
	MUTATION_TOOLS,
	parseProfileFlag,
	type Phase,
	PhaseMachine,
	phaseContract,
	type PlanMode,
	PLAN_MODE_LABELS,
	PLAN_MODES,
	type ProfileName,
	transitionRequiresConsent,
} from "./workflow/index.ts";

/** Experimental team/hyperplan (persistent workers) — off by default for the
 * stable TUI MVP; the persistent-worker context model is not yet live-verified. */
const TEAM_ENABLED = true; // always on — orchestrator handles workers on-demand

/** Tokyo's own tools, always present while active so the model can self-drive. */
const CORE_TOKYO_TOOLS = ["tokyo_phase", "tokyo_ambiguity", "tokyo_spec_save", "tokyo_plan_save", "tokyo_goal", "tokyo_complete", "tokyo_verify", "tokyo_memory", "tokyo_notepad"];
const TOKYO_TOOLS = [...CORE_TOKYO_TOOLS, "tokyo_team"];
/** Tools available when a phase bars mutations (mirrors plan-mode's read-only set). */
const READONLY_TOOLS = ["read", "bash", "grep", "find", "ls", "questionnaire", ...TOKYO_TOOLS];
/** Tools available when a phase allows mutations. */
const FULL_TOOLS = ["read", "bash", "grep", "find", "ls", "questionnaire", ...MUTATION_TOOLS, ...TOKYO_TOOLS];
/** EXECUTE tool set: same as FULL but WITHOUT questionnaire — EXECUTE is the
 * autonomous run phase and must never block waiting for user input (so it keeps
 * grinding while you're away). The model records autonomous choices in the
 * ledger instead of asking. Clarifying questions belong in INTERVIEW/PLAN. */
const EXECUTE_TOOLS = FULL_TOOLS.filter((t) => t !== "questionnaire");

/** Default model for delegated subagents (override via TOKYO_SUBAGENT_MODEL). */
const DEFAULT_SUBAGENT_MODEL = process.env.TOKYO_SUBAGENT_MODEL || resolveModel("standard");

/** Markers that indicate a model printed tool-call syntax as TEXT instead of
 * making a real tool call. Kept narrow to avoid false positives on normal prose
 * that merely mentions a tool name. */
const RAW_TOOLCALL_MARKERS = [
	"<invoke name=",
	"<function_calls>",
	"<function_call>",
	"\u3010invoke name=", // fullwidth bracket variant some models emit
];

function looksLikeRawToolCall(text: string): boolean {
	return RAW_TOOLCALL_MARKERS.some((m) => text.includes(m));
}

/** Pull the concatenated text of the LAST assistant message from an agent_end
 * messages array. Tolerant of shape differences (content as string or parts). */
function extractLastAssistantText(messages: unknown[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as { role?: unknown; content?: unknown } | undefined;
		if (!m || m.role !== "assistant") continue;
		const c = m.content;
		if (typeof c === "string") return c;
		if (Array.isArray(c)) {
			return c
				.map((part) => {
					const p = part as { type?: unknown; text?: unknown } | undefined;
					return p && p.type === "text" && typeof p.text === "string" ? p.text : "";
				})
				.join("");
		}
		return "";
	}
	return "";
}

export default function harness(pi: ExtensionAPI) {
	let active = false;
	const machine = new PhaseMachine("IDLE");
	/** Per-run interview threshold profile override (from `/tokyo <profile>`). */
	let runProfile: ProfileName | undefined;
	/** Planning depth chosen at PLAN entry (asked by the harness). */
	let planMode: PlanMode = "consensus";
	/** Whether the planning-depth prompt has already been answered this run (so
	 * RESEARCH↔PLAN iterations don't re-ask). Reset by rebuildFromBranch. */
	let planModeAsked = false;
	/** Autonomous mode (/tokyo-auto): when on, the harness runs unattended — it
	 * auto-approves consent gates, never lets the model ask the user (questionnaire
	 * blocked everywhere), and keeps the continuation loop driving. Persisted per
	 * session so it survives compaction/resume. */
	let autoMode = false;
	/** Sole sanctioned .tokyo/ writer (gate G1), rooted at the project cwd. */
	const state = new StateWriter(process.cwd(), HARNESS.dotDir);
	/** Continuation-loop counters (reset whenever EXECUTE is (re)entered). */
	let cont = freshContinuationState();

	// ---- status + tool-set sync --------------------------------------------

	function phaseGlyph(phase: Phase): string {
		switch (phase) {
			case "IDLE":
				return "○";
			case "INTERVIEW":
				return "?";
			case "RESEARCH":
				return "⌕";
			case "PLAN":
				return "◇";
			case "EXECUTE":
				return "▶";
			case "VERIFY":
				return "✓";
			case "REVIEW":
				return "⏸";
			case "DONE":
				return "●";
		}
	}

	function syncStatus(ctx: ExtensionContext): void {
		if (!active) {
			ctx.ui.setStatus(HARNESS.statusKey, undefined);
			ctx.ui.setWidget(HARNESS.widgetKey, undefined);
			return;
		}
		const phase = machine.current;
		const color = phase === "EXECUTE" ? "accent" : phase === "DONE" ? "success" : phase === "REVIEW" ? "accent" : "warning";
		const autoBadge = autoMode ? " ⚡auto" : "";
		ctx.ui.setStatus(
			HARNESS.statusKey,
			ctx.ui.theme.fg(color, `${phaseGlyph(phase)} ${HARNESS.name}:${phase.toLowerCase()}${autoBadge}`),
		);
		// Widget: phase + what it permits.
		const policy = machine.policy();
		const perms = `${policy.mutationsAllowed ? "edit/write ✓" : "read-only"} · bash:${policy.bash}`;
		ctx.ui.setWidget(HARNESS.widgetKey, [
			ctx.ui.theme.fg(color, `${phaseGlyph(phase)} ${phase}`),
			ctx.ui.theme.fg("muted", perms),
		]);
	}

	/** Render the team status widget from .tokyo/team/ (TUI + pi-gui via setWidget). */
	async function renderTeamWidget(ctx: ExtensionContext): Promise<void> {
		if (!active) return;
		try {
			// Find the most recently touched team via its manifest under team/*/manifest.json.
			const teamsRoot = `${HARNESS.dotDir}/team`;
			const abs = `${process.cwd()}/${teamsRoot}`;
			const fsmod = await import("node:fs");
			if (!fsmod.existsSync(abs)) {
				ctx.ui.setWidget(`${HARNESS.widgetKey}:team`, undefined);
				return;
			}
			const dirs = fsmod
				.readdirSync(abs, { withFileTypes: true })
				.filter((d) => d.isDirectory())
				.map((d) => d.name);
			let best: { team: string; mtime: number } | null = null;
			for (const t of dirs) {
				const mf = `${abs}/${t}/manifest.json`;
				if (!fsmod.existsSync(mf)) continue;
				const mt = fsmod.statSync(mf).mtimeMs;
				if (!best || mt > best.mtime) best = { team: t, mtime: mt };
			}
			if (!best) {
				ctx.ui.setWidget(`${HARNESS.widgetKey}:team`, undefined);
				return;
			}
			const co = new TeamCoordinator(state, best.team);
			const m = await co.readManifest();
			if (!m || m.phase === "stopped") {
				ctx.ui.setWidget(`${HARNESS.widgetKey}:team`, undefined);
				return;
			}
			const tasks = await co.listTasks();
			const doneCount = tasks.filter((t) => t.status === "complete").length;
			const lines = [
				ctx.ui.theme.fg("accent", `◈ team:${best.team}  ${doneCount}/${tasks.length} tasks`),
				...m.workers.map((w) =>
					ctx.ui.theme.fg("muted", `  ${w.id}${w.role ? `:${w.role}` : ""} — ${w.status}`),
				),
			];
			ctx.ui.setWidget(`${HARNESS.widgetKey}:team`, lines);
		} catch {
			/* widget is best-effort */
		}
	}

	/** Mirror the phase policy onto the active tool set (coarse first layer). */
	function syncActiveTools(): void {
		if (!active) return;
		const base =
			machine.current === "EXECUTE"
				? EXECUTE_TOOLS
				: machine.policy().mutationsAllowed ? FULL_TOOLS : READONLY_TOOLS;
		// Autonomous mode: drop questionnaire everywhere so an unattended run can
		// never block waiting for the user to answer.
		pi.setActiveTools(autoMode ? base.filter((t) => t !== "questionnaire") : base);
	}

	function setActive(next: boolean, ctx: ExtensionContext): void {
		active = next;
		if (next) {
			// Activation enters the workflow at INTERVIEW (read-only clarity gate),
			// not IDLE: turning tokyo on means "start interviewing me".
			machine.restore("INTERVIEW");
			// Make tokyo agents discoverable by pi's agent system
			void linkTokyoAgents(true);
		} else {
			machine.reset();
			void linkTokyoAgents(false);
		}
		syncStatus(ctx);
		syncActiveTools();
	}

	/** Persist the current phase as a branch-correct, LLM-invisible custom entry. */
	function persistPhase(): void {
		pi.appendEntry(HARNESS.phaseEntryType, { phase: machine.current });
		syncSessionState();
	}

	/** Sync in-memory harness state to .tokyo/sessions/current/state.json so it
	 * survives pi session compaction/restart (decouples tokyo from pi sessions). */
	function syncSessionState(): void {
		writeSessionState(state, {
			phase: machine.current,
			planMode,
			autoMode,
			cont,
		}).catch(() => {});
	}

	/** Symlink/remove tokyo agents to/from project .pi/agent/agents/ for pi agent discovery.
	 * Source agent .md files are clean (NO model line — portable). The harness
	 * injects the correct model from tokyo config (global ~/.tokyo/config.json or
	 * project .tokyo/config.json) into the deployed copies so each agent gets the
	 * category-resolved model without hardcoding it. */
	async function linkTokyoAgents(enable: boolean): Promise<void> {
		try {
			const fs = await import("node:fs");
			const path = await import("node:path");
			const targetDir = path.join(process.cwd(), ".pi", "agent", "agents");
			const extensionDir = path.dirname(path.dirname(new URL(import.meta.url).pathname));
			const agentsSource = path.join(extensionDir, "agents");

			if (enable) {
				fs.mkdirSync(targetDir, { recursive: true });
				if (!fs.existsSync(agentsSource)) return;
				// Load config for model resolution (lazy, cached).
				const config = (await import("./tokyo-config.ts")).loadUserConfig(process.cwd());
				for (const file of fs.readdirSync(agentsSource)) {
					if (!file.endsWith(".md")) continue;
					const src = path.join(agentsSource, file);
					const dst = path.join(targetDir, `tokyo-${file}`);
					// Read source, inject model from config, write to target.
					const raw = fs.readFileSync(src, "utf-8");
					const agentName = file.replace(/\.md$/, "");
					const agentCfg = config.agents[agentName];
					const model = agentCfg
						? ((await import("./tokyo-config.ts")).resolveCategory(config, agentCfg.category).model)
						: config.defaults.model;
					let injected = raw;
					if (raw.startsWith("---")) {
						// Insert model line after the tools line in YAML frontmatter.
						const secondDelim = raw.indexOf("---", 4);
						if (secondDelim > 0) {
							const before = raw.slice(0, secondDelim);
							const after = raw.slice(secondDelim);
							if (!before.includes("\nmodel:")) {
								injected = `${before}model: ${model}\n${after}`;
							}
						}
					}
					fs.writeFileSync(dst, injected, "utf-8");
				}
			} else {
				// Remove tokyo agent symlinks or generated files
				if (!fs.existsSync(targetDir)) return;
				for (const file of fs.readdirSync(targetDir)) {
					if (file.startsWith("tokyo-") && file.endsWith(".md")) {
						const fp = path.join(targetDir, file);
						try { if (fs.lstatSync(fp).isSymbolicLink() || fs.statSync(fp).isFile()) fs.unlinkSync(fp); } catch {}
					}
				}
			}
		} catch { /* best effort */ }
	}

	/**
	 * Apply a phase transition (already validated/consented by the caller),
	 * persist it, and resync UI + tools.
	 */
	function commitPhase(to: Phase, ctx: ExtensionContext, opts?: { withConsent?: boolean }): boolean {
		// Self-transition is a no-op (M1 fix: prevents resetting EXECUTE state mid-run)
		if (machine.current === to) return true;
		const result = machine.transition(to, opts);
		if (!result.ok) {
			ctx.ui.notify(result.error ?? `cannot enter ${to}`, "warning");
			return false;
		}
		persistPhase();
		// Snapshot events for branch isolation (M2 fix: /fork won't bleed sibling events).
		void snapshotEvents();
		// Per-stage artifact persistence: save phase-specific artifacts at transition.
		void saveStageArtifact(machine.current);
		// Reset the continuation counters whenever EXECUTE is (re)entered so a fresh
		// execution run gets a full iteration budget and clean dedup signature.
		if (to === "EXECUTE") {
			cont = freshContinuationState();
			// Mark EXECUTE entry in the ledger so verify-evidence is anchored to THIS
			// run — re-entering EXECUTE (re-plan / fix) invalidates a prior 'verified'.
			void state
				.appendJsonl("ledger/events.jsonl", {
					schema_version: 2,
					span_id: crypto.randomUUID().slice(0, 8),
					ts: new Date().toISOString(),
					type: "execute_entered",
				})
				.catch(() => {});
		}
		syncStatus(ctx);
		syncActiveTools();
		return true;
	}

	/**
	 * Shared transition entry point for BOTH the /tokyo-phase command and the
	 * tokyo_phase tool. Validates legality, obtains user consent for consent-gated
	 * edges (PLAN→EXECUTE), applies, and returns a structured result.
	 */
	async function requestTransition(
		to: Phase,
		ctx: ExtensionContext,
	): Promise<{ ok: true; phase: Phase } | { ok: false; reason: string }> {
		if (!isPhase(to)) {
			return { ok: false, reason: `unknown phase "${to}"` };
		}
		const from = machine.current;
		if (!canTransition(from, to)) {
			return { ok: false, reason: `illegal transition ${from} → ${to}` };
		}
		if (transitionRequiresConsent(from, to)) {
			// Consent gates: PLAN→EXECUTE (begin work) and REVIEW→DONE (accept result).
			// With a UI we prompt; headless we fail closed unless TOKYO_AUTO_CONSENT=1.
			const isReview = from === "REVIEW" && to === "DONE";
			const prompt = isReview
				? "Accept the result and finish?"
				: "Approve the plan and begin execution?";
			const detail = isReview
				? "Marks the workflow DONE. Decline to keep iterating (re-plan / fix / re-clarify)."
				: "Execution enables edit/write.";
			let ok = false;
			if (autoMode) {
				// Autonomous mode: auto-approve consent gates so an unattended run
				// flows PLAN→EXECUTE and REVIEW→DONE without a human.
				ok = true;
				if (ctx.hasUI) ctx.ui.notify(`${HARNESS.name}: auto-approved (${from}→${to}) — autonomous mode.`, "info");
			} else if (ctx.hasUI) {
				ok = await ctx.ui.confirm(prompt, detail);
			} else if (process.env.TOKYO_AUTO_CONSENT === "1") {
				ok = true;
			}
			if (!ok) {
				return {
					ok: false,
					reason: ctx.hasUI
						? isReview
							? "user did not accept the result (still in REVIEW)"
							: "user did not approve execution"
						: "no UI for consent (set TOKYO_AUTO_CONSENT=1 to allow headless)",
				};
			}
			if (!commitPhase(to, ctx, { withConsent: true })) return { ok: false, reason: "transition failed" };
			return { ok: true, phase: machine.current };
		}
		// VERIFY→REVIEW evidence gate: require recorded verification evidence so the
		// final transition isn't a free rubber-stamp (fixes the unguarded VERIFY→DONE).
		if (from === "VERIFY" && to === "REVIEW") {
			let hasEvidence = false;
			try {
				hasEvidence = await hasVerifyEvidence(state);
			} catch {
				hasEvidence = false;
			}
			if (!hasEvidence) {
				return { ok: false, reason: "no verification evidence recorded — run tokyo_verify (build/tests + reviewer verdict) before REVIEW" };
			}
			if (!commitPhase(to, ctx)) return { ok: false, reason: "transition failed" };
			return { ok: true, phase: machine.current };
		}
		// Entering PLAN: ask planning depth on the FIRST entry into PLAN regardless of
		// source phase (normal flow is INTERVIEW→RESEARCH→PLAN, so `from` is usually
		// RESEARCH, not INTERVIEW). planModeAsked guards RESEARCH↔PLAN re-entries.
		if (to === "PLAN" && !planModeAsked) {
			const availableModes = PLAN_MODES;
			if (ctx.hasUI) {
				const choice = await ctx.ui.select(
					"Planning depth?",
					availableModes.map((m) => PLAN_MODE_LABELS[m]),
				);
				const idx = choice ? availableModes.map((m) => PLAN_MODE_LABELS[m]).indexOf(choice) : -1;
				if (idx >= 0) planMode = availableModes[idx];
			}
			planModeAsked = true;
			pi.appendEntry(HARNESS.planModeEntryType, { planMode });
			if (!commitPhase(to, ctx)) return { ok: false, reason: "transition failed" };
			if (ctx.hasUI) ctx.ui.notify(`Planning depth: ${planMode}.`, "info");
			// Auto-kick: the phase contract is injected with display:false on the NEXT
			// turn, so entering PLAN alone doesn't make the model act — it waits for
			// user input. Nudge it now so the chosen planning depth runs without the
			// user having to type "hyperplan"/"plan". Steer if mid-turn, immediate if idle.
			const planKick =
				planMode === "adversarial"
					? "Entering PLAN with ADVERSARIAL (hyperplan) depth. Begin the hyperplan process now per your phase contract: create the hyperplan team, start hyperplan_run, and wait for the completion ping. Do not ask me to start it."
					: `Entering PLAN with ${planMode} depth. Begin planning now per your phase contract.`;
			try {
				if (ctx.isIdle()) pi.sendUserMessage(planKick);
				else pi.sendUserMessage(planKick, { deliverAs: "followUp" });
			} catch { /* host not ready — contract still injects next turn */ }
			return { ok: true, phase: machine.current };
		}
		if (!commitPhase(to, ctx)) return { ok: false, reason: "transition failed" };
		return { ok: true, phase: machine.current };
	}

	// ---- per-session activation + phase state ------------------------------

	/**
	 * Rebuild in-memory state from the CURRENT BRANCH (not the whole tree), so
	 * /fork and /tree restore the phase/profile/planMode/continuation that belong
	 * to the active leaf. Registered on both session_start and session_tree.
	 */
	async function rebuildFromBranch(ctx: ExtensionContext): Promise<void> {
		let restoredActive = false;
		let restoredPhase: Phase | null = null;
		let branchGoals: { goals: unknown[]; current_goal_id: string | null } | null = null;
		let branchEvents: unknown[] | null = null;
		runProfile = undefined;
		planMode = "consensus";
		cont = freshContinuationState();
		autoMode = false;

		// Load tokyo state from its OWN session file (.tokyo/sessions/current/state.json),
		// NOT from pi session entries. This decouples tokyo from pi sessions so the
		// harness survives compaction, restart, and new pi sessions.
		try {
			const sess = await readSessionState(state);
			if (sess) {
				machine.restore(sess.phase);
				planMode = sess.planMode;
				autoMode = sess.autoMode;
				cont = sess.cont;
				restoredPhase = sess.phase;
				restoredActive = sess.phase !== "IDLE";
				// Fall through to pi session scan for branch-correct goals/events snapshots only.
			}
		} catch { /* session file not found or corrupt — fall through to pi session fallback */ }

		// Pi session JSONL scan: only for goals/events branch snapshots. Phase/planMode/autoMode
		// are now owned by tokyo's session state above; the pi session scan is a fallback.
		// getBranch() walks leaf->root for THIS branch only; last write wins per kind.
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom") continue;
			if (entry.customType === HARNESS.stateEntryType) {
				const data = entry.data as { active?: boolean; profile?: unknown } | undefined;
				restoredActive = Boolean(data?.active);
				if (isProfileName(data?.profile)) runProfile = data.profile;
			} else if (entry.customType === HARNESS.phaseEntryType) {
				const p = (entry.data as { phase?: unknown } | undefined)?.phase;
				if (isPhase(p)) restoredPhase = p;
			} else if (entry.customType === HARNESS.planModeEntryType) {
				const pm = (entry.data as { planMode?: unknown } | undefined)?.planMode;
				if (isPlanMode(pm)) planMode = pm;
				// Don't restore adversarial mode when the team runtime is off — its contract
				// references tokyo_team, which isn't registered. Fall back to consensus.
				if (planMode === "adversarial" && !TEAM_ENABLED) planMode = "consensus";
			} else if (entry.customType === HARNESS.contEntryType) {
				const c = entry.data as { iterations?: number; lastSignature?: string } | undefined;
				if (c && typeof c.iterations === "number") {
					cont = { iterations: c.iterations, lastSignature: typeof c.lastSignature === "string" ? c.lastSignature : "" };
				}
			} else if (entry.customType === HARNESS.goalsEntryType) {
				branchGoals = entry.data as { goals: unknown[]; current_goal_id: string | null } | null;
			} else if (entry.customType === HARNESS.eventsEntryType) {
				branchEvents = (entry.data as { events?: unknown[] } | null)?.events ?? null;
			} else if (entry.customType === HARNESS.autoModeEntryType) {
				const am = (entry.data as { autoMode?: unknown } | undefined)?.autoMode;
				if (typeof am === "boolean") autoMode = am;
			}
		}

		// terminal launcher opt-in: auto-activate this session
		if (process.env[HARNESS.autoEnv] === "1") restoredActive = true;

		active = restoredActive;
		machine.restore(restoredPhase ?? (active ? "INTERVIEW" : "IDLE"));
		// Restore THIS branch's goals snapshot onto the flat goals.json so the ledger
		// follows the branch (fixes the flat-file /fork bleed). Awaited so the first
		// turn's reads don't race a stale sibling ledger. When the branch has NO
		// snapshot, reset goals.json to empty rather than leaving a sibling's goals.
		try {
			await state.writeJsonAtomic("ledger/goals.json", branchGoals ?? { goals: [], current_goal_id: null }, {
				audit: { category: "state", verb: "goals_branch_restore", skill: "execute" },
			});
		} catch {
			/* best-effort */
		}
		// Restore branch-correct events.jsonl (M2 fix: /fork isolation).
		if (branchEvents !== null) {
			try {
				const eventsContent = branchEvents.map((e) => JSON.stringify(e)).join("\n") + "\n";
				const fs = await import("node:fs");
				const eventsPath = state.resolveTarget("ledger/events.jsonl");
				fs.writeFileSync(eventsPath, eventsContent, "utf8");
			} catch { /* best-effort */ }
		}
		syncStatus(ctx);
		syncActiveTools();
	}

	pi.on("session_start", async (_event, ctx) => {
		await rebuildFromBranch(ctx);
		if (process.env.TOKYO_DEBUG === "1") {
			process.stderr.write(`[${HARNESS.name}] session_start active=${active} phase=${machine.current}\n`);
		}
		if (active) {
			ctx.ui.notify(`${HARNESS.name} active (phase: ${machine.current.toLowerCase()}).`, "info");
		}
	});

	// /tree navigation moves the leaf without a new session; rebuild from the new branch.
	pi.on("session_tree", async (_event, ctx) => {
		await rebuildFromBranch(ctx);
	});

	pi.registerCommand(HARNESS.command, {
		description: `Activate the ${HARNESS.name} workflow harness (optional: quick|standard|deep profile)`,
		handler: async (args, ctx) => {
			const { profile } = parseProfileFlag(args.replace(/^--/, ""));
			if (profile && isProfileName(profile)) runProfile = profile;
			else if (isProfileName(args.trim())) runProfile = args.trim() as ProfileName;
			setActive(true, ctx);
			pi.appendEntry(HARNESS.stateEntryType, { active: true, profile: runProfile });
			persistPhase();
			ctx.ui.notify(
				`${HARNESS.name} activated — interview phase${runProfile ? ` (${runProfile})` : ""}.`,
				"info",
			);
		},
	});

	pi.registerCommand(`${HARNESS.command}-off`, {
		description: `Deactivate ${HARNESS.name} for this session`,
		handler: async (_args, ctx) => {
			setActive(false, ctx);
			pi.appendEntry(HARNESS.stateEntryType, { active: false });
			// also persist the reset phase so /resume doesn't restore a stale phase
			pi.appendEntry(HARNESS.phaseEntryType, { phase: machine.current });
			ctx.ui.notify(`${HARNESS.name} deactivated.`, "info");
		},
	});

	// Autonomous mode toggle: run unattended (auto-consent, no user questions,
	// continuation loop keeps driving). For "kick it off and go to sleep" runs.
	pi.registerCommand(`${HARNESS.command}-auto`, {
		description: `Toggle ${HARNESS.name} autonomous mode (unattended: auto-consent, no questions)`,
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "on") autoMode = true;
			else if (arg === "off") autoMode = false;
			else autoMode = !autoMode;
			pi.appendEntry(HARNESS.autoModeEntryType, { autoMode });
			syncSessionState();
			syncActiveTools();
			syncStatus(ctx);
			ctx.ui.notify(
				autoMode
					? `${HARNESS.name}: AUTONOMOUS mode ON — auto-consent, no user questions, continuation keeps running. Safe to walk away.`
					: `${HARNESS.name}: autonomous mode OFF — consent prompts and questions restored.`,
				autoMode ? "warning" : "info",
			);
		},
	});

	// Express lane for small, well-specified tasks: activate and jump straight to a
	// QUICK plan (skipping the full interview), so a one-line fix isn't forced
	// through the whole ceremony. The PLAN->EXECUTE consent gate still applies.
	pi.registerCommand(`${HARNESS.command}-go`, {
		description: `${HARNESS.name}: fast lane for a small, well-specified task (skip interview, quick plan)`,
		handler: async (args, ctx) => {
			if (!active) {
				setActive(true, ctx);
				pi.appendEntry(HARNESS.stateEntryType, { active: true, profile: runProfile });
			}
			// Block express lane if already past PLAN (can't jump back from EXECUTE/VERIFY/REVIEW)
			const cur = machine.current;
			if (cur === "EXECUTE" || cur === "VERIFY" || cur === "REVIEW") {
				ctx.ui.notify(`${HARNESS.name}: express lane blocked — already in ${cur}. Finish or /tokyo-reset first.`, "warning");
				return;
			}
			planMode = "quick";
			pi.appendEntry(HARNESS.planModeEntryType, { planMode });
			machine.restore("PLAN");
			persistPhase();
			syncStatus(ctx);
			syncActiveTools();
			const task = args.trim();
			ctx.ui.notify(`${HARNESS.name}: express lane — quick plan${task ? "" : " (describe the task)"}.`, "info");
			if (task && ctx.isIdle()) {
				pi.sendUserMessage(
					`Quick task (express lane): ${task}\nDraft a minimal plan with tokyo_plan_save, then request execution consent with tokyo_phase EXECUTE.`,
				);
			}
		},
	});

	// Phase-driving command. Mirrors the tokyo_phase tool for manual/escape-hatch
	// use. Both routes share requestTransition (consent handled there).
	pi.registerCommand(`${HARNESS.command}-phase`, {
		description: `Show or set the ${HARNESS.name} phase (no arg = show; arg = transition)`,
		handler: async (args, ctx) => {
			if (!active) {
				ctx.ui.notify(`${HARNESS.name} is not active. Use /${HARNESS.command} first.`, "warning");
				return;
			}
			const arg = args.trim().toUpperCase();
			if (!arg) {
				ctx.ui.notify(`Phase: ${machine.current} · ${JSON.stringify(machine.policy())}`, "info");
				return;
			}
			if (!isPhase(arg)) {
				ctx.ui.notify(`Unknown phase "${arg}". One of: IDLE INTERVIEW RESEARCH PLAN EXECUTE VERIFY REVIEW DONE`, "warning");
				return;
			}
			const result = await requestTransition(arg, ctx);
			if (result.ok) ctx.ui.notify(`Phase → ${result.phase}`, "info");
			else ctx.ui.notify(result.reason, "info");
		},
	});

	// ---- tokyo tools: let the model self-drive phases + delegate thinking ----
	pi.registerTool(
		makePhaseTool({
			getPhase: () => machine.current,
			requestTransition,
		}),
	);
	pi.registerTool(
		makeAmbiguityTool({
			getPhase: () => machine.current,
			cwd: () => process.cwd(),
			dotDir: HARNESS.dotDir,
			runProfile: () => runProfile,
			advanceToPlan: async (ctx) => {
				const r = await requestTransition("PLAN", ctx);
				return r.ok;
			},
			state,
		}),
	);
	pi.registerTool(makePlanSaveTool({ state, getPhase: () => machine.current }));
	pi.registerTool(makeSpecSaveTool({ state, getPhase: () => machine.current }));
	pi.registerTool(makeGoalTool({ state, getPhase: () => machine.current, onGoalsChange: snapshotGoals }));
	pi.registerTool(makeCompleteTool({ state, getPhase: () => machine.current, onGoalsChange: snapshotGoals }));
	pi.registerTool(makeMemoryTool({ state }));
	pi.registerTool(makeVerifyTool({ state, getPhase: () => machine.current }));
	pi.registerTool(makeNotepadTool({ state }));
	if (TEAM_ENABLED) {
		pi.registerTool(makeTeamTool({
			state,
			onChange: (ctx) => renderTeamWidget(ctx),
			// async-bash style: a background hyperplan job pings the model on
			// completion instead of the model polling. Steer when busy so the note
			// interrupts the current turn; immediate when idle.
			notify: (note) => {
				try {
					// steer interrupts the current turn when busy; when idle, delivery is
					// immediate regardless of deliverAs (same contract async-bash relies on).
					pi.sendUserMessage(note, { deliverAs: "steer" });
				} catch { /* host torn down — ignore */ }
			},
		}));
	}

	/** Snapshot the goals state into a branch-correct custom entry so /fork + /tree
	 * keep separate ledgers (the flat goals.json follows whichever branch is restored). */
	function snapshotGoals(goals: { goals: unknown[]; current_goal_id: string | null }): void {
		pi.appendEntry(HARNESS.goalsEntryType, goals);
	}

	/** Snapshot events.jsonl into a branch-correct custom entry (M2 fix: /fork isolation).
	 * Only stores the last 200 events to avoid O(n²) session bloat (TS audit C1). */
	async function snapshotEvents(): Promise<void> {
		try {
			const events = await state.readJsonl<unknown>("ledger/events.jsonl");
			// Cap at last 200 events to prevent unbounded growth in session entries
			const capped = events.slice(-200);
			pi.appendEntry(HARNESS.eventsEntryType, { events: capped });
		} catch { /* empty or missing is fine */ }
	}

	/** Per-stage artifact persistence: save a snapshot of phase-relevant data at each transition. */
	async function saveStageArtifact(phase: Phase): Promise<void> {
		try {
			const ts = new Date().toISOString();
			const artifact: Record<string, unknown> = { phase, ts };

			switch (phase) {
				case "INTERVIEW": {
					// Save interview state if available
					const iv = await state.readTokyoJson("specs/interview-state.json").catch(() => null);
					if (iv?.ok) artifact.interview_state = iv.value;
					break;
				}
				case "PLAN": {
					// Save plan mode + any existing plan reference
					artifact.plan_mode = planMode;
					const events = await state.readJsonl<{ type?: string; path?: string }>("ledger/events.jsonl").catch(() => []);
					const lastPlan = [...events].reverse().find((e) => e.type === "plan_saved");
					if (lastPlan) artifact.plan_path = lastPlan.path;
					break;
				}
				case "EXECUTE": {
					// Save goals snapshot
					const goals = await readGoals(state).catch(() => null);
					if (goals) {
						artifact.total_goals = goals.goals.length;
						artifact.completed = goals.goals.filter((g) => g.status === "complete").length;
						artifact.active = goals.goals.filter((g) => g.status === "active").length;
					}
					break;
				}
				case "VERIFY": {
					artifact.all_goals_settled = true; // we only reach VERIFY when goals are done
					break;
				}
				case "REVIEW":
				case "DONE":
					break;
				default:
					break;
			}

			await state.appendJsonl("ledger/stage-artifacts.jsonl", artifact, {
				audit: { category: "artifact", verb: `stage_${phase.toLowerCase()}`, skill: "workflow" },
			});
		} catch { /* best-effort */ }
	}

	/**
	 * Build the durable work context (latest plan + open goals) from disk, injected
	 * each turn-batch in EXECUTE/VERIFY/REVIEW so the plan survives compaction/resume.
	 */
	async function buildWorkContext(): Promise<string> {
		const parts: string[] = [];
		// latest plan artifact
		try {
			const events = await state.readJsonl<{ type?: string; path?: string }>("ledger/events.jsonl");
			const lastPlan = [...events].reverse().find((e) => e.type === "plan_saved" && typeof e.path === "string");
			if (lastPlan?.path) {
				// plan is markdown (text); read it raw.
				const abs = state.resolveTarget(lastPlan.path);
				const fsmod = await import("node:fs");
				if (fsmod.existsSync(abs)) {
					const text = fsmod.readFileSync(abs, "utf8");
					parts.push(`[APPROVED PLAN — ${lastPlan.path}]\n${text.slice(0, 6000)}`);
				}
			}
		} catch {
			/* no plan yet */
		}
		// open goals
		try {
			const goals = await readGoals(state);
			if (goals.goals.length > 0) {
				const lines = goals.goals.map(
					(g) => `- [${g.id}] ${g.status === "complete" ? "✓" : g.status === "dropped" ? "✗" : "○"} ${g.objective}`,
				);
				parts.push(`[GOAL LEDGER]\n${lines.join("\n")}`);
			}
		} catch {
			/* no goals yet */
		}
		// Interview state (for compaction survival in INTERVIEW phase)
		try {
			const interviewRes = await state.readTokyoJson("specs/interview-state.json");
			if (interviewRes?.ok && interviewRes.value) {
				const iv = interviewRes.value as { scores?: unknown; ambiguity?: number; threshold?: number; weakestDimension?: string; clear?: boolean; rationale?: string };
				if (iv.scores && typeof iv.ambiguity === "number") {
					parts.push(`[INTERVIEW PROGRESS (persisted)]\nScores: ${JSON.stringify(iv.scores)}\nAmbiguity: ${(iv.ambiguity * 100).toFixed(1)}% (threshold: ${((iv.threshold ?? 0.2) * 100).toFixed(0)}%)\nWeakest: ${iv.weakestDimension ?? "unknown"}\nCleared: ${iv.clear ? "yes" : "no"}${iv.rationale ? `\nLast rationale: ${iv.rationale}` : ""}`);
				}
			}
		} catch { /* no interview state */ }
		// Cross-session memory
		try {
			const memories = await readMemories(state);
			if (memories.length > 0) {
				const lines = memories.map((m) => `- [${m.category}] ${m.key}: ${m.value}`);
				parts.push(`[CROSS-SESSION MEMORY (${memories.length} entries)]\n${lines.join("\n")}`);
			}
		} catch { /* no memories */ }
		return parts.join("\n\n");
	}

	// ---- harness behavior (all gated on `active`) --------------------------

	pi.on("before_agent_start", async (_event, _ctx) => {
		if (!active) return;
		const contract = phaseContract(machine.current, planMode);
		if (!contract) return;
		// In EXECUTE/VERIFY/REVIEW, re-inject the durable plan + open goals from disk
		// every turn-batch so the working context survives compaction and resume
		// (the model never relies on conversation memory for the plan).
		let workContext = "";
		if (machine.current === "EXECUTE" || machine.current === "VERIFY" || machine.current === "REVIEW") {
			try {
				workContext = await buildWorkContext();
			} catch {
				/* best-effort */
			}
		}
		return {
			message: {
				customType: `${HARNESS.name}-phase-context`,
				content: workContext ? `${contract}\n\n${workContext}` : contract,
				display: false,
			},
		};
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!active) return;
		// Phase policy gate (mutation bar + read-only bash).
		const decision = evaluateToolCall(
			machine.policy(),
			{ toolName: event.toolName, input: event.input },
			machine.current,
		);
		if (decision.block) {
			return { block: true, reason: decision.reason };
		}
		// Model gate (tokyo only): when the harness is active, spawn_subagents must
		// NOT set a model directly — the harness resolves the correct model from the
		// agent's category in tokyo config (global ~/.tokyo/config.json or project
		// .tokyo/config.json). Use agent names (tokyo-reviewer, tokyo-architect, …)
		// and omit the `model` field; the harness injects the right category model.
		// "current" is the only allowed model value (parent's model).
		if (event.toolName === "spawn_subagents") {
			const tasks = (event.input as { tasks?: Array<{ model?: unknown; agent?: unknown; excludeTools?: unknown[] }> } | undefined)?.tasks ?? [];
			for (const t of tasks) {
				if (t.model !== undefined && t.model !== null && t.model !== "current") {
					return {
						block: true,
						reason: `Do NOT set a model directly in spawn_subagents. Use agent names only (e.g. agent:"tokyo-reviewer"). The tokyo harness resolves the correct model from the agent's category in ~/.tokyo/config.json. Remove the "model" field or set it to "current".`,
					};
				}
			}
			// Phase gate: in read-only phases, force subagents to also be read-only.
			if (!machine.policy().mutationsAllowed) {
				const MUTATION_TOOLS = ["write", "edit", "apply_patch"];
				for (const t of tasks) {
					const existing = (t.excludeTools ?? []) as string[];
					(t as any).excludeTools = [...new Set([...existing, ...MUTATION_TOOLS])];
				}
			}
		}
		// Path guard (independent of phase): never let write/edit OR bash bypass the
		// StateWriter by mutating .tokyo/ directly (gate G1).
		const rawPath = (event.input as { path?: unknown } | undefined)?.path;
		if (typeof rawPath === "string") {
			// resolve + realpath the parent so a symlink into .tokyo/ can't slip past.
			let resolved = nodePath.resolve(ctx.cwd, rawPath);
			try {
				const fsmod = await import("node:fs");
				const dir = nodePath.dirname(resolved);
				if (fsmod.existsSync(dir)) resolved = nodePath.join(fsmod.realpathSync(dir), nodePath.basename(resolved));
			} catch {
				/* use logical path */
			}
			const guard = guardsDotDirWrite(event.toolName, resolved, state.stateRoot, nodePath.sep);
			if (guard.block) return { block: true, reason: guard.reason };
		}
		// Bash dot-dir mutation guard (phase-independent): block shell writes into
		// .tokyo/ so the model can't forge harness state via a redirect.
		if (event.toolName === "bash") {
			const cmd = (event.input as { command?: unknown } | undefined)?.command;
			const bguard = guardsDotDirBash("bash", typeof cmd === "string" ? cmd : undefined, HARNESS.dotDir);
			if (bguard.block) return { block: true, reason: bguard.reason };
		}
		return;
	});

	pi.on("agent_end", async (event, ctx) => {
		if (!active) return;
		// Raw tool-call leak guard: models sometimes emit tool syntax as TEXT
		// (e.g. "<invoke name=...>" / "<function_calls>") instead of making a real
		// tool call. Detect it in the final assistant text and nudge a redo so the
		// run self-corrects (critical for unattended/auto mode).
		try {
			const msgs = (event as { messages?: unknown[] } | undefined)?.messages ?? [];
			const lastText = extractLastAssistantText(msgs);
			if (lastText && looksLikeRawToolCall(lastText)) {
				const nudge =
					"You just emitted tool-call syntax as plain TEXT (e.g. <invoke>/<function_calls>) instead of actually calling the tool. " +
					"That does nothing. Re-do it as a REAL tool call now — do not print the tool syntax as text.";
				if (ctx.isIdle()) pi.sendUserMessage(nudge);
				else pi.sendUserMessage(nudge, { deliverAs: "steer" });
				return; // don't also run the continuation loop this round
			}
		} catch { /* detection is best-effort */ }
		// Continuation loop: only EXECUTE auto-continues, driven by durable goal state.
		// Read the ledger, decide, and fire-and-forget the next prompt (never await
		// idle from an event handler — see pi-capabilities §2).
		let goals: Awaited<ReturnType<typeof readGoals>>;
		try {
			goals = await readGoals(state);
		} catch {
			return;
		}
		// Ledger event count is the durable-progress signal for the loop's dedup guard.
		let ledgerEventCount = 0;
		try {
			ledgerEventCount = (await state.readJsonl("ledger/events.jsonl")).length;
		} catch {
			/* no ledger yet */
		}
		const decision = decideContinuation(machine.current, goals, cont, ledgerEventCount);
		if (decision.action === "stop") {
			// AUTO-ADVANCE: in autonomous mode, when EXECUTE finishes because all goals
			// are settled, don't just stop — drive the workflow forward to VERIFY so an
			// unattended run completes EXECUTE→VERIFY→REVIEW→DONE on its own.
			// But FIRST: check that completed goals actually have verification evidence
			// (not just self-declared). No evidence → nudge to run tokyo_verify instead.
			if (autoMode && machine.current === "EXECUTE" && decision.reason === "all goals settled") {
				const completedGoals = goals.goals.filter((g: any) => g.status === "complete");
				const evidenceOk = completedGoals.length > 0 &&
					completedGoals.every((g: any) => g.receipt?.evidence?.some((e: any) => e.status === "passed" || e.status === "verified"));
				if (!evidenceOk) {
					const nudge = "All goals settled but some lack verified evidence. Run tokyo_verify (build/tests + reviewer verdict) for each completed goal before advancing to VERIFY.";
					if (ctx.isIdle()) pi.sendUserMessage(nudge);
					else pi.sendUserMessage(nudge, { deliverAs: "followUp" });
					return;
				}
				const res = await requestTransition("VERIFY", ctx);
				if (res.ok) {
					syncStatus(ctx);
					syncActiveTools();
					persistPhase();
					const nudge =
						"All goals settled — auto-advanced to VERIFY. Run tokyo_verify (build/tests + reviewer verdict) to record evidence, then advance to REVIEW.";
					if (ctx.isIdle()) pi.sendUserMessage(nudge);
					else pi.sendUserMessage(nudge, { deliverAs: "followUp" });
				}
				return;
			}
			// STOP-HOOK PREVENTION: if we're stopping due to dedup (no progress) but
			// active goals remain, give one final nudge before truly stopping.
			const activeRemain = goals.goals.some((g) => g.status === "active");
			if (activeRemain && machine.current === "EXECUTE" && decision.reason?.includes("no durable progress")) {
				if (cont.iterations < 48) {
					// Give one nudge before truly stopping
					const nudge = `You appear stuck — no ledger progress since last prompt. Active goals remain. Either:\n` +
						`1. Make concrete progress (run a command, edit a file, complete a goal)\n` +
						`2. If blocked, use tokyo_goal op:"block" with a reason\n` +
						`3. If the goal needs splitting, use tokyo_goal op:"split"\n` +
						`Do NOT stop without resolving all active goals.`;
					cont = { iterations: cont.iterations + 1, lastSignature: "" };
					pi.appendEntry(HARNESS.contEntryType, cont);
					if (ctx.isIdle()) pi.sendUserMessage(nudge);
					else pi.sendUserMessage(nudge, { deliverAs: "followUp" });
					return;
				} else {
					// BLOCKER ESCALATION: nudge failed, auto-block the current goal
					const currentGoal = goals.goals.find((g: any) => g.status === "active");
					if (currentGoal) {
						(currentGoal as any).status = "blocked";
						(currentGoal as any).blocked_reason = "auto-escalated: no progress after repeated attempts";
						currentGoal.updated_at = new Date().toISOString();
						void state.writeJsonAtomic("ledger/goals.json", goals, {
							audit: { category: "state", verb: "goal_auto_block", skill: "execute" },
						}).catch(() => {});
						ctx.ui.notify(`⚠️ Goal [${currentGoal.id}] auto-blocked: no progress after ${cont.iterations} attempts. Needs user decision.`, "warning");
					}
				}
			}
			if (process.env.TOKYO_DEBUG === "1") {
				process.stderr.write(`[${HARNESS.name}] continuation stop: ${decision.reason}\n`);
			}
			return;
		}
		cont = { iterations: cont.iterations + 1, lastSignature: decision.signature };
		pi.appendEntry(HARNESS.contEntryType, cont);
		if (ctx.isIdle()) {
			pi.sendUserMessage(decision.prompt);
		} else {
			pi.sendUserMessage(decision.prompt, { deliverAs: "followUp" });
		}
	});

	// Stop team workers via orchestrator IPC when the session ends.
	// so a `while true` worker loop never outlives the pi process. The worker
	// runner also self-terminates via a manifest watchdog as a backstop.
	pi.on("session_shutdown", async () => {
		try {
			teardownAllTeams();
		} catch {
			/* best-effort cleanup */
		}
	});
}
