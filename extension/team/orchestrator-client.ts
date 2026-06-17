/**
 * IPC client for the Rust orchestrator.
 *
 * Connects to the orchestrator's Unix domain socket (.tokyo/orchestrator.sock)
 * and sends JSON commands. Used by the tokyo_team tool when the orchestrator is
 * running (replaces the legacy print-mode worker spawn).
 */

import * as net from "node:net";
import * as path from "node:path";
import { statSync } from "node:fs";

export interface WorkerSpec {
	id: string;
	model: string;
	system_prompt: string;
}

export interface WorkerResult {
	worker_id: string;
	text: string;
}

export interface WorkerStatus {
	id: string;
	alive: boolean;
}

type IpcResponse =
	| { type: "team_created"; team_id: string; worker_ids: string[] }
	| { type: "worker_response"; worker_id: string; text: string }
	| { type: "broadcast_result"; responses: WorkerResult[] }
	| { type: "stopped" }
	| { type: "status_result"; workers: WorkerStatus[] }
	| { type: "hyperplan_started"; job_id: string; members: number }
	| {
			type: "hyperplan_progress";
			job_id: string;
			status: "running" | "done" | "failed";
			round: number;
			total_rounds: number;
			result?: string | null;
			error?: string | null;
	  }
	| { type: "error"; message: string };

export interface HyperplanProgress {
	jobId: string;
	status: "running" | "done" | "failed";
	round: number;
	totalRounds: number;
	result?: string;
	error?: string;
}

export class OrchestratorClient {
	private socketPath: string;

	constructor(projectDir: string) {
		this.socketPath = path.join(projectDir, ".tokyo", "orchestrator.sock");
	}

	/**
	 * Cheap sync check: the path exists AND is actually a unix socket (not a
	 * leftover regular file or a missing path). This is a pre-check only — a
	 * socket file can linger after a crashed orchestrator, so callers that need
	 * certainty should use probe() to confirm the orchestrator actually answers.
	 */
	isAvailable(): boolean {
		try {
			return statSync(this.socketPath).isSocket();
		} catch {
			return false;
		}
	}

	/**
	 * Authoritative liveness check: open a connection and confirm the
	 * orchestrator answers a status command. Detects stale socket files left by
	 * a crashed orchestrator (isAvailable() would still return true for those).
	 */
	async probe(timeoutMs = 1500): Promise<boolean> {
		if (!this.isAvailable()) return false;
		try {
			await this.send({ type: "status" }, timeoutMs);
			return true;
		} catch {
			return false;
		}
	}

	/** Send a command and wait for the response. */
	private async send(command: Record<string, unknown>, timeoutMs = 60_000): Promise<IpcResponse> {
		return new Promise((resolve, reject) => {
			const client = net.createConnection(this.socketPath, () => {
				const line = JSON.stringify(command) + "\n";
				client.write(line);
			});

			let buffer = "";
			client.on("data", (chunk) => {
				buffer += chunk.toString();
				const newline = buffer.indexOf("\n");
				if (newline !== -1) {
					const json = buffer.slice(0, newline);
					client.end();
					try {
						resolve(JSON.parse(json) as IpcResponse);
					} catch (e) {
						reject(new Error(`Invalid JSON from orchestrator: ${json}`));
					}
				}
			});

			client.on("error", (err) => {
				reject(new Error(`Orchestrator connection failed: ${err.message}`));
			});

			client.on("end", () => {
				if (!buffer.includes("\n")) {
					reject(new Error("Orchestrator closed connection without response"));
				}
			});

			// Configurable timeout (worker prompts can take a while; broadcasts over
			// many workers + multiple rounds need much longer than a single send).
			client.setTimeout(timeoutMs, () => {
				client.destroy();
				reject(new Error(`Orchestrator response timeout after ${Math.round(timeoutMs / 1000)}s`));
			});
		});
	}

	async createTeam(teamId: string, workers: WorkerSpec[]): Promise<{ teamId: string; workerIds: string[] }> {
		const resp = await this.send({ type: "create_team", team_id: teamId, workers });
		if (resp.type === "error") throw new Error(resp.message);
		if (resp.type !== "team_created") throw new Error(`Unexpected response: ${resp.type}`);
		return { teamId: resp.team_id, workerIds: resp.worker_ids };
	}

	async sendToWorker(workerId: string, message: string): Promise<string> {
		const resp = await this.send({ type: "send", worker_id: workerId, message });
		if (resp.type === "error") throw new Error(resp.message);
		if (resp.type !== "worker_response") throw new Error(`Unexpected response: ${resp.type}`);
		return resp.text;
	}

	async broadcast(message: string): Promise<WorkerResult[]> {
		// Broadcast fans out to every worker (parallel in the orchestrator), but a
		// single hyperplan round is still bounded by the slowest model. Give it 5
		// minutes so opus-class workers don't trip the default 60s timeout.
		const resp = await this.send({ type: "broadcast", message }, 300_000);
		if (resp.type === "error") throw new Error(resp.message);
		if (resp.type !== "broadcast_result") throw new Error(`Unexpected response: ${resp.type}`);
		return resp.responses;
	}

	/** Start a background hyperplan run. Returns immediately with a job id. */
	async hyperplanRun(objective: string): Promise<{ jobId: string; members: number }> {
		const resp = await this.send({ type: "hyperplan_run", objective });
		if (resp.type === "error") throw new Error(resp.message);
		if (resp.type !== "hyperplan_started") throw new Error(`Unexpected response: ${resp.type}`);
		return { jobId: resp.job_id, members: resp.members };
	}

	/** Poll a background hyperplan job's progress/result. */
	async hyperplanStatus(jobId: string): Promise<HyperplanProgress> {
		const resp = await this.send({ type: "hyperplan_status", job_id: jobId });
		if (resp.type === "error") throw new Error(resp.message);
		if (resp.type !== "hyperplan_progress") throw new Error(`Unexpected response: ${resp.type}`);
		return {
			jobId: resp.job_id,
			status: resp.status,
			round: resp.round,
			totalRounds: resp.total_rounds,
			result: resp.result ?? undefined,
			error: resp.error ?? undefined,
		};
	}

	/**
	 * Block until a background hyperplan job finishes. The orchestrator holds the
	 * connection open until the job leaves "running" (bounded to 30 min), so the
	 * extension can await this off the tool path and inject a notification — no
	 * client-side polling. Uses a long socket timeout to match the server bound.
	 */
	async hyperplanWait(jobId: string): Promise<HyperplanProgress> {
		const resp = await this.send({ type: "hyperplan_wait", job_id: jobId }, 31 * 60_000);
		if (resp.type === "error") throw new Error(resp.message);
		if (resp.type !== "hyperplan_progress") throw new Error(`Unexpected response: ${resp.type}`);
		return {
			jobId: resp.job_id,
			status: resp.status,
			round: resp.round,
			totalRounds: resp.total_rounds,
			result: resp.result ?? undefined,
			error: resp.error ?? undefined,
		};
	}

	async stopWorker(workerId: string): Promise<void> {
		const resp = await this.send({ type: "stop_worker", worker_id: workerId });
		if (resp.type === "error") throw new Error(resp.message);
	}

	async stopTeam(): Promise<void> {
		const resp = await this.send({ type: "stop_team" });
		if (resp.type === "error") throw new Error(resp.message);
	}

	async status(): Promise<WorkerStatus[]> {
		const resp = await this.send({ type: "status" });
		if (resp.type === "error") throw new Error(resp.message);
		if (resp.type !== "status_result") throw new Error(`Unexpected response: ${resp.type}`);
		return resp.workers;
	}
}
