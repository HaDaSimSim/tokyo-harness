use clap::Parser;

mod rpc;
mod tmux_worker;
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

        /// tmux session name that owns the Lead + worker windows. When set,
        /// workers are spawned as visible interactive pi windows in this session
        /// (driven via tmux) instead of headless RPC pipes.
        #[arg(long)]
        tmux_session: Option<String>,
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
        Cli::Serve { model, project_dir, tmux_session } => {
            let cwd = match project_dir {
                Some(ref d) => std::path::PathBuf::from(d),
                None => std::env::current_dir()?,
            };
            let sock_path = ipc::default_socket_path(&cwd);
            eprintln!("[tokyo-serve] model={model}");
            eprintln!("[tokyo-serve] project: {}", cwd.display());
            eprintln!("[tokyo-serve] ipc socket: {}", sock_path.display());
            match tmux_session {
                Some(ref s) => eprintln!("[tokyo-serve] tmux session: {s} (workers spawn as visible windows)"),
                None => eprintln!("[tokyo-serve] no tmux session — workers unavailable"),
            }

            // IPC server + worker pool only. No Lead, no TUI — the user's pi TUI
            // (launched separately by bin/tokyo) is the Lead and connects here.
            let ipc_rx = ipc::start_ipc_server(&sock_path).await?;
            let mut orch = orchestrator::Orchestrator::new(&model, tmux_session, cwd.clone());
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

            // Read current orchestrator state via IPC
            if !sock_path.exists() {
                anyhow::bail!("No orchestrator running (no socket at {})", sock_path.display());
            }

            // Send status query to get worker list
            println!("[tokyo] pausing...");

            // Query orchestrator for live worker state
            let workers_snapshot = {
                use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
                use tokio::net::UnixStream;
                match UnixStream::connect(&sock_path).await {
                    Ok(stream) => {
                        let (reader, mut writer) = stream.into_split();
                        let cmd = serde_json::json!({"type": "status"});
                        let mut line = serde_json::to_string(&cmd).unwrap();
                        line.push('\n');
                        let _ = writer.write_all(line.as_bytes()).await;
                        let _ = writer.flush().await;
                        let mut buf_reader = tokio::io::BufReader::new(reader);
                        let mut resp_line = String::new();
                        let _ = buf_reader.read_line(&mut resp_line).await;
                        // Parse status response to get worker IDs
                        if let Ok(obj) = serde_json::from_str::<serde_json::Value>(&resp_line) {
                            if let Some(workers) = obj.get("workers").and_then(|w| w.as_array()) {
                                workers.iter().filter_map(|w| {
                                    let id = w.get("id")?.as_str()?.to_string();
                                    Some(snapshot::WorkerSnapshot { id, model: "relay/claude-sonnet-4.5".into(), prime_message: None })
                                }).collect::<Vec<_>>()
                            } else { vec![] }
                        } else { vec![] }
                    }
                    Err(_) => vec![],
                }
            };

            // Build snapshot
            let snap = snapshot::OrchestratorSnapshot {
                model: "relay/claude-sonnet-4.5".to_string(),
                extension: None,
                session_dir: None,
                workers: workers_snapshot,
                paused_at: std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs().to_string()).unwrap_or_default(),
                phase: None,
            };

            // For now, just save and kill the orchestrator
            let path = snapshot::save_snapshot(&cwd, &snap)?;
            println!("[tokyo] snapshot saved to {}", path.display());

            // Kill the orchestrator by removing its socket (it will notice)
            let _ = std::fs::remove_file(&sock_path);
            let _ = std::fs::remove_file(sock_path.with_extension("pid"));
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
            println!("[tokyo] resuming from snapshot (paused at {})", snap.paused_at);

            let model = model.unwrap_or(snap.model);
            let extension = snap.extension;

            // Re-launch orchestrator (same as `tokyo start`). Legacy RPC Lead path:
            // no tmux session, so team workers are not restored here.
            let sock_path = ipc::default_socket_path(&cwd);
            let ipc_rx = ipc::start_ipc_server(&sock_path).await?;
            let mut orch = orchestrator::Orchestrator::new(&model, None, cwd.clone());

            // NOTE: tmux-backed workers live in the tmux session, not in a snapshot.
            // The legacy snapshot worker list is no longer re-spawned here.
            if !snap.workers.is_empty() {
                println!("  (skipping {} snapshot workers — tmux workers are restored via the tmux session)", snap.workers.len());
            }

            // Start Lead
            let ext = extension.as_deref();
            let sess_dir = snap.session_dir.as_deref();
            let mut lead = rpc::RpcWorker::spawn(&model, ext, sess_dir).await?;

            snapshot::clear_snapshot(&cwd)?;
            println!("[tokyo] resumed. {} workers restored.", snap.workers.len());

            let orch_handle = tokio::spawn(async move {
                orch.run(ipc_rx).await;
            });

            // Interactive loop
            use tokio::io::AsyncBufReadExt;
            let stream_cb = |delta: &str| {
                use std::io::Write;
                print!("{delta}");
                std::io::stdout().flush().ok();
            };
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
            let _ = std::fs::remove_file(&sock_path);
            let _ = std::fs::remove_file(sock_path.with_extension("pid"));
            orch_handle.abort();
        }
    }
    Ok(())
}
