/**
 * State-backed tokyo tools: tokyo_plan_save (STEP 5), tokyo_goal + tokyo_complete (STEP 6).
 *
 * These are the tools that durably mutate `.tokyo/` — all routed through the
 * StateWriter (the sole sanctioned writer, gate G1). Factory style: index.ts
 * injects a single StateWriter instance + phase hooks.
 *
 * Plan artifacts → `.tokyo/plans/`. Goal ledger → `.tokyo/ledger/`. Completion is
 * evidence-gated: a goal can only be completed with a hash-bound receipt whose
 * checkpoint event is appended to the ledger (see STEP 6 design / gjc-workflow §4-5).
 */
import { createHash, randomUUID } from "node:crypto";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { StateWriter } from "../state/index.ts";
import type { AuditCategory } from "../state/schema.ts";
import {
	allGoalsSettled,
	buildReceipt,
	type EvidenceItem,
	type Goal,
	type GoalsState,
	emptyGoalsState,
	type LedgerEvent,
	nextActiveGoal,
	type Phase,
	validateReceipt,
	verifyCompletionFromDisk,
} from "../workflow/index.ts";

function sha256(s: string): string {
	return createHash("sha256").update(s, "utf8").digest("hex");
}

function slugify(s: string): string {
	return (
		s
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 48) || "plan"
	);
}

// ---- tokyo_spec_save (interview + research artifacts) -------------------------

const SpecSaveParams = Type.Object({
	kind: Type.Union([Type.Literal("interview"), Type.Literal("research")], {
		description: "interview = clarified spec (goal/constraints/criteria); research = investigation findings.",
	}),
	title: Type.String({ description: "Short title (used for the artifact slug)." }),
	body: Type.String({ description: "The full markdown. For interview: clarified goal, constraints, success criteria, context, open questions. For research: architecture, key files, patterns, data flow, external references, open questions." }),
});

interface SpecSaveDetails {
	kind: string;
	path: string;
	sha256: string;
	slug: string;
}

export interface SpecSaveHooks {
	state: StateWriter;
	getPhase: () => Phase;
}

export function makeSpecSaveTool(hooks: SpecSaveHooks): ToolDefinition<typeof SpecSaveParams, SpecSaveDetails> {
	return {
		name: "tokyo_spec_save",
		label: "Tokyo Spec Save",
		description: [
			"Persist a durable interview spec or research findings artifact under .tokyo/specs/.",
			"This is the ONLY sanctioned way to write a spec file (atomic + checksummed + audited).",
			"Save the clarified spec at the end of INTERVIEW and research findings during RESEARCH so the",
			"clarity survives compaction/resume and feeds the planner (it has no prior context).",
		].join(" "),
		parameters: SpecSaveParams,
		promptGuidelines: [
			"Save an interview spec with tokyo_spec_save(kind:interview) before leaving INTERVIEW.",
			"Save research findings with tokyo_spec_save(kind:research) during RESEARCH.",
		],
		async execute(_id, params, _signal, _onUpdate, _ctx): Promise<AgentToolResult<SpecSaveDetails>> {
			const phase = hooks.getPhase();
			if (phase !== "INTERVIEW" && phase !== "RESEARCH") {
				return {
					content: [{ type: "text", text: `tokyo_spec_save is only valid in INTERVIEW or RESEARCH (current: ${phase}).` }],
					details: { kind: params.kind, path: "", sha256: "", slug: "" },
					isError: true,
				} as AgentToolResult<SpecSaveDetails>;
			}
			const slug = slugify(params.title);
			const ts = new Date().toISOString();
			const checksum = sha256(params.body);
			const rel = `specs/${params.kind}-${slug}.md`;
			const doc = [
				`# ${params.kind === "interview" ? "Spec" : "Research"}: ${params.title}`,
				"",
				`> kind: ${params.kind}`,
				`> saved: ${ts}`,
				`> sha256: ${checksum}`,
				"",
				params.body.trim(),
				"",
			].join("\n");
			try {
				const absPath = await hooks.state.writeTextAtomic(rel, doc, {
					audit: { category: "artifact", verb: `save_${params.kind}`, skill: params.kind, owner: "tokyo-runtime" },
				});
				await traceEvent(hooks.state,
					{ ts, type: `${params.kind}_saved`, slug, sha256: checksum, path: rel },
					{ category: "ledger", verb: `${params.kind}_saved`, skill: params.kind },
				);
				return {
					content: [{ type: "text", text: `Saved ${params.kind} spec: ${rel}\nsha256: ${checksum}` }],
					details: { kind: params.kind, path: absPath, sha256: checksum, slug },
				};
			} catch (err) {
				return {
					content: [{ type: "text", text: `Failed to save spec: ${(err as Error).message}` }],
					details: { kind: params.kind, path: "", sha256: checksum, slug },
					isError: true,
				} as AgentToolResult<SpecSaveDetails>;
			}
		},
	};
}

// ---- tokyo_plan_save (STEP 5) -------------------------------------------------

