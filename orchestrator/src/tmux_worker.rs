//! Tmux-backed worker: a real, visible, interactive `pi` TUI running in its own
//! tmux window. The orchestrator drives it like a subagent — inject a prompt via
//! tmux (bracketed-paste so multi-line prompts don't submit early), then read the
//! reply by tailing the worker's session `.jsonl` until the assistant turn ends.
//!
//! Why not `pi --mode rpc` pipes? Because the whole point is that the team is
//! VISIBLE: you can watch each worker think and even type into its window. RPC
//! pipes are invisible. The tradeoff is we read replies from the session file
//! (append-only JSONL) instead of a stdout stream — verified reliable via spike:
//!   - completion marker: an assistant message whose stopReason != "toolUse"
//!   - session file is append-only, newline-terminated, one final assistant text
//!     per turn (no partial rewrites)

use std::path::PathBuf;
use std::time::Duration;
use tokio::process::Command;

/// One interactive pi worker living in a tmux window.
pub struct TmuxWorker {
    pub id: String,
    session: String,        // tmux session name
    window: String,         // tmux window target ("session:window")
    model: String,
    session_dir: PathBuf,   // pi --session-dir for this worker (where .jsonl lands)
    prime_message: Option<String>,
}

/// Result of locating a worker's live session file + read offset.
struct SessionCursor {
    file: PathBuf,
    offset: u64,
}

impl TmuxWorker {
    /// Spawn an interactive pi in a new tmux window and prime it. The window is
    /// named after the worker id so the user can find it (Ctrl-b w / Ctrl-b <n>).
    pub async fn spawn(
        session: &str,
        id: &str,
        model: &str,
        cwd: &PathBuf,
        extension: Option<&str>,
    ) -> anyhow::Result<Self> {
        // Per-worker session dir so we can tail exactly this worker's transcript.
        let session_dir = cwd.join(".tokyo").join("worker-sessions").join(id);
        std::fs::create_dir_all(&session_dir).ok();

        let pi_bin = crate::rpc::pi_bin();
        // Build the pi command. Interactive (no --mode rpc), with an explicit
        // session dir so the transcript path is deterministic.
        let mut pi_cmd = format!(
            "{} --session-dir {}",
            shell_quote(&pi_bin),
            shell_quote(&session_dir.to_string_lossy()),
        );
        pi_cmd.push_str(&format!(" --model {}", shell_quote(model)));
        if let Some(ext) = extension {
            pi_cmd.push_str(&format!(" -e {}", shell_quote(ext)));
        }

        // Create the window running pi directly (so pane_dead reflects pi's exit,
        // not a shell's). remain-on-exit keeps a dead worker visible for inspection.
        let window_name = format!("w-{id}");
        let status = Command::new("tmux")
            .args([
                "new-window",
                "-d",
                "-t", session,
                "-n", &window_name,
                "-c", &cwd.to_string_lossy(),
                &pi_cmd,
            ])
            .status()
            .await?;
        if !status.success() {
            anyhow::bail!("tmux new-window failed for worker {id}");
        }
        let window = format!("{session}:{window_name}");
        let _ = Command::new("tmux")
            .args(["set-option", "-t", &window, "remain-on-exit", "on"])
            .status()
            .await;

        let mut w = Self {
            id: id.to_string(),
            session: session.to_string(),
            window,
            model: model.to_string(),
            session_dir,
            prime_message: None,
        };

        // Give pi a moment to boot its TUI (enable bracketed paste etc.).
        tokio::time::sleep(Duration::from_millis(1500)).await;
        Ok(w)
    }

    /// Inject a prompt and wait for the worker's reply (assistant turn end).
    pub async fn prompt(&mut self, message: &str) -> anyhow::Result<String> {
        // Record where the transcript currently ends so we only read NEW output.
        let cursor_before = self.session_cursor().await;
        let start_offset = cursor_before.as_ref().map(|c| c.offset).unwrap_or(0);

        self.inject(message).await?;

        // Poll the session file for a completed assistant turn after our prompt.
        // Bounded so a stuck/never-answering worker can't hang forever.
        let deadline = std::time::Instant::now() + Duration::from_secs(20 * 60);
        let mut buf = String::new();
        let mut file_offset = start_offset;
        loop {
            if std::time::Instant::now() > deadline {
                anyhow::bail!("worker {} timed out waiting for reply", self.id);
            }
            // Worker window died?
            if self.is_dead().await {
                anyhow::bail!("worker {} window is dead", self.id);
            }
            if let Some(file) = self.live_session_file() {
                if let Ok((text, new_offset)) =
                    read_completed_reply(&file, file_offset, &mut buf).await
                {
                    file_offset = new_offset;
                    if let Some(reply) = text {
                        return Ok(reply);
                    }
                }
            }
            tokio::time::sleep(Duration::from_millis(400)).await;
        }
    }

