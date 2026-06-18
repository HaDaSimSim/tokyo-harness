use clap::Parser;

mod rpc;
mod worker;
mod team;
mod ipc;
mod orchestrator;
mod hyperplan;
mod tui;
mod worktree;
mod snapshot;
mod fallback;

#[derive(Parser)]
#[command(name = "tokyo", about = "Tokyo workflow orchestrator")]
enum Cli {
    /// Start a lead session (and optional workers)
    Start {
        /// Model for the lead session
        #[arg(long, default_value = "relay/claude-opus-4.8")]
        model: String,

        /// Path to tokyo extension (auto-resolved from TOKYO_EXTENSION or ~/projects/tokyo-harness/extension/index.ts)
        #[arg(long)]
        extension: Option<String>,

        /// Project directory (where .tokyo/ lives). Defaults to cwd.
        #[arg(long)]
        project_dir: Option<String>,

        /// Session directory for persistent sessions (enables resume across restarts)
        #[arg(long)]
        session_dir: Option<String>,

        /// Launch TUI dashboard (ratatui terminal UI)
        #[arg(long)]
        tui: bool,

        /// Initial prompt
        #[arg(short, long)]
        prompt: Option<String>,
    },
    /// Quick RPC round-trip test (dev/debug)
    Ping {
        /// Model to use
        #[arg(long, default_value = "relay/claude-sonnet-4.5")]
        model: String,

        /// Message to send
        #[arg(default_value = "Say hello in one word.")]
        message: String,
    },
    /// Serve-only: run the IPC server + worker pool in the foreground, with NO
    /// Lead session and NO TUI. Used by the `tokyo` launcher as a background
    /// sidecar so the user's interactive pi TUI can connect to the socket.
    Serve {
        /// Model for on-demand workers
        #[arg(long, default_value = "relay/claude-opus-4.8")]
        model: String,

        /// Project directory (where .tokyo/ lives). Defaults to cwd.
        #[arg(long)]
        project_dir: Option<String>,

        /// zellij session name that owns the Lead + worker windows. When set,
        /// workers are spawned as visible interactive pi windows in this session
        /// (driven via tmux) instead of headless RPC pipes.
        #[arg(long)]
        session: Option<String>,
    },
    /// Multi-round persistence test: verifies context carries across prompts
    TestPersist {
        /// Model to use
        #[arg(long, default_value = "relay/claude-sonnet-4.5")]
        model: String,
    },
    /// Team test: spawn lead + 2 workers, broadcast a task, collect responses
    TeamTest {
        /// Model for all members
        #[arg(long, default_value = "relay/claude-sonnet-4.5")]
        model: String,
    },
    /// Run hyperplan: 5 adversarial members × 3 rounds of cross-critique
    Hyperplan {
        /// Model for all members
        #[arg(long, default_value = "relay/claude-sonnet-4.5")]
        model: String,

        /// The task/problem to analyze
        task: String,
    },
    /// Pause: snapshot state and shut down all workers
    Pause {
        /// Project directory
        #[arg(long)]
        project_dir: Option<String>,
    },
    /// Resume: restore from snapshot and re-spawn workers
    Resume {
        /// Project directory
        #[arg(long)]
        project_dir: Option<String>,

        /// Model override (defaults to snapshot's model)
        #[arg(long)]
        model: Option<String>,
    },
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Default to "start" when no subcommand given
    let cli = {
        let mut args: Vec<String> = std::env::args().collect();
        if args.len() == 1 || (args.len() > 1 && args[1].starts_with('-')) {
            args.insert(1, "start".to_string());
        }
        Cli::parse_from(args)
    };
    match cli {
        Cli::Ping { model, message } => {
            println!("[tokyo] ping: spawning pi --mode rpc --model {model}");
            let mut worker = rpc::RpcWorker::spawn(&model, None, None).await?;
            println!("[tokyo] sending prompt: {message}");
            let response = worker.prompt(&message).await?;
            println!("[tokyo] response:\n{response}");
            worker.shutdown().await?;
            println!("[tokyo] done");
        }
        Cli::Serve { model, project_dir, session } => {
            let cwd = match project_dir {
                Some(ref d) => std::path::PathBuf::from(d),
                None => std::env::current_dir()?,
            };
            let sock_path = ipc::default_socket_path(&cwd);
            eprintln!("[tokyo-serve] model={model}");
            eprintln!("[tokyo-serve] project: {}", cwd.display());
            eprintln!("[tokyo-serve] ipc socket: {}", sock_path.display());
            match session {
                Some(ref s) => eprintln!("[tokyo-serve] zellij session: {s} (workers spawn as visible windows)"),
                None => eprintln!("[tokyo-serve] no zellij session — workers unavailable"),
            }

            // IPC server + worker pool only. No Lead, no TUI — the user's pi TUI
            // (launched separately by bin/tokyo) is the Lead and connects here.
            let ipc_rx = ipc::start_ipc_server(&sock_path).await?;
            let mut orch = orchestrator::Orchestrator::new(&model, session, cwd.clone());
            eprintln!("[tokyo-serve] ready — workers spawn on-demand via IPC");

            // Run the orchestrator loop until the socket is removed or we're killed.
            // The launcher cleans up the socket on TUI exit; also handle Ctrl-C.
            let sock_for_signal = sock_path.clone();
            tokio::select! {
                _ = orch.run(ipc_rx) => {}
                _ = tokio::signal::ctrl_c() => {
                    eprintln!("[tokyo-serve] interrupted (SIGINT)");
                }
                _ = async {
                    // Also handle SIGTERM (what the launcher's `kill` sends on TUI exit).
                    match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
                        Ok(mut sig) => { sig.recv().await; }
                        Err(_) => { std::future::pending::<()>().await; }
                    }
                } => {
                    eprintln!("[tokyo-serve] terminated (SIGTERM)");
                }
            }
            // Guaranteed cleanup of socket + PID lock on all exit paths.
            let _ = std::fs::remove_file(&sock_for_signal);
            let _ = std::fs::remove_file(sock_for_signal.with_extension("pid"));
            eprintln!("[tokyo-serve] stopped");
        }
        Cli::Start { model, extension, prompt, project_dir, session_dir, tui: use_tui } => {
            // Resolve extension path: CLI arg > TOKYO_EXTENSION env > default path
            let extension = extension.unwrap_or_else(|| {
                std::env::var("TOKYO_EXTENSION").unwrap_or_else(|_| {
                    let home = dirs::home_dir().unwrap_or_default();
                    home.join("projects/tokyo-harness/extension/index.ts")
                        .to_string_lossy().into_owned()
                })
            });

            let cwd = match project_dir {
                Some(ref d) => std::path::PathBuf::from(d),
                None => std::env::current_dir()?,
            };
            let sock_path = ipc::default_socket_path(&cwd);
            println!("[tokyo] start: model={model}, extension={extension}");
            println!("[tokyo] project: {}", cwd.display());
            println!("[tokyo] ipc socket: {}", sock_path.display());

            // Start IPC server for extension communication
            let ipc_rx = ipc::start_ipc_server(&sock_path).await?;

            // Start orchestrator loop in background (workers spawn on-demand via IPC).
            // NOTE: this legacy `start` path runs its own RPC Lead and has no tmux
            // session, so team/worker spawning is unavailable here (use `serve` via
            // the tokyo launcher for the tmux-backed team).
            let mut orch = orchestrator::Orchestrator::new(&model, None, cwd.clone());

            let orch_handle = tokio::spawn(async move {
                orch.run(ipc_rx).await;
            });

            // Start Lead session
            let ext = Some(extension.as_str());
            // Auto session persistence: always use .tokyo/sessions/ so pi sessions survive restarts
            let sess_dir = session_dir.unwrap_or_else(|| {
                let dir = cwd.join(".tokyo").join("sessions");
                std::fs::create_dir_all(&dir).ok();
                dir.to_string_lossy().into_owned()
            });
            let sess_dir_ref = Some(sess_dir.as_str());
            let mut lead = rpc::RpcWorker::spawn(&model, ext, sess_dir_ref).await?;

            if use_tui {
                // TUI dashboard mode
                let mut dashboard = tui::Dashboard::new()?;
                let mut state = tui::DashboardState::new(&model);
                state.phase = "IDLE".to_string();

                if let Some(p) = prompt {
                    state.push_output(&format!("[you] {p}"));
                    dashboard.draw(&state)?;
                    let resp = lead.prompt_streaming(&p, Some(|delta: &str| {
                        // Can't update TUI from inside callback easily, accumulate
                    })).await?;
                    state.push_output(&resp);
                }

                loop {
                    dashboard.draw(&state)?;
                    if state.should_quit { break; }

                    if let Some(msg) = dashboard.poll_input(&mut state)? {
                        state.push_output(&format!("[you] {msg}"));
                        dashboard.draw(&state)?;
                        let resp = lead.prompt(&msg).await?;
                        state.push_output(&resp);
                    }
                }

                lead.shutdown().await?;
                dashboard.shutdown()?;
            } else {
                // Plain interactive mode
                let stream_cb = |delta: &str| {
                    use std::io::Write;
                    print!("{delta}");
                    std::io::stdout().flush().ok();
                };

                if let Some(p) = prompt {
                    println!("[tokyo] sending initial prompt...");
                    lead.prompt_streaming(&p, Some(stream_cb)).await?;
                    println!();
                }

                use tokio::io::AsyncBufReadExt;
                let stdin = tokio::io::BufReader::new(tokio::io::stdin());
                let mut lines = stdin.lines();
                println!("[tokyo] lead ready. Type a message (Ctrl+D to quit):");

                loop {
                    tokio::select! {
                        line = lines.next_line() => {
                            match line? {
                                Some(input) if !input.trim().is_empty() => {
                                    lead.prompt_streaming(input.trim(), Some(stream_cb)).await?;
                                    println!();
                                }
                                Some(_) => continue,
                                None => break,
                            }
                        }
                        _ = tokio::signal::ctrl_c() => {
                            println!("\n[tokyo] shutting down...");
                            break;
                        }
                    }
                }

                lead.shutdown().await?;
                println!("[tokyo] bye.");
            }

            // Clean up socket + PID lock (M9: guaranteed cleanup on all exit paths)
            let _ = std::fs::remove_file(&sock_path);
            let _ = std::fs::remove_file(sock_path.with_extension("pid"));
            orch_handle.abort();
        }
        Cli::TestPersist { model } => {
            println!("[tokyo] persistence test: spawning pi --mode rpc --model {model}");
            let mut worker = rpc::RpcWorker::spawn(&model, None, None).await?;

            println!("[tokyo] round 1: storing secret...");
            let r1 = worker.prompt("Remember this secret code: MANGO77. Acknowledge with just 'stored'.").await?;
            println!("[tokyo] round 1 response: {r1}");

            println!("[tokyo] round 2: recalling secret...");
            let r2 = worker.prompt("What was the secret code I told you? Reply with just the code.").await?;
            println!("[tokyo] round 2 response: {r2}");

            let passed = r2.contains("MANGO77");
            println!("[tokyo] persistence test: {}", if passed { "PASSED ✅" } else { "FAILED ❌" });

            worker.shutdown().await?;
        }
        Cli::TeamTest { model } => {
            use team::{Team, WorkerConfig};

            println!("[tokyo] team test: spawning lead + 2 workers (model: {model})");
            let workers = vec![
                WorkerConfig {
                    id: "skeptic".into(),
                    model: model.clone(),
                    system_prompt: "You are the Skeptic. Challenge assumptions, find flaws, be contrarian. Keep responses under 2 sentences.".into(),
                },
                WorkerConfig {
                    id: "creative".into(),
                    model: model.clone(),
                    system_prompt: "You are the Creative. Propose bold, unconventional solutions. Keep responses under 2 sentences.".into(),
                },
            ];

            let mut team = Team::spawn(&model, None, workers).await?;
            println!("[tokyo] team spawned. Broadcasting task...");

            let task = "How should we design a caching layer for a high-traffic API? Give your perspective in one sentence.";
            let responses = team.broadcast(task).await?;

            for (id, response) in &responses {
                println!("[tokyo] {id}: {response}");
            }

            // Verify persistence: ask skeptic what the topic was
            println!("[tokyo] persistence check: asking skeptic what we discussed...");
            let recall = team.send_to("skeptic", "What topic did I just ask you about? One phrase.").await?;
            println!("[tokyo] skeptic recall: {recall}");

            let passed = recall.to_lowercase().contains("cach");
            println!("[tokyo] team persistence: {}", if passed { "PASSED \u{2705}" } else { "FAILED \u{274c}" });

            team.shutdown().await?;
        }
        Cli::Hyperplan { model, task } => {
            println!("[tokyo] hyperplan: 5 adversarial members × 3 rounds");
            println!("[tokyo] model: {model}");
            println!("[tokyo] task: {task}");
            println!();

            let result = hyperplan::run_hyperplan(&model, &task, |member, status, round| {
                if round == 0 {
                    println!("  [{member}] {status}");
                } else {
                    println!("  [{member}] round {round}: {status}");
                }
            }).await?;

            println!("\n{}", "=".repeat(60));
            println!("HYPERPLAN COMPLETE — 3 rounds × 5 members");
            println!("{}\n", "=".repeat(60));

            for (i, round) in result.rounds.iter().enumerate() {
                println!("--- Round {} ---", i + 1);
                for output in round {
                    println!("[{}]\n{}\n", output.member_id, output.text);
                }
            }

            println!("\n{}", "=".repeat(60));
            println!("SURVIVING INSIGHTS (synthesis)");
            println!("{}\n", "=".repeat(60));
            println!("{}", result.synthesis);
        }
        Cli::Pause { project_dir } => {
            let cwd = match project_dir {
                Some(ref d) => std::path::PathBuf::from(d),
                None => std::env::current_dir()?,
            };
            let sock_path = ipc::default_socket_path(&cwd);

            if !sock_path.exists() {
                anyhow::bail!("No orchestrator running (no socket at {})", sock_path.display());
            }

            println!("[tokyo] pausing...");

            // Send the IPC pause command. The orchestrator handles snapshot save +
            // worker kills + daemon exit in one shot, so this is now a thin client.
            use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
            use tokio::net::UnixStream;
            let stream = UnixStream::connect(&sock_path).await?;
            let (reader, mut writer) = stream.into_split();
            let cmd = serde_json::json!({"type": "pause"});
            let mut line = serde_json::to_string(&cmd).unwrap();
            line.push('\n');
            writer.write_all(line.as_bytes()).await?;
            writer.flush().await?;
            drop(writer);

            let mut buf_reader = tokio::io::BufReader::new(reader);
            let mut resp_line = String::new();
            buf_reader.read_line(&mut resp_line).await?;

            let resp: serde_json::Value = serde_json::from_str(&resp_line)
                .map_err(|e| anyhow::anyhow!("invalid pause response: {e} (raw: {resp_line:?})"))?;

            match resp.get("type").and_then(|t| t.as_str()) {
                Some("paused") => {
                    let path = resp.get("snapshot_path").and_then(|p| p.as_str()).unwrap_or("<unknown>");
                    println!("[tokyo] snapshot saved at {path}");
                }
                Some("error") => {
                    let msg = resp.get("message").and_then(|m| m.as_str()).unwrap_or("(no message)");
                    anyhow::bail!("pause failed: {msg}");
                }
                other => anyhow::bail!("unexpected pause response: {other:?}"),
            }

            // The orchestrator tears down the listener and exits shortly after
            // sending the response. Poll briefly for the socket to vanish so the
            // user gets immediate feedback (otherwise they'd have to wait for the
            // OS to GC the socket file).
            for _ in 0..50 {
                if !sock_path.exists() { break; }
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
            println!("[tokyo] orchestrator stopped. Resume with 'tokyo resume'.");
        }
        Cli::Resume { project_dir, model } => {
            let cwd = match project_dir {
                Some(ref d) => std::path::PathBuf::from(d),
                None => std::env::current_dir()?,
            };

            if !snapshot::has_snapshot(&cwd) {
                anyhow::bail!("No snapshot found at {}/.tokyo/snapshot.json. Nothing to resume.", cwd.display());
            }

            let snap = snapshot::load_snapshot(&cwd)?;
            let model = model.unwrap_or(snap.model);
            println!("[tokyo] resuming from snapshot ({} workers, paused at {})", snap.workers.len(), snap.paused_at);

            // Must match bin/tokyo's session-name formula so attach finds the right one.
            let session = session_name(&cwd);
            let sock_path = ipc::default_socket_path(&cwd);
            let pid_path = sock_path.with_extension("pid");

            // 1. If a previous orchestrator is somehow still running, gracefully
            //    pause it first so we don't fight over the socket / pid lock.
            if sock_path.exists() {
                println!("[tokyo]   existing orchestrator found — pausing it first");
                send_ipc_pause(&sock_path).await.ok();
                for _ in 0..50 {
                    if !sock_path.exists() { break; }
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                }
            }

            // 2. Clean any stale zellij session. Workers from a prior session are
            //    gone (paused killed them) and the zellij session may have leftover
            //    windows. We rebuild from scratch.
            kill_session(&session);
            std::fs::create_dir_all(cwd.join(".tokyo").join("sessions")).ok();

            // 3. Create the zellij session with the lead running in a tab, detached.
            //    We use a temporary layout KDL file to define the initial tab.
            let ext_path = resolve_extension_path();
            let sess_dir = cwd.join(".tokyo").join("sessions");
            let lead_cmd = build_lead_cmd(&session, &sess_dir, &ext_path);
            let layout_kdl = std::env::temp_dir().join(format!("tokyo-resume-layout-{}.kdl", std::process::id()));
            std::fs::write(&layout_kdl, format!(
                "layout {{ tab name=\"lead\" focus=true {{ pane {{ command \"sh\" args \"-c\" \"{}\" }} }} }}",
                lead_cmd.replace('\\', "\\\\").replace('"', "\\\"")
            ))?;
            let status = std::process::Command::new("zellij")
                .env("ZELLIJ_AUTO_ATTACH", "0")
                .args([
                    "--session", &session,
                    "--layout", &layout_kdl.to_string_lossy(),
                    "--cwd", &cwd.to_string_lossy(),
                ])
                .spawn()?;
            // Wait for the session to come up (list-sessions shows it).
            for _ in 0..30 {
                let out = std::process::Command::new("zellij")
                    .args(["list-sessions"])
                    .output();
                if let Ok(o) = out {
                    if String::from_utf8_lossy(&o.stdout).lines().any(|l| l.trim() == session) {
                        break;
                    }
                }
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            }
            let _ = std::fs::remove_file(&layout_kdl);

            // Set OS terminal title via ANSI escape.
            let _ = std::process::Command::new("sh")
                .args(["-c", &format!("printf '\\033]0;tokyo: {} [lead]\\033\\\\' 2>/dev/null", session)])
                .status();

            // 4. Spawn the orchestrator as a DETACHED background process. It
            //    outlives `tokyo resume` so the user can keep using the session
            //    after detaching. The orchestrator is just `tokyo serve`; same
            //    path the launcher uses on a fresh start.
            let orch_path = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("tokyo"));
            std::process::Command::new(&orch_path)
                .args([
                    "serve",
                    "--model", &model,
                    "--project-dir", &cwd.to_string_lossy(),
                    "--session", &session,
                ])
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()?;

            // 5. Wait for the orchestrator's socket (PID lock is also a good signal).
            for _ in 0..100 {
                if sock_path.exists() && pid_path.exists() { break; }
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            }
            if !sock_path.exists() {
                anyhow::bail!("orchestrator failed to start (no socket at {})", sock_path.display());
            }
            println!("[tokyo]   orchestrator ready");

            // 6. Restore each saved worker via the new RestoreWorker IPC. This
            //    spawns a fresh zellij window per worker and re-primes it with the
            //    saved prime_message so role identity survives the pause.
            for w in &snap.workers {
                let prime = match &w.prime_message {
                    Some(p) => p.clone(),
                    None => {
                        println!("[tokyo]   skipping {} (no prime_message — older snapshot)", w.id);
                        continue;
                    }
                };
                let resp = send_ipc(&sock_path, serde_json::json!({
                    "type": "restore_worker",
                    "id": w.id,
                    "model": w.model,
                    "prime_message": prime,
                })).await?;
                if resp.get("type") == Some(&serde_json::Value::String("error".to_string())) {
                    let msg = resp.get("message").and_then(|m| m.as_str()).unwrap_or("(no message)");
                    eprintln!("[tokyo]   restore {} failed: {msg}", w.id);
                } else {
                    println!("[tokyo]   restored worker {}", w.id);
                }
            }

            // 7. Clear snapshot once everything is wired up. If restore fails,
            //    leaving the snapshot lets the user retry without re-pausing.
            snapshot::clear_snapshot(&cwd)?;
            println!("[tokyo] resumed. Attaching to {session}...");

            // 8. Attach. On detach/exit, leave the orchestrator + zellij session
            //    alive — the user explicitly pauses when they want to stop.
            //    (Different from bin/tokyo, which always kills the session.)
            let _ = std::process::Command::new("zellij")
                .args(["attach", &session])
                .status();
        }
    }
    Ok(())
}

