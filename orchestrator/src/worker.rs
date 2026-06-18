//! Zellij-backed worker: a real, visible, interactive `pi` TUI running in its own
//! zellij tab. The orchestrator drives it like a subagent — inject a prompt via
//! zellij actions (switch-tab → write-chars → write 0x0D), then read the reply
//! by tailing the worker's session `.jsonl` until the assistant turn ends.
//!
//! Why not `pi --mode rpc` pipes? Because the team must be VISIBLE: you watch
//! each worker think and can type into its tab. The orchestrator injects prompts
//! via zellij actions targeting the worker tab, then reads replies from the
//! append-only session JSONL file.

use std::path::PathBuf;
use std::time::Duration;
use tokio::process::Command;

/// One interactive pi worker living in a zellij tab.
pub struct Worker {
    pub id: String,
    session: String,        // zellij session name
    tab: String,            // zellij tab name ("w-{id}")
    model: String,
    session_dir: PathBuf,   // pi --session-dir for this worker (where .jsonl lands)
    prime_message: Option<String>,
}

/// Result of locating a worker's live session file + read offset.
struct SessionCursor {
    file: PathBuf,
    offset: u64,
}

impl Worker {
    /// Spawn an interactive pi in a new zellij tab. The tab is named after the
    /// worker id so the user can find it and switch with Ctrl+o n.
    pub async fn spawn(
        session: &str,
        id: &str,
        model: &str,
        cwd: &PathBuf,
        _extension: Option<&str>,
    ) -> anyhow::Result<Self> {
        let session_dir = cwd.join(".tokyo").join("worker-sessions").join(id);
        std::fs::create_dir_all(&session_dir).ok();

        let pi_bin = crate::rpc::pi_bin();
        let mut pi_cmd = format!(
            "{} --session-dir {}",
            shell_quote(&pi_bin),
            shell_quote(&session_dir.to_string_lossy()),
        );
        pi_cmd.push_str(&format!(" --model {}", shell_quote(model)));
        // Extension is optional — workers inherit extension from parent pi if needed.
        // The orchestrator always passes None; workers discover via pi auto-discovery.

        let tab_name = format!("w-{id}");

        // zellij --session <session> action new-tab --name <name> --cwd <cwd> -- <cmd>
        let status = Command::new("zellij")
            .args([
                "--session", session,
                "action", "new-tab",
                "--name", &tab_name,
                "--cwd", &cwd.to_string_lossy(),
                "--", "sh", "-c", &pi_cmd,
            ])
            .status()
            .await?;
        if !status.success() {
            anyhow::bail!("zellij new-tab failed for worker {id}");
        }

        // Give pi a moment to boot its TUI.
        tokio::time::sleep(Duration::from_millis(1500)).await;
        Ok(Self {
            id: id.to_string(),
            session: session.to_string(),
            tab: tab_name,
            model: model.to_string(),
            session_dir,
            prime_message: None,
        })
    }

