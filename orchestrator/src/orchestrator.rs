//! Orchestrator loop: processes IPC commands from the extension, managing workers.
//!
//! Concurrency model: `workers` and `jobs` live behind `Arc<Mutex<..>>` so the
//! IPC loop can spawn each command into its own task. That means a long-running
//! hyperplan job runs in the background while status polls (and other commands)
//! are still serviced — the Lead is never blocked on a multi-minute call.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use crate::ipc::{IpcCommand, IpcMessage, IpcResponse, WorkerResult, WorkerSpec, WorkerStatus};
use crate::snapshot::{self, OrchestratorSnapshot, WorkerSnapshot};
use crate::worker::Worker;
use tokio::sync::{mpsc, Mutex, Notify};

/// Shared worker pool: id -> live zellij-backed pi worker.
pub type WorkerPool = Arc<Mutex<HashMap<String, Worker>>>;

/// Static runtime config shared with every command handler: where workers live.
#[derive(Clone)]
pub struct WorkerEnv {
    /// zellij session that owns the Lead + worker tabs. None => no zellij =>
    /// team features are unavailable (we refuse to spawn invisible workers).
    pub session: Option<String>,
    /// Project dir (.tokyo/ root), used for worker session dirs + worktrees.
    pub cwd: PathBuf,
    pub default_model: String,
}

/// State of a background hyperplan job.
#[derive(Clone)]
pub struct HyperplanJob {
    pub status: String, // "running" | "done" | "failed"
    pub round: u32,
    pub total_rounds: u32,
    pub result: Option<String>,
    pub error: Option<String>,
}

pub type JobRegistry = Arc<Mutex<HashMap<String, HyperplanJob>>>;

pub struct Orchestrator {
    pub workers: WorkerPool,
    pub jobs: JobRegistry,
    env: WorkerEnv,
    /// Notified by the Pause handler to make `run()` return. The caller (main.rs
    /// Serve/Start handler) then cleans up the socket + pid lock and exits.
    shutdown: Arc<Notify>,
}

impl Orchestrator {
    pub fn new(default_model: &str, session: Option<String>, cwd: PathBuf) -> Self {
        Self {
            workers: Arc::new(Mutex::new(HashMap::new())),
            jobs: Arc::new(Mutex::new(HashMap::new())),
            env: WorkerEnv { session, cwd, default_model: default_model.to_string() },
            shutdown: Arc::new(Notify::new()),
        }
    }

    /// Run the orchestrator loop. Each command is spawned into its own task so
    /// long-running work (hyperplan rounds) doesn't block status polls. The
    /// shutdown Notify breaks the loop when the Pause handler fires it.
    pub async fn run(&mut self, mut rx: mpsc::Receiver<IpcMessage>) {
        loop {
            tokio::select! {
                msg = rx.recv() => {
                    match msg {
                        Some(msg) => {
                            let workers = self.workers.clone();
                            let jobs = self.jobs.clone();
                            let env = self.env.clone();
                            let shutdown = self.shutdown.clone();
                            tokio::spawn(async move {
                                let response = handle(workers, jobs, env, shutdown, msg.command).await;
                                let _ = msg.respond.send(response);
                            });
                        }
                        None => break,
                    }
                }
                _ = self.shutdown.notified() => {
                    eprintln!("[orchestrator] shutdown signaled — exiting run loop");
                    break;
                }
            }
        }
    }
}

async fn handle(
    workers: WorkerPool,
    jobs: JobRegistry,
    env: WorkerEnv,
    shutdown: Arc<Notify>,
    cmd: IpcCommand,
) -> IpcResponse {
    match cmd {
        IpcCommand::CreateTeam { team_id, workers: specs } => {
            create_team(&workers, &env, &team_id, specs).await
        }
        IpcCommand::Send { worker_id, message } => {
            send_to(&workers, &worker_id, &message).await
        }
        IpcCommand::Broadcast { message } => {
            broadcast(&workers, &message).await
        }
        IpcCommand::StopWorker { worker_id } => {
            stop_worker(&workers, &worker_id).await
        }
        IpcCommand::StopTeam => {
            stop_all(&workers).await
        }
        IpcCommand::Status => {
            status(&workers).await
        }
        IpcCommand::MergeWorker { worker_id, strategy } => {
            merge_worker(&workers, &worker_id, &strategy).await
        }
        IpcCommand::HyperplanRun { objective } => {
            hyperplan_run(workers, jobs, objective).await
        }
        IpcCommand::HyperplanStatus { job_id } => {
            hyperplan_status(&jobs, &job_id).await
        }
        IpcCommand::HyperplanWait { job_id } => {
            hyperplan_wait(&jobs, &job_id).await
        }
        IpcCommand::Pause => {
            pause(&workers, &env, shutdown).await
        }
        IpcCommand::RestoreWorker { id, model, prime_message } => {
            restore_worker(&workers, &env, &id, &model, &prime_message).await
        }
    }
}

