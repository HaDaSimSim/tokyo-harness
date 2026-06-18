/**
 * Tokyo phase machine (pure: no fs, no pi API).
 *
 * The workflow spine:
 *   IDLE → INTERVIEW → PLAN → (consent) → EXECUTE → VERIFY → DONE
 *
 * - IDLE: harness active but no workflow engaged. Behaves like plain pi (full tools)
 *   until the user enters a workflow.
 * - INTERVIEW / PLAN: read-only, mutation-barred (the clarity + feasibility gates).
 * - EXECUTE: full tool access (the consent gate, enforced at the PLAN→EXECUTE call
 *   site in STEP 5, is what unlocks this).
 * - VERIFY: run tests / inspect, but no source mutations; a failure transitions back
 *   to EXECUTE rather than silently patching.
 * - DONE: workflow complete; read-only until a new workflow starts.
 *
 * This module defines the phases, the legal transition graph, and the per-phase
 * tool policy. The consent requirement on PLAN→EXECUTE is a transition flag here;
 * the actual user-consent prompt is wired in STEP 5.
 */

export const PHASES = ["IDLE", "INTERVIEW", "RESEARCH", "PLAN", "EXECUTE", "VERIFY", "REVIEW", "DONE"] as const;
export type Phase = (typeof PHASES)[number];

export function isPhase(value: unknown): value is Phase {
	return typeof value === "string" && (PHASES as readonly string[]).includes(value);
}

/**
 * Legal transition graph. A transition not listed here is rejected by the machine.
 * `consent` marks edges that additionally require explicit user approval (wired in
 * STEP 5); the graph still permits the edge, but the runtime must obtain consent
 * before taking it.
 */
interface Edge {
	to: Phase;
	consent?: boolean;
}

const TRANSITIONS: Record<Phase, Edge[]> = {
	// IDLE is the sisyphus default: direct-execute, verify, done.
	// Pipeline entry (INTERVIEW) is manual-only via user slash commands.
	IDLE: [{ to: "INTERVIEW" }],
	// Interview can branch into research (clone/analysis) or straight to plan.
	INTERVIEW: [{ to: "RESEARCH" }, { to: "PLAN" }, { to: "IDLE" }],
	// Research feeds the plan; can loop back to interview for more clarity.
	RESEARCH: [{ to: "PLAN" }, { to: "INTERVIEW" }, { to: "IDLE" }],
	// Plan unlocks execute with consent; can return to interview/research to re-clarify.
	PLAN: [{ to: "EXECUTE", consent: true }, { to: "INTERVIEW" }, { to: "RESEARCH" }, { to: "IDLE" }],
	// Execute can go to verify, OR back to plan to re-plan mid-flight (state kept).
	EXECUTE: [{ to: "VERIFY" }, { to: "PLAN" }, { to: "IDLE" }],
	// Verify success advances to REVIEW; failure routes back to EXECUTE.
	VERIFY: [{ to: "REVIEW" }, { to: "EXECUTE" }, { to: "IDLE" }],
	// Review is the user checkpoint: accept (DONE, consent-gated) or iterate back.
	REVIEW: [{ to: "DONE", consent: true }, { to: "PLAN" }, { to: "EXECUTE" }, { to: "INTERVIEW" }, { to: "IDLE" }],
	// A finished workflow can start a fresh one.
	DONE: [{ to: "INTERVIEW" }, { to: "IDLE" }],
};

export function canTransition(from: Phase, to: Phase): boolean {
	if (from === to) return true; // idempotent no-op
	return TRANSITIONS[from].some((e) => e.to === to);
}

/** Does the given transition require explicit user consent before being taken? */
export function transitionRequiresConsent(from: Phase, to: Phase): boolean {
	return TRANSITIONS[from].some((e) => e.to === to && e.consent === true);
}

/** Legal next phases from `from` (excludes the idempotent self-edge). */
export function nextPhases(from: Phase): Phase[] {
	return TRANSITIONS[from].map((e) => e.to);
}

// ---- per-phase tool policy ----------------------------------------------------

