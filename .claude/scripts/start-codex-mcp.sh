#!/bin/zsh

set -euo pipefail

exec node ./.claude/scripts/codex-mcp-shim.mjs
