# AGENTS.md — Tokyo Harness

## What this is

Tokyo is a workflow harness for `pi` (the coding agent). It enforces a structured
interview → research → plan → execute → verify → review pipeline with strict phase
gates, evidence-gated completion, and optional adversarial planning (hyperplan).

## Architecture

```
tokyo (Rust binary)              ← orchestrator, owns all processes
  ├─ Lead: pi --mode rpc -e extension/index.ts
  ├─ Workers (on-demand): pi --mode rpc (spawned via IPC when needed)
  └─ IPC socket: .tokyo/orchestrator.sock

extension/ (TypeScript)          ← workflow brain (pi extension)
  ├─ Phase machine: IDLE→INTERVIEW→RESEARCH→PLAN→EXECUTE→VERIFY→REVIEW→DONE
  ├─ Tools: tokyo_phase, spawn_subagents, tokyo_ambiguity, tokyo_spec_save,
  │         tokyo_plan_save, tokyo_goal, tokyo_complete, tokyo_verify,
  │         tokyo_team, tokyo_memory
  └─ Gates: per-phase tool restrictions, bash mutation blocking, evidence enforcement
```

## Key rules for AI agents working on this codebase

1. **extension/index.ts is the SOLE pi API boundary.** All pi hooks (session_start,
   before_agent_start, tool_call, agent_end, session_shutdown) are registered there.
   Don't create new pi.on() handlers elsewhere.

2. **State lives in .tokyo/ only.** The StateWriter manages all disk I/O with atomic
   writes and audit trails. Never write directly to .tokyo/ via fs — use state methods.

3. **Phase gates are structural, not advisory.** The tool_call hook blocks mutations
   in read-only phases. Don't bypass this with workarounds.

4. **Tests must pass before committing.** Run `bun test` (148 tests) + `bunx tsc --noEmit`.
   For the orchestrator: `cd orchestrator && cargo build`.

5. **Orchestrator is Rust, extension is TypeScript.** They communicate via Unix socket
   (JSONL). Don't mix — keep the boundary clean.

6. **No pi fork.** This is a pure extension + external binary. Don't import pi internals
   beyond the published ExtensionAPI/AgentToolResult types.

## File layout

```
extension/           TS pi extension (the workflow engine)
  index.ts           Main entry, all pi hooks
  config.ts          Constants, entry types
  state/             StateWriter (atomic JSON/JSONL, audit)
  team/              Tools, agents, interview, coordination, memory
  workflow/          Phase machine, gates, ambiguity, continuation, goals

orchestrator/        Rust binary (team orchestration)
  src/main.rs        CLI (tokyo start/ping/hyperplan/pause/resume)
  src/rpc.rs         RpcWorker (pi --mode rpc child management)
  src/ipc.rs         Unix socket server
  src/orchestrator.rs  Worker pool, IPC command handling
  src/hyperplan.rs   Adversarial 5×3 round logic
  src/worktree.rs    Git worktree per worker
  src/snapshot.rs    Pause/resume state
  src/tui.rs         Ratatui dashboard
  src/team.rs        Team struct (broadcast, send_to)

skills/              Skill markdown files (loaded by pi)
agents/              Agent system prompts (reviewer, architect, etc.)
```

## Running

```bash
# Install (one-time)
cd orchestrator && cargo build --release
ln -sf $(pwd)/target/release/tokyo ~/.nvm/versions/node/v24.14.0/bin/tokyo

# Use
cd your-project
tokyo                    # starts Lead + IPC socket, ready to work
tokyo --tui              # with ratatui dashboard
tokyo hyperplan "task"   # standalone adversarial planning
tokyo pause              # snapshot + shutdown
tokyo resume             # restore from snapshot
```

## Testing

```bash
pnpm test                 # 148 TS unit tests
pnpm typecheck             # type check
cd orchestrator && cargo test   # Rust integration tests (mock-pi)
```
