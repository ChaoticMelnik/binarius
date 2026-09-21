#!/bin/zsh

set -euo pipefail

default_codex_home="${CODEX_HOME:-$HOME/.codex}"

ensure_writable_codex_home() {
  if [[ -w "$default_codex_home" && ( ! -e "$default_codex_home/state_5.sqlite" || -w "$default_codex_home/state_5.sqlite" ) ]]; then
    export CODEX_HOME="$default_codex_home"
    return
  fi

  local fallback_home="/private/tmp/codex-mcp-home"
  mkdir -p "$fallback_home"

  if [[ -f "$default_codex_home/auth.json" ]]; then
    cp "$default_codex_home/auth.json" "$fallback_home/auth.json"
  fi

  if [[ -f "$default_codex_home/config.toml" ]]; then
    cp "$default_codex_home/config.toml" "$fallback_home/config.toml"
  fi

  export CODEX_HOME="$fallback_home"
}

run_server() {
  local binary="$1"

  export TERM="${TERM:-xterm-256color}"
  exec "$binary" mcp-server \
    -c 'model_reasoning_effort="low"' \
    -c 'approval_policy="never"' \
    -c 'sandbox_mode="read-only"'
    # CodeGraph MCP passthrough (mcp_servers.codegraph.*) — добавь сюда, когда в проекте
    # появится codegraph init -i, по образцу Client-Manager-Musya:
    #   -c 'mcp_servers.codegraph.command="zsh"' \
    #   -c 'mcp_servers.codegraph.args=["-lc","./.claude/scripts/start-codegraph-mcp.sh"]'
}

ensure_writable_codex_home

if command -v codex >/dev/null 2>&1; then
  run_server "$(command -v codex)"
fi

echo "Codex binary not found. Install Codex or update .claude/scripts/start-codex-mcp-server.sh." >&2
exit 127
