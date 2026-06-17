/**
 * Tokyo team tools — expose the file-based coordination data plane to the model.
 *
 * tokyo_team: a single tool with verbs (create / add_task / claim / transition /
 * status / send / recover) over a TeamCoordinator. The orchestrator (Lead) uses
 * this to run a persistent-worker team; hyperplan (the adversarial planning skill)
 * is the headline consumer.
 *
 * Worker processes are managed by the Rust orchestrator via IPC (Unix socket).
 * The legacy print-mode worker.ts has been removed.
 */
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { StateWriter } from "../state/index.ts";
import { allTasksComplete, type TaskEvidence, type Worker } from "./coordination-logic.ts";
import { TeamCoordinator } from "./coordination.ts";
import { getRoleAgent } from "./agents.ts";
import { HYPERPLAN_MEMBERS } from "./hyperplan-members.ts";
import { assertSafeId, assertSafeModel } from "./ids.ts";

const TeamParams = Type.Object({
	op: Type.Union(
		[
			Type.Literal("create"),
			Type.Literal("add_task"),
			Type.Literal("claim"),
			Type.Literal("transition"),
			Type.Literal("status"),
			Type.Literal("send"),
			Type.Literal("replies"),
			Type.Literal("recover"),
			Type.Literal("delete"),
			Type.Literal("hyperplan_run"),
			Type.Literal("hyperplan_poll"),
		],
		{ description: "Team coordination verb." },
	),
	team: Type.String({ description: "Team name (namespaces .tokyo/team/<team>/)." }),
	preset: Type.Optional(
		Type.Literal("hyperplan", {
			description: "For create: auto-seed the 5 hostile hyperplan members (skeptic/validator/researcher/architect/creative) with their prompts+models. Ignores `workers` when set.",
		}),
	),
	workers: Type.Optional(
		Type.Array(
			Type.Object({
				id: Type.String(),
				role: Type.Optional(Type.String()),
				prompt: Type.Optional(Type.String({ description: "Worker system prompt (its adversarial/role identity)." })),
				model: Type.Optional(Type.String({ description: "relay model for this worker." })),
			}),
			{ description: "For create: the worker roster. Provide prompt+model to launch live worker processes." },
		),
	),
	objective: Type.Optional(Type.String({ description: "For add_task: the task objective. For hyperplan_run: the task to analyze." })),
	required_role: Type.Optional(Type.String({ description: "For add_task: role required to claim." })),
	depends_on: Type.Optional(Type.Array(Type.String(), { description: "For add_task: prerequisite task ids." })),
	task_id: Type.Optional(Type.String({ description: "For claim/transition." })),
	job_id: Type.Optional(Type.String({ description: "For hyperplan_poll: the job id returned by hyperplan_run." })),
	worker_id: Type.Optional(Type.String({ description: "For claim/send: the worker id." })),
	status: Type.Optional(
		Type.Union(
			[
				Type.Literal("in_progress"),
				Type.Literal("complete"),
				Type.Literal("failed"),
				Type.Literal("blocked"),
			],
			{ description: "For transition: target task status." },
		),
	),
	evidence: Type.Optional(
		Type.Array(
			Type.Object({
				kind: Type.Union([Type.Literal("command"), Type.Literal("inspection"), Type.Literal("artifact")]),
				status: Type.Union([
					Type.Literal("passed"),
					Type.Literal("verified"),
					Type.Literal("failed"),
					Type.Literal("todo"),
				]),
				detail: Type.String(),
			}),
			{ description: "For transition→complete: evidence (≥1 passed/verified, no todo/failed)." },
		),
	),
	message: Type.Optional(Type.String({ description: "For send: message body to a worker." })),
	token: Type.Optional(Type.String({ description: "For transition: the claim token returned by claim (required to transition a leased task)." })),
});

interface TeamDetails {
	op: string;
	team: string;
	ok: boolean;
	info?: unknown;
}

export interface TeamToolHooks {
	state: StateWriter;
	/** Called after any team op so the runtime can refresh the team widget. */
	onChange?: (ctx: ExtensionContext) => void | Promise<void>;
	/**
	 * Inject a notification message into the Lead's session (async-bash style).
	 * Used so a background hyperplan job can ping the model on completion instead
	 * of the model polling. `idle` lets the caller pick immediate vs steered
	 * delivery. Implemented in index.ts via pi.sendUserMessage.
	 */
	notify?: (note: string) => void;
}