// ─── resume helpers ──────────────────────────────────────────────────────────

use std::path::PathBuf;
use std::process::Command;

/// Compute the zellij session name for a project dir. MUST match bin/tokyo's
/// `SESSION="tokyo-..."` formula exactly, or attach will fail to find the
/// session we just created.
fn session_name(cwd: &std::path::Path) -> String {
    let base = cwd
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "project".to_string());
    let sanitized: String = base
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    let trimmed: String = sanitized.chars().take(20).collect();
    format!("tokyo-{trimmed}")
}

/// Best-effort: if a zellij session with this name exists, kill it. Used by resume
/// to clear any leftover windows (workers from a prior session are dead but the
/// windows may still be visible with `remain-on-exit on`).
fn kill_session(session: &str) {
    let _ = Command::new("zellij")
        .args(["kill-session", session])
        .status();
}

/// Resolve the extension path: CLI flag > TOKYO_EXTENSION env > default
/// ~/projects/tokyo-harness/extension/index.ts. Mirrors bin/tokyo's lookup.
fn resolve_extension_path() -> PathBuf {
    if let Ok(p) = std::env::var("TOKYO_EXTENSION") {
        return PathBuf::from(p);
    }
    let home = dirs::home_dir().unwrap_or_default();
    home.join("projects/tokyo-harness/extension/index.ts")
}