async fn create_team(workers: &WorkerPool, env: &WorkerEnv, _team_id: &str, specs: Vec<WorkerSpec>) -> IpcResponse {
    // tmux is required for visible workers. No session => refuse (we never spawn
    // invisible workers anymore).
    let session = match &env.session {
        Some(s) => s.clone(),
        None => return IpcResponse::Error {
            message: "no tmux session — cannot spawn visible workers. Start via the 'tokyo' launcher.".to_string(),
        },
    };
    let mut ids = Vec::new();
    for spec in specs {
        // Shut down existing worker with same ID to prevent orphan (E2E C2 fix)
        if let Some(old) = workers.lock().await.remove(&spec.id) {
            old.shutdown().await;
        }
        match Worker::spawn(&session, &spec.id, &spec.model, &env.cwd, None).await {
            Ok(mut w) => {
                // Prime with system prompt (the worker's role identity).
                let prime = format!(
                    "You are {}. Your role:\n{}\n\nAcknowledge with 'ready'.",
                    spec.id, spec.system_prompt
                );
                if let Err(e) = w.prompt(&prime).await {
                    eprintln!("[orchestrator] failed to prime {}: {e}", spec.id);
                    return IpcResponse::Error { message: format!("prime failed for {}: {e}", spec.id) };
                }
                w.set_prime_message(&prime);
                ids.push(spec.id.clone());
                workers.lock().await.insert(spec.id, w);
            }
            Err(e) => {
                return IpcResponse::Error { message: format!("spawn failed for {}: {e}", spec.id) };
            }
        }
    }
    IpcResponse::TeamCreated { team_id: _team_id.to_string(), worker_ids: ids }
}

async fn send_to(workers: &WorkerPool, worker_id: &str, message: &str) -> IpcResponse {
    let mut pool = workers.lock().await;
    match pool.get_mut(worker_id) {
        Some(worker) => {
            // If the worker window died, we can't recover it transparently (its
            // tmux session/context is gone) — report so the caller can recreate.
            if worker.is_dead().await {
                return IpcResponse::Error { message: format!("worker {worker_id} window is dead — recreate the team") };
            }
            // Retry with backoff on retriable errors (e.g. transient model errors).
            let config = crate::fallback::RetryConfig::default();
            let mut delay = config.initial_delay_ms;
            for attempt in 0..=config.max_retries {
                match worker.prompt(message).await {
                    Ok(text) => return IpcResponse::WorkerResponse { worker_id: worker_id.to_string(), text },
                    Err(e) => {
                        let err_str = e.to_string();
                        if attempt < config.max_retries && crate::fallback::is_retriable_error(&err_str) {
                            eprintln!("[orchestrator] {worker_id} attempt {} failed (retriable): {err_str}. Retrying in {delay}ms...", attempt + 1);
                            tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
                            delay = (delay as f64 * config.backoff_factor) as u64;
                            continue;
                        }
                        return IpcResponse::Error { message: format!("worker {worker_id} error: {err_str}") };
                    }
                }
            }
            IpcResponse::Error { message: format!("worker {worker_id}: max retries exceeded") }
        }
        None => IpcResponse::Error { message: format!("worker '{worker_id}' not found") },
    }
}

