#!/usr/bin/env bash
#
# tokyo-install — one-command setup for the tokyo workflow harness.
#
#   curl -sSL https://raw.githubusercontent.com/<user>/tokyo-harness/main/install.sh | bash
#   # or locally:
#   ./install.sh
#
# What it does:
#   1. Symlinks bin/tokyo → ~/.local/bin/tokyo (launcher, on PATH)
#   2. Writes default ~/.tokyo/config.json (category→model mappings)
#   3. Builds the Rust orchestrator (cargo build --release)
#   4. Checks tmux is installed (required for team/worker features)
#
# Prerequisites: node, bun, rust/cargo, tmux
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
BIN_LAUNCHER="$REPO_DIR/bin/tokyo"
LOCAL_BIN="$HOME/.local/bin"
TOKYO_CONFIG="$HOME/.tokyo"
ORCH_DIR="$REPO_DIR/orchestrator"

echo "=== tokyo installer ==="
echo "Repo: $REPO_DIR"

# ── 1. tmux check ─────────────────────────────────────────────────────────────
if ! command -v tmux >/dev/null 2>&1; then
	echo "❌ tmux is required but not installed."
	echo "   Install it: brew install tmux  (macOS)"
	echo "               sudo apt install tmux  (Linux)"
	exit 1
fi
echo "✅ tmux: $(tmux -V)"

# ── 2. Rust orchestrator build ────────────────────────────────────────────────
if [ -f "$ORCH_DIR/target/release/tokyo" ]; then
	echo "✅ orchestrator binary already built"
else
	echo "🔨 building orchestrator (cargo build --release)..."
	(cd "$ORCH_DIR" && cargo build --release)
	echo "✅ orchestrator built"
fi

# ── 3. Symlink the launcher ───────────────────────────────────────────────────
mkdir -p "$LOCAL_BIN"
if [ -L "$LOCAL_BIN/tokyo" ] || [ -f "$LOCAL_BIN/tokyo" ]; then
	echo "📎 $LOCAL_BIN/tokyo already exists, skipping symlink"
else
	ln -s "$BIN_LAUNCHER" "$LOCAL_BIN/tokyo"
	echo "🔗 $LOCAL_BIN/tokyo → $BIN_LAUNCHER"
fi

# ── 4. Default config ─────────────────────────────────────────────────────────
mkdir -p "$TOKYO_CONFIG"
if [ -f "$TOKYO_CONFIG/config.json" ]; then
	echo "📎 $TOKYO_CONFIG/config.json already exists, skipping"
else
	cat > "$TOKYO_CONFIG/config.json" << 'CONF'
{
  "categories": {
    "standard": { "model": "relay/claude-sonnet-4.5" },
    "deep":     { "model": "relay/claude-opus-4.8", "thinking": "xhigh" },
    "creative": { "model": "relay/claude-opus-4.8" },
    "fast":     { "model": "relay/claude-haiku-4.5" }
  },
  "agents": {
    "executor":  { "category": "standard" },
    "reviewer":  { "category": "deep", "excludeTools": ["edit", "write"] },
    "architect": { "category": "deep", "excludeTools": ["edit", "write"] },
    "critic":    { "category": "creative", "excludeTools": ["edit", "write"] },
    "planner":   { "category": "deep" },
    "explore":   { "category": "fast" },
    "skeptic":   { "category": "fast" },
    "validator": { "category": "deep" },
    "researcher":{ "category": "deep" }
  },
  "defaults": { "model": "relay/claude-opus-4.8" }
}
CONF
	echo "✅ $TOKYO_CONFIG/config.json created"
fi

# ── 5. PATH check ─────────────────────────────────────────────────────────────
if ! echo "$PATH" | tr ':' '\n' | grep -qxF "$LOCAL_BIN"; then
	echo ""
	echo "⚠️  $LOCAL_BIN is not on your PATH."
	echo "   Add this to your ~/.zshrc or ~/.bashrc:"
	echo "     export PATH=\"\$HOME/.local/bin:\$PATH\""
fi

echo ""
echo "=== tokyo installed ==="
echo "Try it:  cd <your-project> && tokyo"