const PlanSaveParams = Type.Object({
	title: Type.String({ description: "Short plan title (used for the artifact slug)." }),
	plan: Type.String({ description: "The full final plan markdown (post-consensus). Include the ADR." }),
	acceptance_criteria: Type.Optional(
		Type.Array(Type.String(), { description: "Testable acceptance criteria; each becomes a checkable item." }),
	),
	/**
	 * Structured goal list — the plan's task DAG, not the markdown summary.
	 * Every goal in this list is auto-registered in the goal ledger on save,
	 * so EXECUTE starts with the full structure already wired. The plan-save
	 * gate REJECTS any goal that lacks files: you can't plan code without
	 * knowing which files you'll touch. (Non-code goals like docs/config are
	 * exempt — mark them with an empty array or a single non-source file.)
	 */
	goals: Type.Optional(
		Type.Array(
			Type.Object({
				objective: Type.String({ description: "What this goal achieves (testable wording)." }),
				files: Type.Array(Type.String(), { description: "Files this goal will WRITE (every code goal MUST list them). Must be non-empty for code goals." }),
				depends_on: Type.Optional(Type.Array(Type.Union([Type.String(), Type.Number()]), { description: "Goal indices (0-based) or IDs this one depends on." })),
			}),
			{ description: "Structured goal DAG. Each entry is a goal to auto-register on plan save. depends_on uses 0-based indices." },
		),
	),
});

interface PlanSaveDetails {
	path: string;
	sha256: string;
	slug: string;
	/** Goal ids auto-registered from the structured goals list (if supplied). */
	registered_goals: string[];
}

export interface PlanSaveHooks {
	state: StateWriter;
	getPhase: () => Phase;
}

export function makePlanSaveTool(hooks: PlanSaveHooks): ToolDefinition<typeof PlanSaveParams, PlanSaveDetails> {
	return {
		name: "tokyo_plan_save",
		label: "Tokyo Plan Save",
		description: [
			"Persist the final consensus plan as a pending-approval artifact under .tokyo/plans/.",
			"This is the ONLY sanctioned way to write a plan file (atomic + checksummed + audited).",
			"Call this once the planner/architect/critic loop has converged, before requesting execution consent.",
		].join(" "),
		parameters: PlanSaveParams,
		async execute(_id, params, _signal, _onUpdate, _ctx): Promise<AgentToolResult<PlanSaveDetails>> {
			const phase = hooks.getPhase();
			if (phase !== "PLAN") {
				return {
					content: [{ type: "text", text: `tokyo_plan_save is only valid in PLAN (current: ${phase}).` }],
					details: { path: "", sha256: "", slug: "", registered_goals: [] },
					isError: true,
				} as AgentToolResult<PlanSaveDetails>;
			}
			const slug = slugify(params.title);
			const ts = new Date().toISOString();
			const checksum = sha256(params.plan);
			const body = [
				`# Plan: ${params.title}`,
				"",
				"> Status: **pending approval** — execution is barred until the user consents (PLAN→EXECUTE).",
				`> Saved: ${ts}`,
				`> sha256: ${checksum}`,
				"",
				params.plan.trim(),
				"",
				...(params.acceptance_criteria && params.acceptance_criteria.length > 0
					? ["## Acceptance Criteria", "", ...params.acceptance_criteria.map((c) => `- [ ] ${c}`)]
					: []),
				"",
			].join("\n");

			const rel = `plans/plan-${slug}.md`;
			let absPath: string;
			const registeredGoals: string[] = [];
			try {
				// ── 1. Save the plan markdown artifact ──
				absPath = await hooks.state.writeTextAtomic(rel, body, {
					audit: { category: "artifact", verb: "save_plan", skill: "plan", owner: "tokyo-runtime" },
				});
				await traceEvent(hooks.state,
					{ ts, type: "plan_saved", slug, sha256: checksum, path: rel },
					{ category: "ledger", verb: "plan_saved", skill: "plan" },
				);

				// ── 2. Auto-register structured goals (the plan's task DAG) ──
				if (params.goals && params.goals.length > 0) {
					const fileGateErrors: string[] = [];
					for (let i = 0; i < params.goals.length; i++) {
						const sg = params.goals[i];
						// File gate: every code goal needs declared files.
						// Docs/config goals are exempt (empty array is fine).
						const isNonCode = /doc(s|umentation)|readme|config|setup|infra/i.test(sg.objective);
						if (!isNonCode && (!sg.files || sg.files.length === 0)) {
							fileGateErrors.push(`goal ${i} "${sg.objective.slice(0, 60)}" has no files`);
						}
					}
					if (fileGateErrors.length > 0) {
						return {
							content: [{
								type: "text",
								text: `PLAN REJECTED — file gate: every code goal must declare the files it will write.\n${fileGateErrors.join("\n")}\n\nFix the plan and retry tokyo_plan_save.`,
							}],
							details: { path: absPath, sha256: checksum, slug, registered_goals: [] },
							isError: true,
						} as AgentToolResult<PlanSaveDetails>;
					}

					// Map index-based depends_on → real goal ids.
					const goalIds: string[] = [];
					const allGoals: Goal[] = [];
					for (const _g of params.goals) {
						const id = randomUUID().slice(0, 8);
						goalIds.push(id);
					}
					for (let i = 0; i < params.goals.length; i++) {
						const sg = params.goals[i];
						const resolvedDeps = (sg.depends_on ?? []).map((rawIdx) => {
							const idx = typeof rawIdx === "number" ? rawIdx : parseInt(String(rawIdx), 10);
							if (isNaN(idx) || idx < 0 || idx >= goalIds.length) return "__invalid__";
							return goalIds[idx]!;
						}).filter((d: string) => d !== "__invalid__");
						const goal: Goal = {
							id: goalIds[i],
							objective: sg.objective.trim(),
							status: "active",
							created_at: ts,
							updated_at: ts,
							files: sg.files,
							depends_on: resolvedDeps.length > 0 ? resolvedDeps : undefined,
						};
						allGoals.push(goal);
						registeredGoals.push(goal.id);
						await writeGoal(hooks.state, goal);
						await traceEvent(hooks.state,
							{ ts, type: "goal_created", goal_id: goal.id, objective: goal.objective, source: "plan" },
							{ category: "ledger", verb: "goal_created", skill: "plan" },
						);
					}
					// Write the goal index (first goal = current).
					await writeGoalIndex(hooks.state, allGoals, allGoals[0]?.id ?? null);
				}
			} catch (err) {
				return {
					content: [{ type: "text", text: `Failed to save plan: ${(err as Error).message}` }],
					details: { path: "", sha256: checksum, slug, registered_goals: [] },
					isError: true,
				} as AgentToolResult<PlanSaveDetails>;
			}
			const goalSummary = registeredGoals.length > 0
				? `\nRegistered ${registeredGoals.length} goal(s): ${registeredGoals.join(", ")}. Execute starts pre-wired.`
				: "";
			return {
				content: [
					{
						type: "text",
						text: `Plan saved (pending approval): ${rel}\nsha256: ${checksum}${goalSummary}\n\n${params.plan.trim()}\n\n---\nPresent it to the user, then advance with tokyo_phase to EXECUTE to request consent.`,
					},
				],
				details: { path: absPath, sha256: checksum, slug, registered_goals: registeredGoals },
			};
		},
	};
}

