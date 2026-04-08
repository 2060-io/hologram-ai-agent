#!/usr/bin/env bash
# =============================================================================
# Start the Hologram AI Agent chatbot locally
# =============================================================================
#
# Prerequisites:
#   - VS Agent running (setup.sh completed, or docker compose up)
#   - Redis running (docker compose up)
#   - config.env sourced
#
# Usage:
#   source config.env
#   source ids.env    # if setup.sh was run
#   ./scripts/start.sh
#
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Defaults (can be overridden by env)
VS_AGENT_ADMIN_URL="${VS_AGENT_ADMIN_URL:-http://localhost:${VS_AGENT_ADMIN_PORT:-3002}}"
CHATBOT_PORT="${CHATBOT_PORT:-3010}"

echo "============================================="
echo " Hologram AI Agent — Local Start"
echo "============================================="
echo "  VS-Agent URL : $VS_AGENT_ADMIN_URL"
echo "  Chatbot port : $CHATBOT_PORT"
echo "  LLM Provider : ${LLM_PROVIDER:-openai}"
echo "  Agent Pack   : ${AGENT_PACK_PATH:-./agent-packs/github-agent}"
echo "  RAG Provider : ${RAG_PROVIDER:-vectorstore}"
echo "  Redis URL    : ${REDIS_URL:-redis://localhost:6379}"
echo ""

# Install dependencies if needed
if [ ! -d "$PROJECT_DIR/node_modules" ]; then
  echo "Installing dependencies..."
  (cd "$PROJECT_DIR" && pnpm install)
fi

# Export env vars the chatbot needs
export VS_AGENT_ADMIN_URL
export APP_PORT="${CHATBOT_PORT}"
export CHATBOT_PORT
export LLM_PROVIDER="${LLM_PROVIDER:-openai}"
export OPENAI_API_KEY="${OPENAI_API_KEY:-}"
export OPENAI_MODEL="${OPENAI_MODEL:-gpt-4o-mini}"
export AGENT_PACK_PATH="${AGENT_PACK_PATH:-./agent-packs/github-agent}"
export RAG_PROVIDER="${RAG_PROVIDER:-vectorstore}"
export RAG_DOCS_PATH="${RAG_DOCS_PATH:-./docs}"
export RAG_REMOTE_URLS="${RAG_REMOTE_URLS:-[]}"
export VECTOR_STORE="${VECTOR_STORE:-redis}"
export VECTOR_INDEX_NAME="${VECTOR_INDEX_NAME:-hologram-ia}"
export REDIS_URL="${REDIS_URL:-redis://localhost:6379}"
# MCP_SERVERS_CONFIG — leave unset so agent-pack mcp.servers is used
# export MCP_SERVERS_CONFIG="${MCP_SERVERS_CONFIG:-[]}"
export AGENT_MEMORY_BACKEND="${AGENT_MEMORY_BACKEND:-memory}"
export AGENT_MEMORY_WINDOW="${AGENT_MEMORY_WINDOW:-8}"
export CREDENTIAL_DEFINITION_ID="${CREDENTIAL_DEFINITION_ID:-}"
export POSTGRES_HOST="${POSTGRES_HOST:-localhost}"
export POSTGRES_USER="${POSTGRES_USER:-hologram}"
export POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-hologram}"
export POSTGRES_DB_NAME="${POSTGRES_DB_NAME:-hologram-agent}"
export LOG_LEVEL="${LOG_LEVEL:-info}"

# Start the chatbot in dev mode (hot-reload)
echo "Starting Hologram AI Agent..."
cd "$PROJECT_DIR"
exec pnpm start:dev