async fn broadcast(workers: &WorkerPool, message: &str) -> IpcResponse {
    // Run all workers in PARALLEL: a hyperplan round otherwise costs the SUM
    // of 5 model calls (often 2-3 min, blowing the IPC timeout). Parallel
    // makes a round cost ~the slowest single worker.
    //
    // tmux workers hold no clonable handle, but Worker only stores ids/paths
    // (the live process is in tmux), so we still take them out to run prompts
    // concurrently, then reinsert. Worker sessions persist in tmux regardless.
    let taken: Vec<(String, Worker)> = {
        let mut pool = workers.lock().await;
        let ids: Vec<String> = pool.keys().cloned().collect();
        ids.into_iter().filter_map(|id| pool.remove(&id).map(|w| (id, w))).collect()
    };

    let msg = message.to_string();
    let mut handles = Vec::new();
    for (id, mut worker) in taken {
        let m = msg.clone();
        handles.push(tokio::spawn(async move {
            let result = match worker.prompt(&m).await {
                Ok(text) => WorkerResult { worker_id: id.clone(), text },
                Err(e) => WorkerResult { worker_id: id.clone(), text: format!("[error: {e}]") },
            };
            // Return the worker so the pool can reclaim it (session persists).
            (id, worker, result)
        }));
    }

    let mut responses = Vec::new();
    for handle in handles {
        match handle.await {
            Ok((id, worker, result)) => {
                workers.lock().await.insert(id, worker);
                responses.push(result);
            }
            Err(e) => {
                // Task panicked/cancelled — the worker is lost; report it.
                responses.push(WorkerResult { worker_id: "<unknown>".to_string(), text: format!("[broadcast task failed: {e}]") });
            }
        }
    }
    // Stable ordering by worker id so round-over-round output is comparable.
    responses.sort_by(|a, b| a.worker_id.cmp(&b.worker_id));
    IpcResponse::BroadcastResult { responses }
}

/// Internal broadcast that returns the raw results (used by the hyperplan job).
async fn broadcast_raw(workers: &WorkerPool, message: &str) -> Vec<WorkerResult> {
    match broadcast(workers, message).await {
        IpcResponse::BroadcastResult { responses } => responses,
        _ => Vec::new(),
    }
}

async fn stop_worker(workers: &WorkerPool, worker_id: &str) -> IpcResponse {
    if let Some(worker) = workers.lock().await.remove(worker_id) {
        worker.shutdown().await;
    }
    IpcResponse::Stopped
}

async fn stop_all(workers: &WorkerPool) -> IpcResponse {
    let taken: HashMap<String, Worker> = std::mem::take(&mut *workers.lock().await);
    for (_, worker) in taken {
        worker.shutdown().await;
    }
    IpcResponse::Stopped
}

/// Graceful pause: snapshot the current team (with prime_messages for resume),
/// kill all worker windows, then signal the run loop to exit. The caller
/// (main.rs Serve/Start handler) cleans up the IPC socket + pid lock after
/// run() returns.
///
/// Order matters:
///  1. Snapshot FIRST — even if a kill_window fails, the team roster is saved.
///  2. Kill windows AFTER snapshot — so resume knows the exact prime to replay.
///  3. Notify shutdown LAST — so the response reaches the client before the
///     orchestrator tears down the listener.
async fn pause(
    workers: &WorkerPool,
    env: &WorkerEnv,
    shutdown: Arc<Notify>,
) -> IpcResponse {
    let worker_snapshots: Vec<WorkerSnapshot> = {
        let pool = workers.lock().await;
        pool.iter()
            .map(|(id, w)| WorkerSnapshot {
                id: id.clone(),
                model: w.model().to_string(),
                prime_message: w.prime_message().map(|s| s.to_string()),
            })
            .collect()
    };

    let snap = OrchestratorSnapshot {
        model: env.default_model.clone(),
        extension: None,
        session_dir: Some(env.cwd.join(".tokyo").join("sessions").to_string_lossy().into_owned()),
        workers: worker_snapshots,
        paused_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs().to_string())
            .unwrap_or_default(),
        phase: None,
    };

    let snap_path = match snapshot::save_snapshot(&env.cwd, &snap) {
        Ok(p) => p,
        Err(e) => {
            return IpcResponse::Error {
                message: format!("pause: failed to save snapshot: {e}"),
            };
        }
    };
    eprintln!("[orchestrator] pause: snapshot saved ({} workers) at {}", snap.workers.len(), snap_path.display());

    let taken: HashMap<String, Worker> = std::mem::take(&mut *workers.lock().await);
    for (id, worker) in taken {
        worker.shutdown().await;
        eprintln!("[orchestrator] pause: killed worker {id}");
    }

    shutdown.notify_one();

    IpcResponse::Paused {
        snapshot_path: snap_path.to_string_lossy().into_owned(),
    }
}