export interface ToolPolicy {
	/** Whether the model's mutation tools (edit/write) are permitted. */
	mutationsAllowed: boolean;
	/**
	 * Bash policy:
	 *   - "full": any command runs.
	 *   - "readonly": only allowlisted non-destructive commands run (write-bash,
	 *     redirects, package installs, git mutations, etc. are blocked).
	 *   - "research": readonly + the fetch commands clone-coding/analysis needs
	 *     (git clone/fetch, shallow checkout) so RESEARCH can pull a reference repo.
	 */
	bash: "full" | "readonly" | "research";
}

/** Tool names treated as mutations (removed from the active set when barred). */
export const MUTATION_TOOLS = ["edit", "write"] as const;

export const PHASE_POLICY: Record<Phase, ToolPolicy> = {
	IDLE: { mutationsAllowed: true, bash: "full" },
	INTERVIEW: { mutationsAllowed: false, bash: "full" },
	// RESEARCH investigates; edit/write are still barred by mutationsAllowed:false.
	// bash is full so MCP and other tooling works unrestricted.
	RESEARCH: { mutationsAllowed: false, bash: "full" },
	PLAN: { mutationsAllowed: false, bash: "full" },
	EXECUTE: { mutationsAllowed: true, bash: "full" },
	// VERIFY runs the test/inspect suite (full bash) but bars source mutations:
	// a failing verification routes back to EXECUTE instead of patching in place.
	VERIFY: { mutationsAllowed: false, bash: "full" },
	// REVIEW is the user checkpoint: read-only while awaiting the user's verdict.
	REVIEW: { mutationsAllowed: false, bash: "full" },
	DONE: { mutationsAllowed: false, bash: "full" },
};

// ---- planning depth (harness-driven, asked at PLAN entry) ---------------------

/**
 * How deep the PLAN phase goes. Chosen by the user when entering PLAN (the harness
 * asks); drives which plan contract is injected. hyperplan is a first-class
 * harness process here, not an optional skill.
 */
export type PlanMode = "quick" | "consensus" | "adversarial";

export const PLAN_MODES: PlanMode[] = ["quick", "consensus", "adversarial"];

export function isPlanMode(v: unknown): v is PlanMode {
	return typeof v === "string" && (PLAN_MODES as string[]).includes(v);
}

export const PLAN_MODE_LABELS: Record<PlanMode, string> = {
	quick: "Quick — draft the plan directly (small/clear tasks)",
	consensus: "Consensus — planner drafts, architect + critic review and iterate",
	adversarial: "Adversarial (hyperplan) — 5 hostile members cross-critique, then formalize",
};

// ---- per-phase system-prompt contract ----------------------------------------

/**
 * The phase contract injected into the system prompt each turn-batch via
 * `before_agent_start`. Returns null for phases that need no injection (IDLE).
 * For PLAN, pass the chosen PlanMode to get the matching planning contract.
 */