const defaultModelFor = (id: string): string | undefined => getRoleAgent(id)?.model;

/**
 * Teardown: pause the orchestrator (snapshot + kill workers + exit) when the
 * Lead's session ends, so a normal /exit or Ctrl+D turns into a clean pause
 * instead of leaving zombie worker windows behind. Falls back to stopTeam if
 * the orchestrator is unresponsive (e.g. already gone) — best-effort cleanup.
 *
 * Called from session_shutdown.
 */
export function teardownAllTeams(): void {
	import("./orchestrator-client.ts").then(({ OrchestratorClient }) => {
		const oc = new OrchestratorClient(process.cwd());
		if (!oc.isAvailable()) return;
		// Try a graceful pause first. This saves a snapshot the user can resume
		// from, and kills the worker tmux windows so they don't linger.
		oc.pause().catch(() => {
			// Pause failed (orchestrator may be shutting down or socket died).
			// Fall back to a hard stop so workers still get killed.
			oc.stopTeam().catch(() => {});
		});
	}).catch(() => {});
}

export function makeTeamTool(hooks: TeamToolHooks): ToolDefinition<typeof TeamParams, TeamDetails> {
	return {
		name: "tokyo_team",
		label: "Tokyo Team",
		description: [
			"File-coordinated team data plane (no central broker). Verbs:",
			"create (spin up a team + worker roster), add_task (with role/deps),",
			"claim (lease a task through the ordered gate), transition (move task status;",
			"complete requires evidence), status (manifest + tasks + completion), send (mailbox),",
			"recover (requeue stale claims), delete. State lives under .tokyo/team/<team>/.",
		].join(" "),
		parameters: TeamParams,
		async execute(_id, params, _signal, _onUpdate, ctx: ExtensionContext): Promise<AgentToolResult<TeamDetails>> {
			const co = new TeamCoordinator(hooks.state, params.team);
			const done = (ok: boolean, text: string, info?: unknown): AgentToolResult<TeamDetails> => ({
				content: [{ type: "text", text }],
				details: { op: params.op, team: params.team, ok, info },
				...(ok ? {} : { isError: true }),
			});

			try {
				const result = await runOp();
				await hooks.onChange?.(ctx);
				return result;
			} catch (err) {
				return done(false, `Team op failed: ${(err as Error).message}`);
			}

			async function runOp(): Promise<AgentToolResult<TeamDetails>> {
				switch (params.op) {
					case "create": {
						// preset auto-seeds a known member roster with prompts+models.
						const roster =
							params.preset === "hyperplan"
								? HYPERPLAN_MEMBERS.map((m) => ({ id: m.id, role: m.role, prompt: m.systemPrompt, model: m.model }))
								: (params.workers ?? []);
						// Validate every id/model before they touch a path segment or shell line (CR4).
						try {
							assertSafeId("team", params.team);
							for (const w of roster) {
								assertSafeId("worker_id", w.id);
								if (w.model) assertSafeModel(w.model);
							}
						} catch (err) {
							return done(false, `Rejected: ${(err as Error).message}`);
						}
						const m = await co.create(roster.map((w) => ({ id: w.id, role: w.role })));

						// Use orchestrator IPC (Rust sidecar with persistent RPC workers).
						const { OrchestratorClient } = await import("./orchestrator-client.ts");
						const orchClient = new OrchestratorClient(process.cwd());
						if (await orchClient.probe()) {
							const { resolveWorkerModel, loadUserConfig } = await import("../tokyo-config.ts");
							const tokyoCfg = loadUserConfig(process.cwd());
							const specs = roster.filter((w) => w.prompt).map((w) => ({
								id: w.id,
								model: w.model ?? resolveWorkerModel(tokyoCfg, w.id),
								system_prompt: w.prompt ?? "",
							}));
							try {
								const result = await orchClient.createTeam(params.team, specs);
								// Reflect real liveness in the manifest so the dashboard stops
								// showing workers stuck at "starting".
								await co.markWorkersLive(result.workerIds);
								return done(
									true,
									`Team "${params.team}" created via orchestrator with ${result.workerIds.length} persistent worker(s): ${result.workerIds.join(", ")}.`,
									m,
								);
							} catch (orchErr) {
								return done(false, `Orchestrator detected but createTeam failed: ${(orchErr as Error).message}. Team coordination files exist but workers were NOT launched.`);
							}
						}

						// No live orchestrator — team coordination files created but no live workers.
						return done(
							true,
							`Team "${params.team}" created (${m.workers.length} worker(s): ${m.workers.map((w) => w.id).join(", ")}). Note: no live orchestrator at .tokyo/orchestrator.sock — workers were NOT launched. Start via the 'tokyo' CLI for persistent workers.`,
							m,
						);
					}
					case "add_task": {
						if (!params.objective?.trim()) return done(false, "add_task requires an objective");
						const t = await co.createTask({
							objective: params.objective,
							required_role: params.required_role,
							depends_on: params.depends_on,
						});
						return done(true, `Task [${t.id}] created: ${t.objective}`, t);
					}
					case "claim": {
						if (!params.task_id || !params.worker_id) return done(false, "claim requires task_id and worker_id");
						const m = await co.readManifest();
						const w = m?.workers.find((x) => x.id === params.worker_id);
						if (!w) return done(false, `Worker '${params.worker_id}' not found in team manifest. Create the team first.`);
						const r = await co.claimTask(params.task_id, w);
						if (!r.ok) return done(false, `Claim refused: ${r.reason}`);
						// surface the claim token so the Lead can transition the leased task.
						const claimed = (await co.listTasks()).find((t) => t.id === params.task_id);
						return done(true, `Worker ${params.worker_id} claimed ${params.task_id}. Claim token: ${claimed?.claim_token ?? "(none)"} — pass it as 'token' when transitioning.`, { token: claimed?.claim_token });
					}
					case "transition": {
						if (!params.task_id || !params.status) return done(false, "transition requires task_id and status");
						const evidence = params.evidence as TaskEvidence[] | undefined;
						if (evidence && (!Array.isArray(evidence) || !evidence.every((e) => e && typeof e.detail === "string"))) {
							return done(false, "evidence must be an array of {kind, status, detail} items");
						}
						const r = await co.transitionTask(params.task_id, params.status, evidence, params.token);
						return done(r.ok, r.ok ? `Task ${params.task_id} → ${params.status}.` : `Transition refused: ${r.reason}`);
					}
					case "status": {
						const m = await co.readManifest();
						const tasks = await co.listTasks();
						const lines = tasks.length
							? tasks.map((t) => `- [${t.id}] ${t.status}${t.owner ? ` @${t.owner}` : ""}${t.depends_on.length ? ` (deps: ${t.depends_on.join(",")})` : ""}: ${t.objective}`).join("\n")
							: "(no tasks)";
						const allDone = allTasksComplete(tasks);
						const workers = m ? m.workers.map((w) => `${w.id}${w.role ? `:${w.role}` : ""}=${w.status}`).join(", ") : "(no manifest)";
						return done(true, `Team "${params.team}" — phase ${m?.phase ?? "?"}\nWorkers: ${workers}\nTasks:\n${lines}\n${allDone ? "All tasks complete." : ""}`, { tasks, manifest: m });
					}
					case "send": {
						if (!params.worker_id || !params.message) return done(false, "send requires worker_id and message");
						// Route through orchestrator IPC for real-time response
						try {
							const { OrchestratorClient } = await import("./orchestrator-client.ts");
							const oc = new OrchestratorClient(process.cwd());
							if (await oc.probe()) {
								const text = await oc.sendToWorker(params.worker_id, params.message);
								return done(true, `[${params.worker_id}] ${text}`);
							}
						} catch { /* fall through to file mailbox */ }
						await co.deliver(params.worker_id, "lead", params.message);
						return done(true, `Message delivered to ${params.worker_id} mailbox (no orchestrator).`);
					}
					case "replies": {
						if (!params.worker_id) return done(false, "replies requires worker_id");
						const outbox = await hooks.state.readJsonl<{ from: string; body: string }>(
							`team/${params.team}/mailbox/${params.worker_id}/outbox.jsonl`,
						);
						const text = outbox.length
							? outbox.map((r, i) => `--- reply ${i + 1} from ${params.worker_id} ---\n${r.body}`).join("\n\n")
							: `(no replies yet from ${params.worker_id})`;
						return done(true, text, { count: outbox.length });
					}
					case "recover": {
						const requeued = await co.recoverStaleClaims();
						return done(true, requeued.length ? `Requeued stale tasks: ${requeued.join(", ")}.` : "No stale claims.", requeued);
					}
					case "delete": {
						await co.delete();
						// Workers are managed by the orchestrator; send stop_team via IPC if available.
						try {
							const { OrchestratorClient } = await import("./orchestrator-client.ts");
							const orchClient = new OrchestratorClient(process.cwd());
							if (orchClient.isAvailable()) await orchClient.stopTeam();
						} catch { /* best effort */ }
						return done(true, `Team "${params.team}" disbanded.`);
					}
					case "hyperplan_run": {
						if (!params.objective?.trim()) return done(false, "hyperplan_run requires 'objective' (the task to analyze).");
						const { OrchestratorClient } = await import("./orchestrator-client.ts");
						const orchClient = new OrchestratorClient(process.cwd());
						if (!(await orchClient.probe())) {
							return done(false,
								"Orchestrator not answering at .tokyo/orchestrator.sock (missing or stale socket). " +
								"hyperplan_run needs the live orchestrator to drive the 5 worker processes. " +
								"Do NOT role-play the rounds inline — that is not hyperplan. " +
								"Either (re)start via the 'tokyo' CLI, or explicitly use spawn_subagents to run real adversarial subagents (tokyo-architect, tokyo-critic, etc.).",
							);
						}
						// Start the run as a BACKGROUND job and return immediately. Then
						// await completion OFF the tool path and inject a notification when
						// done (async-bash style) — the model does NOT poll.
						try {
							const { jobId, members } = await orchClient.hyperplanRun(params.objective);
							const teamName = params.team;
							// Reflect "busy" in the manifest so the dashboard shows the members
							// working, not idle, while the rounds run.
							try {
								await co.setWorkersStatus((await co.readManifest())?.workers.map((w) => w.id) ?? [], "busy");
								await hooks.onChange?.(ctx);
							} catch { /* best effort */ }
							// Fire-and-forget: wait for the job in the background, then ping.
							void (async () => {
								try {
									const wc = new OrchestratorClient(process.cwd());
									const p = await wc.hyperplanWait(jobId);
									// Mark workers idle again now that the rounds are done.
									try {
										await co.setWorkersStatus((await co.readManifest())?.workers.map((w) => w.id) ?? [], "idle");
										await hooks.onChange?.(ctx);
									} catch { /* best effort */ }
									if (p.status === "done") {
										hooks.notify?.(
											`[hyperplan ${jobId} done] 3 rounds complete (${members} members). ` +
											`Retrieve the result with: tokyo_team op:"hyperplan_poll" team:"${teamName}" job_id:"${jobId}", then DISTILL and hand off to the planner.`,
										);
									} else {
										hooks.notify?.(
											`[hyperplan ${jobId} failed] ${p.error ?? "(no detail)"}. Fall back to consensus planning.`,
										);
									}
								} catch (e) {
									hooks.notify?.(`[hyperplan ${jobId} error] wait failed: ${(e as Error).message}. Poll manually or fall back to consensus.`);
								}
							})();
							return done(
								true,
								`Hyperplan started (job ${jobId}, ${members} members, 3 rounds running in background). ` +
								`You'll get a '[hyperplan ${jobId} done]' notification automatically when it finishes — do NOT poll. ` +
								`Keep working or end your turn; you'll be pinged.`,
								{ job_id: jobId, members },
							);
						} catch (e) {
							return done(false, `hyperplan_run failed to start: ${(e as Error).message}`);
						}
					}
					case "hyperplan_poll": {
						if (!params.job_id?.trim()) return done(false, "hyperplan_poll requires 'job_id' (from hyperplan_run).");
						const { OrchestratorClient } = await import("./orchestrator-client.ts");
						const orchClient = new OrchestratorClient(process.cwd());
						if (!(await orchClient.probe())) {
							return done(false, "Orchestrator not answering — cannot poll the hyperplan job. The run may have been lost if the orchestrator restarted.");
						}
						try {
							const p = await orchClient.hyperplanStatus(params.job_id);
							if (p.status === "done") {
								return done(true, p.result ?? "(hyperplan done but no result captured)", { status: p.status, round: p.round, total_rounds: p.totalRounds });
							}
							if (p.status === "failed") {
								return done(false, `Hyperplan job ${p.jobId} failed: ${p.error ?? "(no detail)"}`);
							}
							return done(
								true,
								`Hyperplan job ${p.jobId} still running — round ${p.round}/${p.totalRounds} complete. Poll again shortly.`,
								{ status: p.status, round: p.round, total_rounds: p.totalRounds },
							);
						} catch (e) {
							return done(false, `hyperplan_poll failed: ${(e as Error).message}`);
						}
					}
				}
				return done(false, "unknown op");
			}
		},
	};
}
