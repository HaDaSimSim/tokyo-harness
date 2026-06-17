//! RPC Worker: spawns `pi --mode rpc` and communicates via JSONL over stdin/stdout.
//!
//! One RpcWorker = one long-lived `pi` process = one persistent session.
//! Context accumulates naturally across prompts (no --session-id tricks needed).
//! The process stays alive until explicitly shut down or stdin is closed.

use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use serde_json::Value;

/// Resolves the `pi` binary path via the same mechanism the TS extension uses.
pub fn pi_bin() -> String {
    // Prefer PI_BIN env, fall back to nvm-installed path, then bare "pi".
    if let Ok(p) = std::env::var("PI_BIN") {
        return p;
    }
    let nvm_path = dirs::home_dir()
        .map(|h| h.join(".nvm/versions/node/v24.14.0/bin/pi"))
        .filter(|p| p.exists())
        .map(|p| p.to_string_lossy().into_owned());
    nvm_path.unwrap_or_else(|| "pi".to_string())
}

pub struct RpcWorker {
    child: Child,
    stdin: tokio::process::ChildStdin,
    reader: BufReader<tokio::process::ChildStdout>,
    line_buf: String,
    request_id: u64,
    // Stored for respawn
    model: String,
    extension: Option<String>,
    session_dir: Option<String>,
    prime_message: Option<String>,
}

impl Drop for RpcWorker {
    fn drop(&mut self) {
        // Kill the child process to prevent leaks (C1 fix).
        // start_kill() is non-blocking and safe to call in Drop.
        let _ = self.child.start_kill();
    }
}

impl RpcWorker {
    /// Spawn a new `pi --mode rpc` process.
    ///
    /// - `model`: model identifier (e.g. "relay/claude-sonnet-4.5")
    /// - `extension`: optional path to a pi extension to load (-e)
    /// - `session_dir`: optional session storage directory
    /// - `cwd`: optional working directory for the child process (e.g. git worktree)
    pub async fn spawn(
        model: &str,
        extension: Option<&str>,
        session_dir: Option<&str>,
    ) -> anyhow::Result<Self> {
        Self::spawn_with_cwd(model, extension, session_dir, None).await
    }

    /// Spawn with an explicit working directory.
    pub async fn spawn_with_cwd(
        model: &str,
        extension: Option<&str>,
        session_dir: Option<&str>,
        cwd: Option<&str>,
    ) -> anyhow::Result<Self> {
        let bin = pi_bin();
        let mut cmd = if bin.ends_with(".mjs") || bin.ends_with(".js") {
            // For mock/test scripts: run via node
            let mut c = Command::new("node");
            c.arg(&bin);
            c
        } else {
            Command::new(&bin)
        };
        cmd.arg("--mode").arg("rpc");
        cmd.arg("--model").arg(model);

        if let Some(ext) = extension {
            cmd.arg("-e").arg(ext);
        }
        if let Some(dir) = session_dir {
            cmd.arg("--session-dir").arg(dir);
        } else {
            cmd.arg("--no-session");
        }

        cmd.stdin(Stdio::piped());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::inherit()); // Don't capture stderr — avoids pipe buffer deadlock (C2)

        if let Some(dir) = cwd {
            cmd.current_dir(dir);
        }

        let mut child = cmd.spawn()?;
        let stdin = child.stdin.take().expect("stdin piped");
        let stdout = child.stdout.take().expect("stdout piped");
        let reader = BufReader::new(stdout);

