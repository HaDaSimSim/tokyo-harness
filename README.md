# Tokyo

Workflow harness for [pi](https://github.com/earendil-works/pi). Structured pipeline that produces correct code without babysitting:

```
interview ⇄ research → plan → (consent) → execute ⇄ verify → review → done
```

## Install

```bash
# One command
./install.sh

# Or manually:
cd orchestrator && cargo build --release
ln -sf "$PWD/bin/tokyo" ~/.local/bin/tokyo
mkdir -p ~/.tokyo && cp config.example.json ~/.tokyo/config.json
```

Requires: node, bun, rust/cargo, tmux.

## Quick start

```bash
cd your-project
tokyo
```

Starts a tmux session with the Lead in window 0. `/tokyo-auto on` for unattended runs.

## Architecture

```
tokyo (bash launcher)
  ├─ orchestrator (Rust binary) — serve-only daemon, IPC via unix socket
  │   └─ workers: interactive pi in tmux windows (drive like subagents)
  └─ extension (TypeScript) — phase machine, gates, tools, loaded by pi
```

## Key concepts

- **Phase machine**: IDLE→INTERVIEW→RESEARCH→PLAN→EXECUTE→VERIFY→REVIEW→DONE
- **Hyperplan**: adversarial planning (5 hostile members × 3 cross-critique rounds)
- **Goals ledger**: durable goal state (.tokyo/ledger/goals.json)
- **Notebook**: cross-session evidence/decisions (.tokyo/state/notebook/)
- **Config**: global ~/.tokyo/config.json + project .tokyo/config.json for category→model mapping

## Testing

```bash
bun test              # 148 TS unit tests
bunx tsc --noEmit     # type check
cd orchestrator && cargo test  # Rust integration tests
```
