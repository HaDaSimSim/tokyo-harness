//! IPC server: listens on a Unix domain socket for commands from the tokyo extension.
//!
//! The extension (running inside the Lead pi process) connects here to manage workers.
//! Protocol: one JSON object per line (JSONL), bidirectional.

use std::path::{Path, PathBuf};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::mpsc;
use serde::{Deserialize, Serialize};

/// Commands the extension can send to the orchestrator.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum IpcCommand {
    /// Create a team with the given workers.
    CreateTeam {
        team_id: String,
        workers: Vec<WorkerSpec>,
    },
    /// Send a message to a specific worker.
    Send {
        worker_id: String,
        message: String,
    },
    /// Broadcast a message to all workers in the active team.
    Broadcast {
        message: String,
    },
    /// Shut down a specific worker.
    StopWorker {
        worker_id: String,
    },
    /// Shut down the entire team.
    StopTeam,
    /// Get the status of all workers.
    Status,
    /// Merge a worker's git worktree branch back into main.
    MergeWorker {
        worker_id: String,
        /// Merge strategy: "no-ff" (default), "cherry-pick", or "rebase"
        #[serde(default = "default_merge_strategy")]
        strategy: String,
    },
    /// Start a hyperplan run (5 hostile members × 3 cross-critique rounds) as a
    /// BACKGROUND job. Returns a job_id immediately; the rounds run async so the
    /// Lead is never blocked. Poll with HyperplanStatus.
    HyperplanRun {
        objective: String,
    },
    /// Poll the status/result of a background hyperplan job.
    HyperplanStatus {
        job_id: String,
    },
    /// Block until a background hyperplan job finishes (done/failed), then return
    /// its final progress. Used by the extension to await completion in the
    /// background and inject a notification (no client-side polling).
    HyperplanWait {
        job_id: String,
    },
}

fn default_merge_strategy() -> String { "no-ff".to_string() }

#[derive(Debug, Deserialize, Clone)]
pub struct WorkerSpec {
    pub id: String,
    pub model: String,
    pub system_prompt: String,
}

/// Responses sent back to the extension.
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum IpcResponse {
    TeamCreated { team_id: String, worker_ids: Vec<String> },
    WorkerResponse { worker_id: String, text: String },
    BroadcastResult { responses: Vec<WorkerResult> },
    MergeResult { worker_id: String, result: String },
    Stopped,
    StatusResult { workers: Vec<WorkerStatus> },
    /// Returned by HyperplanRun: the background job was accepted.
    HyperplanStarted { job_id: String, members: usize },
    /// Returned by HyperplanStatus: current progress + result when done.
    HyperplanProgress {
        job_id: String,
        /// "running" | "done" | "failed"
        status: String,
        /// completed rounds so far (0..=total_rounds)
        round: u32,
        total_rounds: u32,
        /// distilled synthesis, present only when status == "done"
        result: Option<String>,
        /// error detail, present only when status == "failed"
        error: Option<String>,
    },
    Error { message: String },
}

#[derive(Debug, Serialize)]
pub struct WorkerResult {
    pub worker_id: String,
    pub text: String,
}

#[derive(Debug, Serialize)]
pub struct WorkerStatus {
    pub id: String,
    pub alive: bool,
}

/// Channel message from the socket handler to the main orchestrator loop.
pub struct IpcMessage {
    pub command: IpcCommand,
    pub respond: tokio::sync::oneshot::Sender<IpcResponse>,
}

/// Start the IPC server on a Unix socket. Returns a channel to receive commands.
pub async fn start_ipc_server(socket_path: &Path) -> anyhow::Result<mpsc::Receiver<IpcMessage>> {
    // Ensure parent directory exists first
    if let Some(parent) = socket_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    // Instance lock: check if another orchestrator is already running via PID file
    let lock_path = socket_path.with_extension("pid");
    if lock_path.exists() {
        if let Ok(pid_str) = std::fs::read_to_string(&lock_path) {
            if let Ok(pid) = pid_str.trim().parse::<u32>() {
                // Check if the process is still alive
                let alive = unsafe { libc::kill(pid as i32, 0) } == 0;
                if alive {
                    anyhow::bail!("Another orchestrator is already running (pid {pid}). Kill it or remove {}", lock_path.display());
                }
            }
        }
        // Stale lock — remove it
        let _ = std::fs::remove_file(&lock_path);
    }

    // Write our PID lock
    std::fs::write(&lock_path, std::process::id().to_string())?;

    // Remove stale socket file if it exists
    if socket_path.exists() {
        std::fs::remove_file(socket_path)?;
    }

    let listener = UnixListener::bind(socket_path)?;
    let (tx, rx) = mpsc::channel::<IpcMessage>(32);

    tokio::spawn(async move {
        loop {
            match listener.accept().await {
                Ok((stream, _)) => {
                    let tx = tx.clone();
                    tokio::spawn(handle_connection(stream, tx));
                }
                Err(e) => {
                    // M5 fix: don't break on transient errors, just log and continue
                    eprintln!("[ipc] accept error (continuing): {e}");
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                }
            }
        }
    });

    Ok(rx)
}

async fn handle_connection(stream: UnixStream, tx: mpsc::Sender<IpcMessage>) {
    let (reader, mut writer) = stream.into_split();
    let mut buf_reader = BufReader::new(reader);
    let mut line = String::new();

    loop {
        line.clear();
        match buf_reader.read_line(&mut line).await {
            Ok(0) => break, // client disconnected
            Ok(_) => {
                let trimmed = line.trim();
                if trimmed.is_empty() { continue; }

                let cmd: IpcCommand = match serde_json::from_str(trimmed) {
                    Ok(c) => c,
                    Err(e) => {
                        let err = IpcResponse::Error { message: format!("parse error: {e}") };
                        let mut resp_line = serde_json::to_string(&err).unwrap();
                        resp_line.push('\n');
                        let _ = writer.write_all(resp_line.as_bytes()).await;
                        continue;
                    }
                };

                let (resp_tx, resp_rx) = tokio::sync::oneshot::channel();
                let msg = IpcMessage { command: cmd, respond: resp_tx };

                if tx.send(msg).await.is_err() {
                    break; // orchestrator shut down
                }

                // Wait for the orchestrator to process and respond
                match resp_rx.await {
                    Ok(response) => {
                        let mut resp_line = serde_json::to_string(&response).unwrap();
                        resp_line.push('\n');
                        let _ = writer.write_all(resp_line.as_bytes()).await;
                    }
                    Err(_) => break,
                }
            }
            Err(e) => {
                eprintln!("[ipc] read error: {e}");
                break;
            }
        }
    }
}

/// Get the default socket path for a project directory.
pub fn default_socket_path(project_dir: &Path) -> PathBuf {
    project_dir.join(".tokyo").join("orchestrator.sock")
}