// ---- goals ledger helpers (STEP 6) -------------------------------------------

const GOALS_DIR = "ledger/goals";
const GOALS_INDEX = "ledger/goals-index.json";

function goalPath(id: string): string { return `${GOALS_DIR}/${id}.json`; }

const GOALS_PATH = "ledger/goals.json"; // legacy compat path, no longer primary
const EVENTS_PATH = "ledger/events.jsonl";
const TRACE_ERRORS_PATH = "ledger/trace-errors.jsonl";
const TELEMETRY_PATH = "ledger/telemetry.jsonl";
const SCHEMA_VERSION = 3;

// Active spans for duration tracking
const activeSpans = new Map<string, { start: number; event: Record<string, unknown> }>();

/** Emit a trace event with schema version + span lifecycle enrichment. */
async function traceEvent(
	state: StateWriter,
	event: Record<string, unknown>,
	audit: { category: AuditCategory; verb: string; skill: string },
	opts?: { parent_span_id?: string },
): Promise<string> {
	const span_id = randomUUID().slice(0, 8);
	const enriched = {
		schema_version: SCHEMA_VERSION,
		span_id,
		...(opts?.parent_span_id ? { parent_span_id: opts.parent_span_id } : {}),
		...event,
	};
	await state.appendJsonl(EVENTS_PATH, enriched, { audit });
	// Errors go to trace-errors
	if (event.type === "error" || event.type === "goal_blocked") {
		await state.appendJsonl(TRACE_ERRORS_PATH, enriched, { audit }).catch(() => {});
	}
	// All events also go to telemetry (separate stream for metrics/analysis)
	await state.appendJsonl(TELEMETRY_PATH, enriched, { audit }).catch(() => {});
	return span_id;
}

/** Start a span (records start time, returns span_id for later end). */
async function spanStart(
	state: StateWriter,
	event: Record<string, unknown>,
	audit: { category: AuditCategory; verb: string; skill: string },
	opts?: { parent_span_id?: string },
): Promise<string> {
	const span_id = await traceEvent(state, { ...event, span_phase: "start" }, audit, opts);
	activeSpans.set(span_id, { start: Date.now(), event });
	return span_id;
}

/** End a span (computes duration, emits end event). */
async function spanEnd(
	state: StateWriter,
	span_id: string,
	result: Record<string, unknown>,
	audit: { category: AuditCategory; verb: string; skill: string },
): Promise<void> {
	const span = activeSpans.get(span_id);
	const duration_ms = span ? Date.now() - span.start : undefined;
	activeSpans.delete(span_id);
	await traceEvent(state, { ...result, span_phase: "end", span_id, duration_ms }, audit, { parent_span_id: span_id });
}