/// Recreate a single worker from a snapshot entry. Spawns a fresh tmux window
/// (the old one was killed by pause) and primes it with the saved message, so
/// the worker's role identity survives the pause/resume cycle.
async fn restore_worker(
    workers: &WorkerPool,
    env: &WorkerEnv,
    id: &str,
    model: &str,
    prime_message: &str,
) -> IpcResponse {
    let session = match &env.session {
        Some(s) => s.clone(),
        None => {
            return IpcResponse::Error {
                message: "no tmux session — cannot restore workers. Use the tokyo launcher.".to_string(),
            };
        }
    };

    if let Some(old) = workers.lock().await.remove(id) {
        old.shutdown().await;
    }

    let mut w = match Worker::spawn(&session, id, model, &env.cwd, None).await {
        Ok(w) => w,
        Err(e) => return IpcResponse::Error { message: format!("restore {id}: spawn failed: {e}") },
    };

    if let Err(e) = w.prompt(prime_message).await {
        return IpcResponse::Error { message: format!("restore {id}: prime failed: {e}") };
    }
    w.set_prime_message(prime_message);

    workers.lock().await.insert(id.to_string(), w);
    eprintln!("[orchestrator] restored worker {id}");
    IpcResponse::WorkerRestored { id: id.to_string() }
}

async fn status(workers: &WorkerPool) -> IpcResponse {
    let pool = workers.lock().await;
    let mut out = Vec::new();
    for (id, w) in pool.iter() {
        out.push(WorkerStatus { id: id.clone(), alive: w.is_alive().await });
    }
    IpcResponse::StatusResult { workers: out }
}

async fn merge_worker(workers: &WorkerPool, worker_id: &str, strategy: &str) -> IpcResponse {
    // Stop the worker first (closes its worktree files)
    if let Some(worker) = workers.lock().await.remove(worker_id) {
        worker.shutdown().await;
    }

        let project = std::env::current_dir().unwrap_or_default();
        let worktree_dir = project.join(".tokyo").join("worktrees").join(worker_id);

        if !worktree_dir.exists() {
            return IpcResponse::Error { message: format!("No worktree for worker '{worker_id}'") };
        }

        // Merge based on strategy
        let result = match strategy {
            "cherry-pick" => {
                // Get the latest commit from the worker branch
                let branch = format!("tokyo-worker/{worker_id}");
                let output = std::process::Command::new("git")
                    .args(["worktree", "remove", "--force", worktree_dir.to_str().unwrap()])
                    .current_dir(&project)
                    .output();
                let _ = output;
                let output = std::process::Command::new("git")
                    .args(["cherry-pick", &branch])
                    .current_dir(&project)
                    .output();
                match output {
                    Ok(o) if o.status.success() => format!("cherry-picked {branch}"),
                    Ok(o) => {
                        let _ = std::process::Command::new("git").args(["cherry-pick", "--abort"]).current_dir(&project).output();
                        format!("cherry-pick conflict: {}", String::from_utf8_lossy(&o.stderr))
                    }
                    Err(e) => format!("cherry-pick failed: {e}"),
                }
            }
            "rebase" => {
                let branch = format!("tokyo-worker/{worker_id}");
                let _ = std::process::Command::new("git")
                    .args(["worktree", "remove", "--force", worktree_dir.to_str().unwrap()])
                    .current_dir(&project).output();
                let output = std::process::Command::new("git")
                    .args(["rebase", &branch])
                    .current_dir(&project).output();
                match output {
                    Ok(o) if o.status.success() => format!("rebased onto {branch}"),
                    Ok(o) => {
                        let _ = std::process::Command::new("git").args(["rebase", "--abort"]).current_dir(&project).output();
                        format!("rebase conflict: {}", String::from_utf8_lossy(&o.stderr))
                    }
                    Err(e) => format!("rebase failed: {e}"),
                }
            }
            _ => {
                // Default: no-ff merge
                match crate::worktree::merge_and_cleanup(&project, worker_id) {
                    Ok(r) => r,
                    Err(e) => format!("merge failed: {e}"),
                }
            }
        };

        // Clean up branch
        let branch = format!("tokyo-worker/{worker_id}");
        let _ = std::process::Command::new("git").args(["branch", "-D", &branch]).current_dir(&project).output();

        IpcResponse::MergeResult { worker_id: worker_id.to_string(), result }
}