/// Build the lead's zellij command. Mirrors bin/tokyo's LEAD_ENV/LEAD_CMD.
fn build_lead_cmd(session: &str, sess_dir: &std::path::Path, ext_path: &std::path::Path) -> String {
    let pi = crate::rpc::pi_bin();
    let sess = sess_dir.to_string_lossy();
    let ext = ext_path.to_string_lossy();
    format!(
        "TOKYO_AUTO=1 TOKYO_ZELLIJ_SESSION={} {} --session-dir {} -e {}",
        shell_quote(session),
        shell_quote(&pi),
        shell_quote(&sess),
        shell_quote(&ext),
    )
}

/// Minimal POSIX shell single-quote escaping.
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Connect to the orchestrator socket and send one command, returning the parsed
/// JSON response. Used by `tokyo resume` to invoke Pause/RestoreWorker against
/// the running orchestrator.
async fn send_ipc(sock_path: &std::path::Path, command: serde_json::Value) -> anyhow::Result<serde_json::Value> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
    use tokio::net::UnixStream;
    let stream = UnixStream::connect(sock_path).await?;
    let (reader, mut writer) = stream.into_split();
    let mut line = serde_json::to_string(&command)?;
    line.push('\n');
    writer.write_all(line.as_bytes()).await?;
    writer.flush().await?;
    drop(writer);
    let mut buf_reader = tokio::io::BufReader::new(reader);
    let mut resp_line = String::new();
    buf_reader.read_line(&mut resp_line).await?;
    let resp: serde_json::Value = serde_json::from_str(resp_line.trim())
        .map_err(|e| anyhow::anyhow!("invalid IPC response: {e} (raw: {resp_line:?})"))?;
    Ok(resp)
}

/// Convenience: send a pause command, ignore errors (used when we just want the
/// orchestrator to shut down before we take over).
async fn send_ipc_pause(sock_path: &std::path::Path) -> anyhow::Result<()> {
    let resp = send_ipc(sock_path, serde_json::json!({"type": "pause"})).await?;
    if resp.get("type") == Some(&serde_json::Value::String("error".to_string())) {
        let msg = resp.get("message").and_then(|m| m.as_str()).unwrap_or("(no message)");
        anyhow::bail!("pause IPC failed: {msg}");
    }
    Ok(())
}