export async function readGoals(state: StateWriter): Promise<GoalsState> {
	// Read index for goal ids + current_goal_id
	const idxRes = await state.readTokyoJson(GOALS_INDEX);
	const goalIds: string[] = [];
	let currentGoalId: string | null = null;
	if (idxRes?.ok && idxRes.value) {
		const idx = idxRes.value as { goal_ids?: string[]; current_goal_id?: string | null };
		if (Array.isArray(idx.goal_ids)) goalIds.push(...idx.goal_ids);
		currentGoalId = typeof idx.current_goal_id === "string" ? idx.current_goal_id : null;
	}
	// Fall back to legacy GOALS_PATH if index missing (migration)
	if (goalIds.length === 0) {
		const legacy = await state.readTokyoJson(GOALS_PATH);
		if (legacy?.ok && legacy.value) {
			const raw = legacy.value as unknown as GoalsState;
			if (Array.isArray(raw.goals)) {
				raw.goals = raw.goals.filter((g: any) => g && typeof g.id === "string" && typeof g.objective === "string" && typeof g.status === "string");
				return { goals: raw.goals, current_goal_id: raw.current_goal_id ?? null };
			}
		}
		return emptyGoalsState();
	}
	// Read each goal file atomically (per-file writes = no race between concurrent goal ops)
	const goals: Goal[] = [];
	for (const id of goalIds) {
		const r = await state.readTokyoJson(goalPath(id));
		if (r?.ok && r.value) goals.push(r.value as unknown as Goal);
	}
	return { goals, current_goal_id: currentGoalId };
}

export async function writeGoal(state: StateWriter, goal: Goal): Promise<void> {
	await state.writeJsonAtomic(goalPath(goal.id), goal, {
		audit: { category: "state", verb: "goal_write", skill: "execute", owner: "tokyo-runtime" },
	});
}

export async function writeGoalIndex(state: StateWriter, goals: Goal[], currentGoalId: string | null): Promise<void> {
	await state.writeJsonAtomic(GOALS_INDEX, {
		goal_ids: goals.map((g) => g.id),
		current_goal_id: currentGoalId,
	}, {
		audit: { category: "state", verb: "goal_index", skill: "execute", owner: "tokyo-runtime" },
	});
}

async function writeAllGoals(state: StateWriter, goals: Goal[], currentGoalId: string | null, _verb?: string): Promise<void> {
	for (const g of goals) await writeGoal(state, g);
	await writeGoalIndex(state, goals, currentGoalId);
}

// ---- tokyo_goal (create/list/drop) -------------------------------------------

const GoalParams = Type.Object({
	op: Type.Union([Type.Literal("create"), Type.Literal("list"), Type.Literal("drop"), Type.Literal("split"), Type.Literal("reorder"), Type.Literal("revise"), Type.Literal("block"), Type.Literal("unblock"), Type.Literal("reopen")], {
		description: "create, list, drop, split, reorder, revise, block, unblock, or reopen (reviewer rejection — resets completed goal to active).",
	}),
	objective: Type.Optional(Type.String({ description: "Objective text (required for create; new text for revise)." })),
	goal_id: Type.Optional(Type.String({ description: "Goal id (for drop/split/revise/block/unblock; defaults to current)." })),
	sub_goals: Type.Optional(Type.Array(Type.String(), { description: "For split: list of sub-goal objectives to replace the original." })),
	order: Type.Optional(Type.Array(Type.String(), { description: "For reorder: goal IDs in desired execution order." })),
	reason: Type.Optional(Type.String({ description: "For block: why this goal is blocked." })),
	files: Type.Optional(Type.Array(Type.String(), { description: "For create: files this goal writes. The claim gate serializes overlapping-file goals so they never run concurrently." })),
	depends_on: Type.Optional(Type.Array(Type.String(), { description: "For create: goal IDs that must be complete first." })),
});

interface GoalDetails {
	op: string;
	goals: Goal[];
	current_goal_id: string | null;
}

export interface GoalHooks {
	state: StateWriter;
	getPhase: () => Phase;
	/** Called with the new goals state after any mutation, for branch-correct snapshotting. */
	onGoalsChange?: (goals: GoalsState) => void;
}