    /// Inject text into the worker window using bracketed-paste wrapping so
    /// multi-line prompts arrive as ONE submission (verified: tmux turns raw
    /// newlines into Enter, which would submit early). Body via buffer (no shell
    /// escaping issues), Enter sent separately.
    async fn inject(&self, message: &str) -> anyhow::Result<()> {
        // Wrap in bracketed-paste markers manually: detached panes don't get the
        // -p auto-wrap, so we add ESC[200~ ... ESC[201~ ourselves.
        let wrapped = format!("\u{1b}[200~{}\u{1b}[201~", message);
        let tmp = std::env::temp_dir().join(format!("tokyo-inject-{}-{}.txt", self.id, std::process::id()));
        tokio::fs::write(&tmp, wrapped.as_bytes()).await?;

        let buf_name = format!("tokyo-{}", self.id);
        let load = Command::new("tmux")
            .args(["load-buffer", "-b", &buf_name, &tmp.to_string_lossy()])
            .status()
            .await?;
        if !load.success() {
            anyhow::bail!("tmux load-buffer failed for worker {}", self.id);
        }
        let paste = Command::new("tmux")
            .args(["paste-buffer", "-t", &self.window, "-b", &buf_name, "-d"])
            .status()
            .await?;
        if !paste.success() {
            anyhow::bail!("tmux paste-buffer failed for worker {}", self.id);
        }
        // Submit once.
        let _ = Command::new("tmux")
            .args(["send-keys", "-t", &self.window, "Enter"])
            .status()
            .await;
        let _ = tokio::fs::remove_file(&tmp).await;
        Ok(())
    }

    /// True if the worker's tmux window/pane is gone or its process exited.
    pub async fn is_dead(&self) -> bool {
        let out = Command::new("tmux")
            .args(["list-panes", "-t", &self.window, "-F", "#{pane_dead}"])
            .output()
            .await;
        match out {
            Ok(o) if o.status.success() => {
                let s = String::from_utf8_lossy(&o.stdout);
                // No panes listed (window gone) => dead. "1" => pane_dead.
                s.trim().is_empty() || s.trim().lines().any(|l| l.trim() == "1")
            }
            _ => true, // tmux errored / window missing
        }
    }

    /// is_dead but synchronous-friendly alias used by the pool liveness check.
    pub async fn is_alive(&self) -> bool {
        !self.is_dead().await
    }

    pub fn set_prime_message(&mut self, msg: &str) {
        self.prime_message = Some(msg.to_string());
    }

    /// Shut down the worker: kill its tmux window.
    pub async fn shutdown(&self) {
        let _ = Command::new("tmux")
            .args(["kill-window", "-t", &self.window])
            .status()
            .await;
    }

    /// Find the worker's live (most-recent) session .jsonl + current end offset.
    async fn session_cursor(&self) -> Option<SessionCursor> {
        let file = self.live_session_file()?;
        let len = std::fs::metadata(&file).ok()?.len();
        Some(SessionCursor { file, offset: len })
    }

    /// The most-recently-modified .jsonl under this worker's session dir.
    fn live_session_file(&self) -> Option<PathBuf> {
        let mut newest: Option<(std::time::SystemTime, PathBuf)> = None;
        let rd = std::fs::read_dir(&self.session_dir).ok()?;
        for entry in rd.flatten() {
            let p = entry.path();
            if p.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            if let Ok(meta) = entry.metadata() {
                if let Ok(mtime) = meta.modified() {
                    if newest.as_ref().map(|(t, _)| mtime > *t).unwrap_or(true) {
                        newest = Some((mtime, p));
                    }
                }
            }
        }
        newest.map(|(_, p)| p)
    }
}

/// Read newly-appended lines from `file` starting at `offset`; if a completed
/// assistant turn is found (a `message` with role=assistant and
/// stopReason != "toolUse"), return its accumulated text. Returns (None, new_offset)
/// when no complete turn is present yet. `buf` carries a partial trailing line
/// across polls.
async fn read_completed_reply(
    file: &PathBuf,
    offset: u64,
    buf: &mut String,
) -> anyhow::Result<(Option<String>, u64)> {
    use tokio::io::{AsyncReadExt, AsyncSeekExt};
    let mut f = tokio::fs::File::open(file).await?;
    let len = f.metadata().await?.len();
    if len <= offset {
        return Ok((None, offset));
    }
    f.seek(std::io::SeekFrom::Start(offset)).await?;
    let mut chunk = String::new();
    f.read_to_string(&mut chunk).await?;
    let new_offset = len;
    buf.push_str(&chunk);

    // Split into complete lines; keep the trailing partial (if any) in `buf`.
    let ends_with_nl = buf.ends_with('\n');
    let mut lines: Vec<String> = buf.split('\n').map(|s| s.to_string()).collect();
    let remainder = if ends_with_nl { String::new() } else { lines.pop().unwrap_or_default() };

    let mut accumulated: Vec<String> = Vec::new();
    let mut found_reply: Option<String> = None;
    for line in &lines {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let v: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue, // skip non-JSON / partial
        };
        if v.get("type").and_then(|t| t.as_str()) != Some("message") {
            continue;
        }
        let msg = match v.get("message") {
            Some(m) => m,
            None => continue,
        };
        if msg.get("role").and_then(|r| r.as_str()) != Some("assistant") {
            continue;
        }
        // Accumulate text parts of this assistant message.
        if let Some(content) = msg.get("content").and_then(|c| c.as_array()) {
            for part in content {
                if part.get("type").and_then(|t| t.as_str()) == Some("text") {
                    if let Some(t) = part.get("text").and_then(|t| t.as_str()) {
                        accumulated.push(t.to_string());
                    }
                }
            }
        }
        // Completion marker: stopReason present and != "toolUse".
        let stop = msg.get("stopReason").and_then(|s| s.as_str());
        if let Some(stop) = stop {
            if stop != "toolUse" {
                let text = accumulated.join("\n").trim().to_string();
                found_reply = Some(if text.is_empty() {
                    format!("(worker produced no text; stopReason={stop})")
                } else {
                    text
                });
            }
        }
    }

    *buf = remainder;
    Ok((found_reply, new_offset))
}

/// Minimal POSIX shell single-quote escaping for embedding paths in the tmux cmd.
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}