    /// Inject a prompt and wait for the worker's reply (assistant turn end).
    pub async fn prompt(&mut self, message: &str) -> anyhow::Result<String> {
        let cursor_before = self.session_cursor();
        let start_offset = cursor_before.as_ref().map(|c| c.offset).unwrap_or(0);

        self.inject(message).await?;

        // Poll the session file for a completed assistant turn.
        let deadline = std::time::Instant::now() + Duration::from_secs(20 * 60);
        let mut buf = String::new();
        let mut file_offset = start_offset;
        loop {
            if std::time::Instant::now() > deadline {
                anyhow::bail!("worker {} timed out waiting for reply", self.id);
            }
            if self.is_dead().await {
                anyhow::bail!("worker {} tab is dead", self.id);
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

    /// Inject text into the worker tab. Uses zellij actions: switch to the
    /// worker tab, write the prompt via write-chars, hit Enter, switch back
    /// to the lead tab. The focus switch is sub-100ms; the user may see a
    /// brief flicker but workflow continues uninterrupted.
    async fn inject(&self, message: &str) -> anyhow::Result<()> {
        // Write the prompt to a temp file so we can read and write-chars it.
        // (write-chars doesn't have a file-reading mode, so we send text inline.)
        let tmp = std::env::temp_dir().join(format!("tokyo-inject-{}-{}.txt", self.id, std::process::id()));
        tokio::fs::write(&tmp, message.as_bytes()).await?;

        // Switch to the worker tab.
        let _ = Command::new("zellij")
            .args([
                "--session", &self.session,
                "action", "switch-tab", "--name", &self.tab,
            ])
            .status()
            .await;

        // Send the text. For multi-line prompts, zellij write-chars handles
        // newlines as literal characters (not Enter) by default, which is
        // what we want — pi receives the full block as one input.
        let text = tokio::fs::read_to_string(&tmp).await.unwrap_or_default();
        let _ = Command::new("zellij")
            .args([
                "--session", &self.session,
                "action", "write-chars", "--", &text,
            ])
            .status()
            .await;

        // Submit.
        let _ = Command::new("zellij")
            .args([
                "--session", &self.session,
                "action", "write", "0x0D",
            ])
            .status()
            .await;

        // Switch back to the lead tab so the user isn't stranded.
        let _ = Command::new("zellij")
            .args([
                "--session", &self.session,
                "action", "switch-tab", "--name", "lead",
            ])
            .status()
            .await;

        let _ = tokio::fs::remove_file(&tmp).await;
        Ok(())
    }

    /// True if the worker's tab is gone or its session file is stale.
    pub async fn is_dead(&self) -> bool {
        // Check liveness by probing the session file: if it hasn't been
        // modified in the last 5 minutes (and no zellij session exists),
        // the worker is dead.
        let session_exists = Command::new("zellij")
            .args(["list-sessions"])
            .output()
            .await
            .map(|o| {
                String::from_utf8_lossy(&o.stdout)
                    .lines()
                    .any(|l| l.trim() == self.session)
            })
            .unwrap_or(false);
        if !session_exists {
            return true;
        }
        // Even if session exists, check if the worker's session file is stale.
        if let Some(file) = self.live_session_file() {
            if let Ok(meta) = std::fs::metadata(&file) {
                if let Ok(mtime) = meta.modified() {
                    let age = mtime.elapsed().unwrap_or(Duration::ZERO);
                    return age > Duration::from_secs(300); // 5 min stale = dead
                }
            }
        }
        false
    }

    pub async fn is_alive(&self) -> bool {
        !self.is_dead().await
    }

    pub fn set_prime_message(&mut self, msg: &str) {
        self.prime_message = Some(msg.to_string());
    }

    pub fn model(&self) -> &str {
        &self.model
    }

    pub fn prime_message(&self) -> Option<&str> {
        self.prime_message.as_deref()
    }

    /// Shut down the worker: close its zellij tab.
    pub async fn shutdown(&self) {
        // Switch to the tab first, then close it.
        let _ = Command::new("zellij")
            .args([
                "--session", &self.session,
                "action", "switch-tab", "--name", &self.tab,
            ])
            .status()
            .await;
        let _ = Command::new("zellij")
            .args([
                "--session", &self.session,
                "action", "close-tab",
            ])
            .status()
            .await;
        // Switch back to lead.
        let _ = Command::new("zellij")
            .args([
                "--session", &self.session,
                "action", "switch-tab", "--name", "lead",
            ])
            .status()
            .await;
    }

    fn session_cursor(&self) -> Option<SessionCursor> {
        let file = self.live_session_file()?;
        let len = std::fs::metadata(&file).ok()?.len();
        Some(SessionCursor { file, offset: len })
    }

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
/// stopReason != "toolUse"), return its accumulated text.
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
            Err(_) => continue,
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
        if let Some(content) = msg.get("content").and_then(|c| c.as_array()) {
            for part in content {
                if part.get("type").and_then(|t| t.as_str()) == Some("text") {
                    if let Some(t) = part.get("text").and_then(|t| t.as_str()) {
                        accumulated.push(t.to_string());
                    }
                }
            }
        }
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

/// Minimal POSIX shell single-quote escaping.
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}