export function phaseContract(phase: Phase, planMode: PlanMode = "consensus"): string | null {
	switch (phase) {
		case "IDLE":
			return `[TOKYO — IDLE (SISYPHUS)]
You are in Tokyo's default direct-execution mode. No pipeline, no ceremony.

CORE RULE: Do the task. Verify it. Show evidence. Done.

EXECUTION:
- Execute directly. Do NOT over-plan, over-escalate, or over-narrate.
- The pipeline (INTERVIEW→PLAN→EXECUTE) is MANUAL ONLY — never call tokyo_phase unless the user explicitly commands it. If a task seems too large, just break it into the smallest clear deliverable and do that first.
- Full tool access (edit/write/bash) is yours.

COMPLETION: When done, present a compact summary:
## Changes Made
- \`path/to/file:line-range\` — concise description

## Verification
- \`[command]\` → \`[result]\`

## Summary
- 1-2 sentence outcome statement.

No evidence = not complete. No ceremony = no plan doc, no consent gate, no goal ledger.
Just: do → verify → report.`;
		case "INTERVIEW":
			return `[TOKYO — INTERVIEW PHASE]
You are interviewing the user to remove ambiguity before any plan or code exists.
- READ-ONLY: edit and write are disabled; bash is restricted to read-only commands.
- Ask focused clarifying questions (one thread at a time). Do NOT propose code yet.
- EXPLICITLY ask, when relevant, whether this task needs a RESEARCH step first — e.g. cloning/mimicking an existing app or service, or analyzing an unfamiliar codebase. If so, advance with tokyo_phase to RESEARCH before planning.
- Score clarity with tokyo_ambiguity after each answer; it auto-advances to PLAN when ambiguity drops below the active threshold (or you can go to RESEARCH first).`;
		case "RESEARCH":
			return `[TOKYO — RESEARCH PHASE]
You are investigating the target before planning: clone-coding a reference, or analyzing an existing codebase/service.
- READ-ONLY: edit and write are disabled; bash is restricted to read-only commands.
- Delegate investigation to the explore agent via spawn_subagents (parallel scouts for independent areas) to keep the main context lean; read key files yourself only as needed.
- Capture durable findings with tokyo_spec_save (kind: 'research') so the analysis survives compaction and feeds the plan: architecture, key files, patterns, data flow, external references, and open questions.
- When you understand the target well enough, advance with tokyo_phase to PLAN (or back to INTERVIEW if new questions surfaced).`;
		case "PLAN":
			return planContract(planMode);
		case "EXECUTE":
			return `[TOKYO — EXECUTE PHASE]
The plan is approved. Full tool access is enabled.
- Execute the approved plan using its parallelization map. Create one tokyo_goal per step.
- FAN OUT independent work: when the current batch has multiple steps with no unmet dependency and disjoint files, dispatch them concurrently — spawn_subagents for self-contained edit/build/test units, or tokyo_team workers when a persistent team is up. You are the integrator: claim/seed goals, hand each parallel unit a self-contained brief, then verify and complete goals with tokyo_complete + real evidence as results land.
- Respect dependencies: never start a step whose prerequisites are unsettled, and never run two units that write the same file concurrently (the plan's map flags shared-file conflicts — serialize those).
- Stay within the agreed scope. If the plan turns out wrong, return with tokyo_phase to PLAN to re-plan (your completed goals are preserved) rather than improvising out of scope.
- Verify as you go (run the relevant tests/build after each meaningful change), and when all goals are settled, move to VERIFY for the final check.`;
		case "VERIFY":
			return `[TOKYO — VERIFY PHASE]
Verify the work against the plan's acceptance criteria.
- Run builds/tests and inspect results (full bash) but do NOT edit source here.
- If verification fails, return to EXECUTE to fix; do not patch silently in VERIFY.
- When everything passes, advance with tokyo_phase to REVIEW (this records verification evidence and hands off to the user checkpoint).`;
		case "REVIEW":
			return `[TOKYO — REVIEW PHASE]
The work is built and verified. This is the user checkpoint.
- READ-ONLY: present a concise summary of what changed, the verification evidence, and anything the user should look at.
- STOP and wait for the user's verdict. If they request changes, advance with tokyo_phase back to PLAN (re-plan), EXECUTE (direct fix), or INTERVIEW (re-clarify) — prior goals/plan are preserved, so this is an iteration, not a restart.
- Only advance to DONE when the user accepts the result.`;
		case "DONE":
			return `[TOKYO — DONE]
The workflow is complete. Start a new workflow (INTERVIEW) before further changes.`;
	}
}