/// Start a background hyperplan job. Returns immediately with a job_id; the 3
/// rounds run in a spawned task that updates the job registry as it progresses.
async fn hyperplan_run(
    workers: WorkerPool,
    jobs: JobRegistry,
    objective: String,
) -> IpcResponse {
    // Need a live team to drive. If the pool is empty, the caller must create
    // the hyperplan team first.
    let member_count = workers.lock().await.len();
    if member_count == 0 {
        return IpcResponse::Error {
            message: "no workers in pool — create the hyperplan team (tokyo_team op:create preset:hyperplan) before hyperplan_run".to_string(),
        };
    }

    let job_id = format!("hp-{}", std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0));
    const TOTAL_ROUNDS: u32 = 3;

    jobs.lock().await.insert(job_id.clone(), HyperplanJob {
        status: "running".to_string(),
        round: 0,
        total_rounds: TOTAL_ROUNDS,
        result: None,
        error: None,
    });

    let jobs_bg = jobs.clone();
    let job_id_bg = job_id.clone();
    tokio::spawn(async move {
        let update = |round: u32| {
            let jobs = jobs_bg.clone();
            let id = job_id_bg.clone();
            async move {
                if let Some(j) = jobs.lock().await.get_mut(&id) { j.round = round; }
            }
        };

        // Round 1 — initial critiques.
        let r1 = broadcast_raw(&workers, &format!(
            "TASK TO ANALYZE:\n{objective}\n\nROUND 1: Produce your initial findings/critiques. Be specific, concrete, hostile. Numbered list, ≤3 sentences each."
        )).await;
        let r1_text = join_results(&r1);
        update(1).await;

        // Round 2 — cross-critique.
        let r2 = broadcast_raw(&workers, &format!(
            "ROUND 2 — CROSS-CRITIQUE.\n\nOther members' findings from round 1:\n\n{r1_text}\n\nATTACK their findings. Kill the weak ones. Defend or strengthen yours. Numbered list, ≤3 sentences each."
        )).await;
        let r2_text = join_results(&r2);
        update(2).await;

        // Round 3 — final surviving insights.
        let r3 = broadcast_raw(&workers, &format!(
            "ROUND 3 — FINAL CRITIQUE.\n\nRound 2 findings:\n\n{r2_text}\n\nLast chance. Kill anything that doesn't survive. State your TOP 3 surviving insights that withstood all attacks. Numbered list."
        )).await;
        let r3_text = join_results(&r3);
        update(3).await;

        let synthesis = format!(
            "# Hyperplan Results (3 rounds × {} members)\n\n## Round 1 — Initial Critiques\n{r1_text}\n\n## Round 2 — Cross-Critique\n{r2_text}\n\n## Round 3 — Surviving Insights\n{r3_text}",
            r1.len()
        );

        if let Some(j) = jobs_bg.lock().await.get_mut(&job_id_bg) {
            j.status = "done".to_string();
            j.result = Some(synthesis);
        }
    });

    IpcResponse::HyperplanStarted { job_id, members: member_count }
}

fn join_results(results: &[WorkerResult]) -> String {
    results.iter()
        .map(|r| format!("--- {} ---\n{}", r.worker_id, r.text))
        .collect::<Vec<_>>()
        .join("\n\n")
}

async fn hyperplan_status(jobs: &JobRegistry, job_id: &str) -> IpcResponse {
    match jobs.lock().await.get(job_id) {
        Some(j) => IpcResponse::HyperplanProgress {
            job_id: job_id.to_string(),
            status: j.status.clone(),
            round: j.round,
            total_rounds: j.total_rounds,
            result: j.result.clone(),
            error: j.error.clone(),
        },
        None => IpcResponse::Error { message: format!("no hyperplan job '{job_id}'") },
    }
}

/// Block until the job leaves "running", then return its final progress. Lets the
/// extension await completion in the background and inject a notification with no
/// client-side polling. Bounded so a lost/never-finishing job can't hang forever.
async fn hyperplan_wait(jobs: &JobRegistry, job_id: &str) -> IpcResponse {
    const MAX_WAIT: std::time::Duration = std::time::Duration::from_secs(30 * 60);
    let started = std::time::Instant::now();
    loop {
        {
            let guard = jobs.lock().await;
            match guard.get(job_id) {
                Some(j) if j.status != "running" => {
                    return IpcResponse::HyperplanProgress {
                        job_id: job_id.to_string(),
                        status: j.status.clone(),
                        round: j.round,
                        total_rounds: j.total_rounds,
                        result: j.result.clone(),
                        error: j.error.clone(),
                    };
                }
                Some(_) => { /* still running — fall through to sleep */ }
                None => return IpcResponse::Error { message: format!("no hyperplan job '{job_id}'") },
            }
        }
        if started.elapsed() > MAX_WAIT {
            return IpcResponse::HyperplanProgress {
                job_id: job_id.to_string(),
                status: "failed".to_string(),
                round: 0,
                total_rounds: 3,
                result: None,
                error: Some("hyperplan_wait exceeded 30 minutes".to_string()),
            };
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
}