        Ok(Self {
            child,
            stdin,
            reader,
            line_buf: String::new(),
            request_id: 0,
            model: model.to_string(),
            extension: extension.map(|s| s.to_string()),
            session_dir: session_dir.map(|s| s.to_string()),
            prime_message: None,
        })
    }

    /// Check if the underlying pi process is still alive.
    pub fn is_alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    /// Respawn the worker if it died. Re-primes with the stored prime message.
    /// NOTE (M7): If spawned without --session-dir, conversation history beyond the
    /// prime is lost on respawn. Use --session-dir for durable context across crashes.
    pub async fn respawn_if_dead(&mut self) -> anyhow::Result<bool> {
        if self.is_alive() {
            return Ok(false); // still alive, no action
        }
        // Respawn
        let new = Self::spawn(
            &self.model,
            self.extension.as_deref(),
            self.session_dir.as_deref(),
        ).await?;
        let prime = self.prime_message.clone();
        *self = new;
        // Re-prime if there was a prime message
        if let Some(msg) = prime {
            self.prime_message = Some(msg.clone());
            self.prompt(&msg).await?;
        }
        Ok(true) // was dead, now respawned
    }

    /// Store a prime message for respawn recovery.
    pub fn set_prime_message(&mut self, msg: &str) {
        self.prime_message = Some(msg.to_string());
    }

    /// Send a prompt and wait for the full response text (blocks until agent_end).
    pub async fn prompt(&mut self, message: &str) -> anyhow::Result<String> {
        self.prompt_streaming(message, None::<fn(&str)>).await
    }

    /// Send a prompt with optional streaming callback. The callback receives each text
    /// delta as it arrives; the full accumulated text is still returned at the end.
    pub async fn prompt_streaming<F>(&mut self, message: &str, on_delta: Option<F>) -> anyhow::Result<String>
    where
        F: FnMut(&str),
    {
        self.request_id += 1;
        let id = format!("req-{}", self.request_id);

        let cmd = serde_json::json!({
            "id": id,
            "type": "prompt",
            "message": message,
        });

        // Write command as a single JSONL line
        let mut line = serde_json::to_string(&cmd)?;
        line.push('\n');
        self.stdin.write_all(line.as_bytes()).await?;
        self.stdin.flush().await?;

        // Read events until agent_end
        let mut full_text = String::new();
        let mut got_response = false;
        let mut callback = on_delta;

        loop {
            self.line_buf.clear();
            let n = self.reader.read_line(&mut self.line_buf).await?;
            if n == 0 {
                anyhow::bail!("pi process exited unexpectedly");
            }

            let trimmed = self.line_buf.trim_end_matches(['\n', '\r']);
            if trimmed.is_empty() {
                continue;
            }

            let obj: Value = match serde_json::from_str(trimmed) {
                Ok(v) => v,
                Err(_) => continue,
            };

            let event_type = obj.get("type").and_then(|t| t.as_str()).unwrap_or("");

            match event_type {
                "response" => {
                    let success = obj.get("success").and_then(|s| s.as_bool()).unwrap_or(false);
                    if !success {
                        let err = obj.get("error").and_then(|e| e.as_str()).unwrap_or("unknown");
                        anyhow::bail!("prompt rejected: {err}");
                    }
                    got_response = true;
                }
                "message_update" => {
                    if let Some(evt) = obj.get("assistantMessageEvent") {
                        let delta_type = evt.get("type").and_then(|t| t.as_str()).unwrap_or("");
                        if delta_type == "text_delta" {
                            if let Some(delta) = evt.get("delta").and_then(|d| d.as_str()) {
                                full_text.push_str(delta);
                                if let Some(ref mut cb) = callback {
                                    cb(delta);
                                }
                            }
                        }
                    }
                }
                "agent_end" => {
                    break;
                }
                "extension_ui_request" => {
                    self.dismiss_ui_request(&obj).await?;
                }
                _ => {}
            }
        }

        if !got_response {
            anyhow::bail!("never received command response before agent_end");
        }

        Ok(full_text)
    }

    /// Send a prompt with a timeout. Returns error if worker doesn't respond within duration.
    pub async fn prompt_timeout(&mut self, message: &str, timeout: std::time::Duration) -> anyhow::Result<String> {
        match tokio::time::timeout(timeout, self.prompt(message)).await {
            Ok(result) => result,
            Err(_) => anyhow::bail!("worker response timed out after {}s", timeout.as_secs()),
        }
    }

    /// Send a steering message (delivered after current turn's tool calls finish).
    pub async fn steer(&mut self, message: &str) -> anyhow::Result<()> {
        let cmd = serde_json::json!({
            "type": "steer",
            "message": message,
        });
        let mut line = serde_json::to_string(&cmd)?;
        line.push('\n');
        self.stdin.write_all(line.as_bytes()).await?;
        self.stdin.flush().await?;
        Ok(())
    }

    /// Abort the current agent operation.
    pub async fn abort(&mut self) -> anyhow::Result<()> {
        let cmd = serde_json::json!({ "type": "abort" });
        let mut line = serde_json::to_string(&cmd)?;
        line.push('\n');
        self.stdin.write_all(line.as_bytes()).await?;
        self.stdin.flush().await?;
        Ok(())
    }

    /// Gracefully shut down: kill the child and wait for it to exit.
    /// Drop also kills, but this method awaits clean termination.
    pub async fn shutdown(mut self) -> anyhow::Result<()> {
        self.child.start_kill()?;
        self.child.wait().await?;
        Ok(())
    }

    /// Auto-dismiss extension UI dialog requests with defaults.
    async fn dismiss_ui_request(&mut self, obj: &Value) -> anyhow::Result<()> {
        let Some(id) = obj.get("id").and_then(|i| i.as_str()) else {
            return Ok(());
        };
        let method = obj.get("method").and_then(|m| m.as_str()).unwrap_or("");

        // Only respond to dialog methods (select/confirm/input/editor).
        // Fire-and-forget (notify/setStatus/setWidget/setTitle) need no response.
        let response = match method {
            "confirm" => serde_json::json!({
                "type": "extension_ui_response",
                "id": id,
                "confirmed": true,
            }),
            "select" => {
                // Pick first option if available
                let first = obj.get("options")
                    .and_then(|o| o.as_array())
                    .and_then(|a| a.first())
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                serde_json::json!({
                    "type": "extension_ui_response",
                    "id": id,
                    "value": first,
                })
            }
            "input" | "editor" => serde_json::json!({
                "type": "extension_ui_response",
                "id": id,
                "cancelled": true,
            }),
            _ => return Ok(()), // fire-and-forget, no response needed
        };

        let mut line = serde_json::to_string(&response)?;
        line.push('\n');
        self.stdin.write_all(line.as_bytes()).await?;
        self.stdin.flush().await?;
        Ok(())
    }
}