/** The PLAN-phase contract, parameterized by the chosen planning depth. */
function planContract(mode: PlanMode): string {
	const common = `[TOKYO — PLAN PHASE]
You are producing an explicit, reviewable plan. No product code is written here.
- READ-ONLY: edit and write are disabled; bash is restricted to read-only commands.
- When the plan is final, save it with tokyo_plan_save, then advance with tokyo_phase to EXECUTE (this prompts the user for consent). Execution is barred until they approve.
- The plan MUST include a parallelization map: group steps into ordered batches, where steps within a batch are independent (disjoint files, no ordering constraint) and can run concurrently in EXECUTE, while cross-batch dependencies are explicit. This is what lets EXECUTE fan work out across subagents/team workers — a flat checklist forfeits that.
- tokyo_plan_save REQUIRES a structured goals list (the plan's task DAG). EVERY code goal must declare the files it will write. Goals without files are REJECTED at plan-save time — you cannot save a plan that doesn't know which files it touches. (Non-code goals like docs/README/config may use an empty files array.) Provide the goals list as the second argument alongside the markdown plan body.`;
	switch (mode) {
		case "quick":
			return `${common}

PLANNING DEPTH: QUICK.
- Draft the plan yourself: summary, file-level changes, sequencing, acceptance criteria, verification, risks, and a brief parallelization map (which steps are independent vs ordered).
- Right-size it; a small task does not need ceremony. You may sanity-check with spawn_subagents → critic if unsure, but it is optional.`;
		case "consensus":
			return `${common}

PLANNING DEPTH: CONSENSUS.
- Delegate plan authoring to the planner agent via spawn_subagents (give it the full clarified spec; it has no prior context). The planner returns a parallelization map (batches of independent steps) — preserve it through review so EXECUTE can fan out.
- Then delegate review to architect and vetting to critic (you may run them in one parallel spawn_subagents call).
- Iterate (max ~5 passes): consolidate their feedback, re-delegate to planner, re-review, until critic returns OKAY and architect is not BLOCK.
- Keep the main context lean — let the subagents do the heavy thinking.`;
		case "adversarial":
			return `${common}

PLANNING DEPTH: ADVERSARIAL (HYPERPLAN). This is a built-in harness process — run it directly, do not wait to be told.
1. Announce "HYPERPLAN ENGAGED" once. Restate the request in one sentence.
2. tokyo_team op:"create" team:"hyperplan" preset:"hyperplan" — spawn the 5 hostile members as live worker processes via the orchestrator. Confirm it reports "created via orchestrator with 5 persistent worker(s)" (NOT "no live orchestrator"). If it says no orchestrator, you're not in a real tokyo session — stop and tell the user to relaunch via the 'tokyo' CLI.
3. tokyo_team op:"hyperplan_run" team:"hyperplan" objective:"<the full clarified request>" — starts the 3-round adversarial process (5 members × 3 rounds) as a BACKGROUND job and returns a job_id immediately. It does NOT block.
4. WAIT for the ping. You'll get a '[hyperplan <id> done]' notification automatically when the rounds finish — do NOT poll, do NOT sleep, do NOT fabricate the rounds. Keep working or end your turn; the harness wakes you. When pinged, retrieve the result with tokyo_team op:"hyperplan_poll" team:"hyperplan" job_id:"<id>".
5. DISTILL (you, the Lead): from the result, bucket into Hard constraints / Decisions / Risks+mitigations / Open questions. Keep only what survived all 3 rounds.
6. MANDATORY handoff: spawn_subagents → planner with the distilled bundle to produce the executable plan (every constraint respected, every risk mitigated, every open question a user-input gate, every step with success criteria). Present it verbatim with a provenance line.
7. tokyo_plan_save, then advance to EXECUTE for consent.
- Do NOT soften the members' hostility, skip rounds, or write the plan yourself before the planner handoff.
- If the orchestrator is not running (create/run/poll fails), fall back to consensus mode — do NOT role-play the rounds inline.`;
	}
}

// ---- the machine --------------------------------------------------------------

export interface TransitionResult {
	ok: boolean;
	from: Phase;
	to: Phase;
	/** True when the transition is legal but needs consent the caller must supply. */
	needsConsent: boolean;
	error?: string;
}

/**
 * Minimal in-memory phase holder with validated transitions. Holds no I/O; the
 * runtime (index.ts) persists/restores `current` and reacts to transitions.
 */
export class PhaseMachine {
	private _current: Phase;

	constructor(initial: Phase = "IDLE") {
		this._current = initial;
	}

	get current(): Phase {
		return this._current;
	}

	policy(): ToolPolicy {
		return PHASE_POLICY[this._current];
	}

	/**
	 * Attempt a transition. Returns a result describing legality and whether
	 * consent is still required. When `withConsent` is false and the edge needs
	 * consent, the transition is NOT applied and `needsConsent` is true.
	 */
	transition(to: Phase, opts?: { withConsent?: boolean }): TransitionResult {
		const from = this._current;
		if (!canTransition(from, to)) {
			return { ok: false, from, to, needsConsent: false, error: `illegal transition ${from} → ${to}` };
		}
		const needsConsent = transitionRequiresConsent(from, to);
		if (needsConsent && !opts?.withConsent) {
			return { ok: false, from, to, needsConsent: true, error: `transition ${from} → ${to} requires consent` };
		}
		this._current = to;
		return { ok: true, from, to, needsConsent };
	}

	/** Force the current phase without transition validation (restore from disk). */
	restore(phase: Phase): void {
		this._current = phase;
	}

	reset(): void {
		this._current = "IDLE";
	}
}