export function makeGoalTool(hooks: GoalHooks): ToolDefinition<typeof GoalParams, GoalDetails> {
	return {
		name: "tokyo_goal",
		label: "Tokyo Goal",
		description: [
			"Manage the durable execution goal ledger under .tokyo/ledger/.",
			"create: register a goal to work (from the approved plan's steps).",
			"list: show all goals and their status. drop: abandon a goal.",
			"Completion is separate and evidence-gated via tokyo_complete.",
		].join(" "),
		parameters: GoalParams,
		promptGuidelines: [
			"In EXECUTE, create one tokyo_goal per plan step, then complete each with tokyo_complete + evidence.",
		],
		async execute(_id, params, _signal, _onUpdate, _ctx): Promise<AgentToolResult<GoalDetails>> {
			const goals = await readGoals(hooks.state);
			const now = new Date().toISOString();
			if (params.op === "create") {
				if (!params.objective?.trim()) {
					return errResult("create requires an objective", goals);
				}
				const goal: Goal = {
					id: randomUUID().slice(0, 8),
					objective: params.objective.trim(),
					status: "active",
					created_at: now,
					updated_at: now,
					files: params.files,
					depends_on: params.depends_on,
				};
				goals.goals.push(goal);
				goals.current_goal_id = goal.id;
				await writeAllGoals(hooks.state, goals.goals, goals.current_goal_id);
				hooks.onGoalsChange?.(goals);
				await traceEvent(hooks.state, { ts: now, type: "goal_created", goal_id: goal.id, objective: goal.objective }, { category: "ledger", verb: "goal_created", skill: "execute" });
				return okResult(`Goal created: [${goal.id}] ${goal.objective}`, "create", goals);
			}
			if (params.op === "drop") {
				const id = params.goal_id ?? goals.current_goal_id;
				const goal = goals.goals.find((g) => g.id === id);
				if (!goal) return errResult(`no goal ${id}`, goals);
				goal.status = "dropped";
				goal.updated_at = now;
				if (goals.current_goal_id === id) goals.current_goal_id = nextActiveGoal(goals)?.id ?? null;
				await writeAllGoals(hooks.state, goals.goals, goals.current_goal_id);
				hooks.onGoalsChange?.(goals);
				await traceEvent(hooks.state, { ts: now, type: "goal_dropped", goal_id: id }, { category: "ledger", verb: "goal_dropped", skill: "execute" });
				return okResult(`Goal dropped: ${id}`, "drop", goals);
			}
			if (params.op === "split") {
				const id = params.goal_id ?? goals.current_goal_id;
				const goal = goals.goals.find((g) => g.id === id);
				if (!goal) return errResult(`no goal ${id}`, goals);
				if (goal.status !== "active") return errResult(`can only split active goals (${id} is ${goal.status})`, goals);
				if (!params.sub_goals?.length) return errResult("split requires sub_goals (array of objective strings)", goals);
				// Drop the original
				goal.status = "dropped";
				goal.updated_at = now;
				// Create sub-goals
				const newIds: string[] = [];
				for (const obj of params.sub_goals) {
					const sub: Goal = { id: randomUUID().slice(0, 8), objective: obj.trim(), status: "active", created_at: now, updated_at: now };
					goals.goals.push(sub);
					newIds.push(sub.id);
				}
				goals.current_goal_id = newIds[0] ?? null;
				await writeAllGoals(hooks.state, goals.goals, goals.current_goal_id);
				hooks.onGoalsChange?.(goals);
				await traceEvent(hooks.state, { ts: now, type: "goal_split", original_id: id, new_ids: newIds }, { category: "ledger", verb: "goal_split", skill: "execute" });
				return okResult(`Goal ${id} split into ${newIds.length} sub-goals: ${newIds.join(", ")}`, "split", goals);
			}
			if (params.op === "reorder") {
				if (!params.order?.length) return errResult("reorder requires order (array of goal IDs in desired sequence)", goals);
				const idSet = new Set(goals.goals.map((g) => g.id));
				for (const id of params.order) {
					if (!idSet.has(id)) return errResult(`reorder: unknown goal id '${id}'`, goals);
				}
				// Reorder: put specified IDs first in given order, then remaining in original order
				const ordered: Goal[] = [];
				for (const id of params.order) {
					const g = goals.goals.find((x) => x.id === id)!;
					ordered.push(g);
				}
				for (const g of goals.goals) {
					if (!params.order.includes(g.id)) ordered.push(g);
				}
				goals.goals = ordered;
				await writeAllGoals(hooks.state, goals.goals, goals.current_goal_id);
				hooks.onGoalsChange?.(goals);
				return okResult(`Goals reordered: ${params.order.join(" → ")}`, "reorder", goals);
			}
			if (params.op === "revise") {
				const id = params.goal_id ?? goals.current_goal_id;
				const goal = goals.goals.find((g) => g.id === id);
				if (!goal) return errResult(`no goal ${id}`, goals);
				if (goal.status !== "active") return errResult(`can only revise active goals (${id} is ${goal.status})`, goals);
				if (!params.objective?.trim()) return errResult("revise requires 'objective' (the new wording)", goals);
				const oldObjective = goal.objective;
				goal.objective = params.objective.trim();
				goal.updated_at = now;
				await writeAllGoals(hooks.state, goals.goals, goals.current_goal_id);
				hooks.onGoalsChange?.(goals);
				await traceEvent(hooks.state, { ts: now, type: "goal_revised", goal_id: id, old: oldObjective, new: goal.objective }, { category: "ledger", verb: "goal_revised", skill: "execute" });
				return okResult(`Goal ${id} revised: "${goal.objective}"`, "revise", goals);
			}
			if (params.op === "block") {
				const id = params.goal_id ?? goals.current_goal_id;
				const goal = goals.goals.find((g) => g.id === id);
				if (!goal) return errResult(`no goal ${id}`, goals);
				if (goal.status !== "active") return errResult(`can only block active goals (${id} is ${goal.status})`, goals);
				goal.status = "blocked" as typeof goal.status;
				(goal as unknown as Record<string, unknown>).blocked_reason = params.reason ?? "unspecified";
				goal.updated_at = now;
				if (goals.current_goal_id === id) goals.current_goal_id = nextActiveGoal(goals)?.id ?? null;
				await writeAllGoals(hooks.state, goals.goals, goals.current_goal_id);
				hooks.onGoalsChange?.(goals);
				await traceEvent(hooks.state, { ts: now, type: "goal_blocked", goal_id: id, reason: params.reason }, { category: "ledger", verb: "goal_blocked", skill: "execute" });
				return okResult(`Goal ${id} blocked: ${params.reason ?? "unspecified"}`, "block", goals);
			}
			if (params.op === "unblock") {
				const id = params.goal_id ?? goals.current_goal_id;
				const goal = goals.goals.find((g) => g.id === id);
				if (!goal) return errResult(`no goal ${id}`, goals);
				if (goal.status !== ("blocked" as string)) return errResult(`goal ${id} is not blocked (status: ${goal.status})`, goals);
				goal.status = "active";
				delete (goal as unknown as Record<string, unknown>).blocked_reason;
				goal.updated_at = now;
				if (!goals.current_goal_id) goals.current_goal_id = goal.id;
				await writeAllGoals(hooks.state, goals.goals, goals.current_goal_id);
				hooks.onGoalsChange?.(goals);
				await traceEvent(hooks.state, { ts: now, type: "goal_unblocked", goal_id: id }, { category: "ledger", verb: "goal_unblocked", skill: "execute" });
				return okResult(`Goal ${id} unblocked and active.`, "unblock", goals);
			}
			if (params.op === "reopen") {
				// Reviewer rejection gate: reviewer can reopen a completed goal
				// (e.g. Oracle gate found issues). Resets complete→active.
				const id = params.goal_id ?? goals.current_goal_id;
				const goal = goals.goals.find((g) => g.id === id);
				if (!goal) return errResult(`no goal ${id}`, goals);
				if (goal.status !== "complete") return errResult(`goal ${id} is ${goal.status}, not complete`, goals);
				goal.status = "active";
				delete (goal as unknown as Record<string, unknown>).receipt;
				goal.updated_at = now;
				await writeAllGoals(hooks.state, goals.goals, goals.current_goal_id);
				hooks.onGoalsChange?.(goals);
				await traceEvent(hooks.state, { ts: now, type: "goal_reopened", goal_id: id, reason: params.reason }, { category: "ledger", verb: "goal_reopened", skill: "execute" });
				return okResult(`Goal ${id} reopened (reviewer rejection${params.reason ? `: ${params.reason}` : ""}). Active again.`, "reopen", goals);
			}
			// list
			const lines = goals.goals.length
				? goals.goals.map((g) => `- [${g.id}] ${g.status === "complete" ? "✓" : g.status === "dropped" ? "✗" : "○"} ${g.objective}`).join("\n")
				: "(no goals)";
			return okResult(`Goals:\n${lines}`, "list", goals);
		},
	};

	function okResult(text: string, op: string, goals: GoalsState): AgentToolResult<GoalDetails> {
		return { content: [{ type: "text", text }], details: { op, goals: goals.goals, current_goal_id: goals.current_goal_id } };
	}
	function errResult(text: string, goals: GoalsState): AgentToolResult<GoalDetails> {
		return { content: [{ type: "text", text }], details: { op: "error", goals: goals.goals, current_goal_id: goals.current_goal_id }, isError: true } as AgentToolResult<GoalDetails>;
	}
}

// ---- tokyo_complete (evidence-gated) -----------------------------------------

const CompleteParams = Type.Object({
	goal_id: Type.Optional(Type.String({ description: "Goal to complete (defaults to current)." })),
	evidence: Type.Array(
		Type.Object({
			kind: Type.Union([Type.Literal("command"), Type.Literal("inspection"), Type.Literal("artifact")], {
				description: "command (ran a check), inspection (read/verified), or artifact (a produced file).",
			}),
			status: Type.Union([Type.Literal("passed"), Type.Literal("verified"), Type.Literal("failed"), Type.Literal("todo")]),
			detail: Type.String({ description: "What was checked (command text, file path, inspection note)." }),
		}),
		{ description: "Evidence proving the goal is done. Need ≥1 passed/verified; no todo/failed items allowed." },
	),
});

interface CompleteDetails {
	goal_id: string;
	completed: boolean;
	receipt_sha256?: string;
	reason?: string;
}

export interface CompleteHooks {
	state: StateWriter;
	getPhase: () => Phase;
	/** Called with the new goals state after completion, for branch-correct snapshotting. */
	onGoalsChange?: (goals: GoalsState) => void;
}

export function makeCompleteTool(hooks: CompleteHooks): ToolDefinition<typeof CompleteParams, CompleteDetails> {
	return {
		name: "tokyo_complete",
		label: "Tokyo Complete",
		description: [
			"Complete a goal — EVIDENCE-GATED. You must supply concrete evidence (≥1 passed/verified",
			"command|inspection|artifact item; no todo/failed). The tool builds a hash-bound receipt,",
			"validates it, marks the goal complete, and appends a goal_checkpointed event to the ledger.",
			"Completion cannot be forged: no evidence, no completion.",
		].join(" "),
		parameters: CompleteParams,
		promptGuidelines: [
			"Only call tokyo_complete after you have actually verified the work (ran tests, read the result).",
			"Each evidence item must be real and checkable; fabricated evidence defeats the purpose.",
		],
		async execute(_id, params, _signal, _onUpdate, _ctx): Promise<AgentToolResult<CompleteDetails>> {
			const goals = await readGoals(hooks.state);
			const id = params.goal_id ?? goals.current_goal_id;
			const goal = goals.goals.find((g) => g.id === id);
			if (!goal) {
				return failComplete(id ?? "(none)", "no such goal");
			}
			if (goal.status !== "active") {
				return failComplete(goal.id, `goal is already ${goal.status}`);
			}
			const evidence = (params.evidence ?? []) as EvidenceItem[];
			if (!Array.isArray(evidence) || !evidence.every((e) => e && typeof e.detail === "string")) {
				return failComplete(goal.id, "evidence must be an array of {kind, status, detail} items");
			}

			// TDD ENFORCEMENT: code goals require at least one test command evidence.
			const hasTestEvidence = evidence.some(
				(e) => e.kind === "command" && /test|spec|jest|vitest|bun test|cargo test|pytest|mocha|rspec/i.test(e.detail),
			);
			const hasBuildEvidence = evidence.some(
				(e) => e.kind === "command" && /build|compile|tsc|cargo build|go build|make/i.test(e.detail),
			);
			const hasReviewEvidence = evidence.some(
				(e) => e.kind === "inspection" && /review(er|ed)?|architect/i.test(e.detail),
			);
			const isNonCodeGoal = /doc(s|umentation)|readme|config|setup|infra/i.test(goal.objective);

			// OMO ORACLE GATE (universal): every goal completion needs at least one
			// inspected-by-independent-reviewer evidence with status:'verified' — not
			// just any inspection. Self-declared completion without third-party sign-off
			// is not trusted. Spawn reviewer via spawn_subagents agent:"reviewer".
			const hasVerifiedReview = evidence.some(
				(e) => e.kind === "inspection" && e.status === "verified",
			);
			if (!hasVerifiedReview && !isNonCodeGoal) {
				return failComplete(goal.id,
					"Oracle gate: a VERIFIED inspection from an independent reviewer is required. " +
					"Run spawn_subagents agent:'reviewer' to audit this goal's work. " +
					"The reviewer must return status:'verified' in its evidence — any other status is rejected. " +
					"Non-reviewer inspection evidence is not sufficient. " +
					"(Non-code goals like docs/config may skip this gate.)",
				);
			}

			if (!hasTestEvidence && !isNonCodeGoal) {
				return failComplete(goal.id,
					"TDD gate: code goals require test evidence. Run your tests and include the result as evidence with kind:'command'. " +
					"If this is genuinely a non-code goal (docs/config/infra), rename the objective to reflect that.",
				);
			}

			// PER-STAGE QUALITY GATE (structured, all code goals):
			// Every code goal needs: tests passed + build clean.
			// Last active goal additionally needs: reviewer/architect sign-off.
			if (!isNonCodeGoal && !hasBuildEvidence) {
				return failComplete(goal.id,
					"Quality gate: build evidence required. Run the build (tsc/cargo build/go build/make) and include as evidence with kind:'command'.",
				);
			}

			const activeGoals = goals.goals.filter((g) => g.status === "active");
			if (activeGoals.length === 1 && activeGoals[0].id === goal.id) {
				if (!hasReviewEvidence) {
					return failComplete(goal.id,
						"Quality gate: this is the last goal — a reviewer/architect inspection is required before completion. " +
						"Delegate a review with spawn_subagents agent:'tokyo-reviewer'', then include the result as evidence with kind:'inspection'.",
					);
				}
			}

			const receipt = buildReceipt(goal, evidence);
			const check = validateReceipt(goal, receipt);
			if (!check.ok) {
				return failComplete(goal.id, check.reason ?? "evidence gate failed");
			}
			const now = new Date().toISOString();
			const eventId = randomUUID();
			goal.status = "complete";
			goal.updated_at = now;
			goal.receipt_sha256 = receipt.content_sha256;
			if (goals.current_goal_id === goal.id) goals.current_goal_id = nextActiveGoal(goals)?.id ?? null;
			await writeAllGoals(hooks.state, goals.goals, goals.current_goal_id);
			hooks.onGoalsChange?.(goals);
			// the matching ledger event the disk-guard binds to (carries a UUID eventId)
			await traceEvent(hooks.state,
				{ ts: now, type: "goal_checkpointed", eventId, status: "complete", goal_id: goal.id, receipt_sha256: receipt.content_sha256, evidence },
				{ category: "ledger", verb: "goal_checkpointed", skill: "execute" },
			);
			// RE-VALIDATE FROM DISK: re-read goals.json + events.jsonl and verify the
			// completion is real (fixes the CR1 tautology + CR2 missing ledger match).
			const diskGoals = await readGoals(hooks.state);
			const diskEvents = await hooks.state.readJsonl<LedgerEvent>(EVENTS_PATH);
			const verified = verifyCompletionFromDisk(goal.id, diskGoals, diskEvents);
			if (!verified.ok) {
				return failComplete(goal.id, `completion failed disk re-validation: ${verified.reason}`);
			}
			const remaining = diskGoals.goals.filter((g) => g.status === "active").length;
			const settled = allGoalsSettled(diskGoals);
			return {
				content: [
					{
						type: "text",
						text: `Goal ${goal.id} complete (receipt ${receipt.content_sha256.slice(0, 12)}, verified from disk). ${remaining} active goal(s) left.${settled ? " All goals settled — advance to VERIFY." : ""}`,
					},
				],
				details: { goal_id: goal.id, completed: true, receipt_sha256: receipt.content_sha256 },
			};
		},
	};

	function failComplete(goalId: string, reason: string): AgentToolResult<CompleteDetails> {
		return {
			content: [{ type: "text", text: `Cannot complete ${goalId}: ${reason}.` }],
			details: { goal_id: goalId, completed: false, reason },
			isError: true,
		} as AgentToolResult<CompleteDetails>;
	}
}

// ---- tokyo_verify (VERIFY-phase evidence gate) -------------------------------

const VerifyParams = Type.Object({
	checks: Type.Array(
		Type.Object({
			kind: Type.Union([Type.Literal("command"), Type.Literal("inspection"), Type.Literal("review")]),
			status: Type.Union([Type.Literal("passed"), Type.Literal("verified"), Type.Literal("failed")]),
			detail: Type.String({ description: "What was verified (command + result, inspection note, or reviewer verdict)." }),
		}),
		{ description: "Verification evidence: build/test commands run, inspections, and the reviewer's verdict. Need >=1 passed/verified, no failed." },
	),
	summary: Type.String({ description: "One-paragraph summary of what was verified and the outcome." }),
});

interface VerifyDetails {
	ok: boolean;
	reason?: string;
}

export interface VerifyHooks {
	state: StateWriter;
	getPhase: () => Phase;
}

export function makeVerifyTool(hooks: VerifyHooks): ToolDefinition<typeof VerifyParams, VerifyDetails> {
	return {
		name: "tokyo_verify",
		label: "Tokyo Verify",
		description: [
			"Record verification evidence in the VERIFY phase. Supply the build/test commands you ran",
			"(with results), inspections, and the reviewer agent's verdict. Need >=1 passed/verified item",
			"and no failed item. This gates VERIFY->REVIEW: without recorded verification evidence, you",
			"cannot advance. Delegate the code review to the `reviewer` agent via spawn_subagents first.",
		].join(" "),
		parameters: VerifyParams,
		promptGuidelines: [
			"In VERIFY: run the build/tests, delegate review to `reviewer`, then record it all with tokyo_verify before advancing to REVIEW.",
		],
		async execute(_id, params, _signal, _onUpdate, _ctx): Promise<AgentToolResult<VerifyDetails>> {
			const phase = hooks.getPhase();
			if (phase !== "VERIFY") {
				return { content: [{ type: "text", text: `tokyo_verify is only valid in VERIFY (current: ${phase}).` }], details: { ok: false, reason: "wrong phase" }, isError: true } as AgentToolResult<VerifyDetails>;
			}
			const checks = params.checks ?? [];
			if (checks.length === 0) return verifyFail("no verification evidence provided");
			if (checks.some((c) => c.status === "failed")) return verifyFail("a verification check failed — return to EXECUTE to fix");
			if (!checks.some((c) => c.status === "passed" || c.status === "verified")) return verifyFail("no passed/verified check");
			const now = new Date().toISOString();
			await traceEvent(hooks.state,
				{ ts: now, type: "verified", eventId: randomUUID(), summary: params.summary, checks },
				{ category: "ledger", verb: "verified", skill: "verify" },
			);
			return {
				content: [{ type: "text", text: `Verification recorded (${checks.length} checks). You may advance with tokyo_phase to REVIEW.` }],
				details: { ok: true },
			};
		},
	};

	function verifyFail(reason: string): AgentToolResult<VerifyDetails> {
		return { content: [{ type: "text", text: `Verification gate: ${reason}.` }], details: { ok: false, reason }, isError: true } as AgentToolResult<VerifyDetails>;
	}
}

/**
 * Has a `verified` event been recorded AFTER the most recent goal completion?
 * Gates VERIFY->REVIEW. Anchoring on the last `goal_checkpointed` (not the last
 * `goal_created`) means a stale `verified` from a prior iteration no longer
 * counts: re-entering EXECUTE and completing/redoing a goal pushes a new
 * checkpoint, so the prior verification falls before the boundary.
 */
export async function hasVerifyEvidence(state: StateWriter): Promise<boolean> {
	const events = await state.readJsonl<{ type?: string }>("ledger/events.jsonl");
	// boundary = the most recent goal_checkpointed (completion) OR goal_created,
	// whichever is later; a verification must be newer than the latest work event.
	let lastBoundary = -1;
	for (let i = events.length - 1; i >= 0; i--) {
		const t = events[i].type;
		if (t === "execute_entered" || t === "goal_checkpointed" || t === "goal_created") {
			lastBoundary = i;
			break;
		}
	}
	return events.slice(lastBoundary + 1).some((e) => e.type === "verified");
}
