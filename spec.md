# Hologram Generic AI Agent MCP VS — Specification

## Overview

A generic, configurable AI agent that runs as a **Verifiable Service** on the Hologram messaging platform. It supports authentication via AnonCred credentials, Retrieval Augmented Generation (RAG), dynamic tool integration via LangChain, and the **Model Context Protocol (MCP)** for extensible tool discovery.

The agent is designed to be **container-generic**: a single Docker image that can be configured for any use case via environment variables and an agent-pack YAML manifest.

---

## Architecture

```
┌──────────────────────────────────────────────────────┐
│  Hologram User (Mobile Wallet)                       │
│  - DIDComm messaging                                 │
│  - AnonCred credential presentation                  │
│  - Media file sharing                                │
└───────────────┬──────────────────────────────────────┘
                │ DIDComm / Hologram Protocol
                ▼
┌──────────────────────────────────────────────────────┐
│  VS Agent (Verifiable Service Agent)                 │
│  - did:webvh identity                                │
│  - ECS credentials (Organization + Service)          │
│  - AnonCreds credential definitions                  │
│  - Events → forwards to chatbot                      │
└───────────────┬──────────────────────────────────────┘
                │ HTTP Events API
                ▼
┌──────────────────────────────────────────────────────┐
│  Hologram Generic AI Agent (this service)            │
│                                                      │
│  ┌─────────┐  ┌──────────┐  ┌──────────┐            │
│  │ CoreSvc │  │  LlmSvc  │  │  RagSvc  │            │
│  │ (msg    │  │ (OpenAI, │  │ (vector  │            │
│  │  router │→│  Claude,  │  │  store,  │            │
│  │  auth,  │  │  Ollama)  │  │  docs)   │            │
│  │  menus) │  │          │  │          │            │
│  └─────────┘  └────┬─────┘  └──────────┘            │
│                     │                                │
│               ┌─────▼─────┐                          │
│               │  Tools    │                          │
│               │ - LangChain DynamicStructuredTools   │
│               │ - MCP client → external servers      │
│               │ - Auth checker                       │
│               │ - RAG retriever                      │
│               │ - Statistics fetcher                 │
│               └───────────┘                          │
│                                                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐           │
│  │ McpSvc   │  │ MemorySvc│  │ EventsSvc│           │
│  │ (MCP     │  │ (session │  │ (JMS,    │           │
│  │  clients)│  │  memory) │  │  stats)  │           │
│  └──────────┘  └──────────┘  └──────────┘           │
└──────────────────────────────────────────────────────┘
```

---

## Current State

### What works

- **Multi-LLM support**: OpenAI, Anthropic (Claude), Ollama via LangChain
- **RAG**: Redis or Pinecone vector stores, local + remote document ingestion (.txt, .md, .pdf, .csv)
- **Agent packs**: Declarative YAML configuration for prompts, flows, tools, integrations, i18n
- **Authentication**: AnonCred credential presentation via Hologram protocol
- **Dynamic tools**: HTTP-based tools via `LLM_TOOLS_CONFIG` JSON
- **Session memory**: In-memory or Redis-backed chat history
- **MCP integration** ✅: Client SDK wired in, discovers tools from configured MCP servers at startup
- **Contextual menus**: Auth/logout buttons with visibility rules
- **Multi-language**: EN, ES, FR, PT with auto-detection
- **Stats**: JMS-based statistics via Artemis broker

### What needs work

See roadmap below.

---

## Roadmap

### Phase 1: MCP Integration ✅ (Done)

- [x] Add `@modelcontextprotocol/sdk` dependency
- [x] Extend agent-pack Zod schema with `mcp.servers` config
- [x] Add `MCP_SERVERS_CONFIG` env var support (JSON array, takes precedence over YAML)
- [x] Create `McpService` — manages client connections (stdio/SSE/streamable-http), tool discovery, tool invocation
- [x] Wire MCP tools into `LlmService` as LangChain `DynamicStructuredTool` instances
- [x] JSON Schema → Zod conversion for MCP tool input schemas
- [x] Async tool discovery via `OnModuleInit` (MCP connections established before tool agent is built)
- [x] Build passes (`pnpm build`)

### Phase 2: Verana-Demos Alignment

Align the project structure with the verana-demos pattern for consistent deployment and local development.

#### 2.1 Configuration — `config.env`

Create a single, shell-sourceable `config.env` that is read by scripts AND GHA workflows:

```bash
# VS Agent
VS_AGENT_IMAGE="veranalabs/vs-agent:latest"
VS_AGENT_CONTAINER_NAME="hologram-ai-agent-vs"
VS_AGENT_ADMIN_PORT="3002"
VS_AGENT_PUBLIC_PORT="3003"

# Organization VS (parent service)
ORG_VS_PUBLIC_URL="${ORG_VS_PUBLIC_URL:-}"
ORG_VS_ADMIN_URL="${ORG_VS_ADMIN_URL:-http://localhost:3000}"

# Service identity
SERVICE_NAME="Hologram AI Agent"
SERVICE_TYPE="AgentService"
SERVICE_DESCRIPTION="Generic AI agent verifiable service"

# Chatbot
CHATBOT_PORT="3010"
LLM_PROVIDER="openai"
OPENAI_MODEL="gpt-5.4-mini"
AGENT_PACK_PATH="./agent-packs/hologram-welcome"

# RAG
RAG_PROVIDER="langchain"
RAG_DOCS_PATH="./docs"
RAG_REMOTE_URLS='[]'
VECTOR_STORE="redis"

# MCP
MCP_SERVERS_CONFIG='[]'

# Auth
CREDENTIAL_DEFINITION_ID=""
```

#### 2.2 Scripts

- **`scripts/setup.sh`** — Sets up local infrastructure:
  1. Pull + start VS Agent container via Docker + ngrok
  2. Set up veranad CLI account
  3. Obtain Service credential from organization-vs
  4. (Optional) Create AnonCreds credential definition
  5. Save discovered IDs to `ids.env`

- **`scripts/start.sh`** — Starts the chatbot in dev mode:
  1. Source `config.env` + `ids.env`
  2. Run `pnpm install` if needed
  3. Start with `pnpm start:dev` (hot-reload)

#### 2.3 Docker Compose

Replace the monolithic `docker-compose.yml` (7 services) with a minimal `docker/docker-compose.yml` that only runs **dependent infrastructure services**. The chatbot itself runs natively via `scripts/start.sh` (for hot-reload during dev):

```yaml
services:
  vs-agent:
    image: ${VS_AGENT_IMAGE:-veranalabs/vs-agent:latest}
    # ...
  redis:
    image: redis/redis-stack-server:latest
    # ...
```

Drop: chatbot (runs via `start.sh`), postgres (use SQLite for sessions), adminer, artemis, service-stats (optional, enable via env).

### Phase 3: Avatar-Based Authentication & In-Chat Administration

Users authenticate by presenting an **Avatar credential** through Hologram. The service owner configures one or more avatar names as admins. Admins can manage the bot entirely through the chat — no redeployment needed.

#### 3.1 Avatar Authentication

Users present their Avatar credential (AnonCred) to authenticate. The bot extracts the avatar name from the credential claims and checks it against the admin list.

- **Authentication flow**: same as today (credential presentation via `IdentityProofRequestMessage`)
- **Avatar name extraction**: from the presented credential's `name` claim
- **Role resolution**: if the avatar name is in `adminAvatars`, the session gets admin privileges

Note: credential definition is provided by 
did:webvh:QmXtzkv1yXqnaTLbJ8ieydgMtTS8qugDisVvhT86xRodrQ:issuer-chatbot-vs.avatar.hologram.zone

#### 3.2 Admin Capabilities

Admins interact with the bot through natural language commands or a dedicated admin menu. All changes take effect immediately (no restart required).

| Capability | Description |
| --- | --- |
| **Configure prompt** | Send a new system prompt; the bot updates it live for all future conversations |
| **Manage RAG files** | List ingested documents, add new ones (send file via media message), remove by name |
| **Manage MCP servers** | Add/remove MCP server connections at runtime (URL + transport type) |
| **Manage tools** | Enable/disable external HTTP tools, add new tool definitions via JSON |
| **View status** | Current config summary: LLM provider/model, RAG doc count, connected MCP servers, available tools, active sessions |
| **View stats** | Connected users, recent activity, message counts |
| **Manage authentication** | Enable/disable auth requirement, change credential definition ID |
| **Manage welcome message** | Update greeting text (per language) |
| **Manage menu items** | Add/remove contextual menu entries |
| **Set default language** | Change the bot's default language |
| **Reload config** | Trigger a full config reload from agent-pack without restarting |

#### 3.3 Regular Authenticated User Capabilities

| Capability | Description |
| --- | --- |
| **Upload personal context** | Send files that enrich their own session (session-scoped RAG) |
| **Access gated tools** | Use tools marked `requiresAuth: true` |
| **Personalized responses** | Bot addresses them by name (from credential claims) |
| **Export chat history** | Request a transcript of their conversation |

#### 3.4 RAG Ingestion via Media Messages

Building blocks already exist in the codebase:

- `MediaMessage` is received but currently ignored (no-op in `CoreService`)
- `RagService.addDocument(id, text)` exists and works at runtime
- Document parsing utilities handle `.txt`, `.md`, `.pdf`, `.csv`

Implementation:

1. **Handle `MediaMessage`** in `CoreService` — extract file URL from `MediaMessage.items[].uri`, download from VS Agent
2. **Add `RagService.ingestFile(buffer, filename)`** — wraps existing `loadLocalDocument()` + text splitter + `addDocument()`
3. **Scope**:
   - Admin uploads → `shared` scope (available to all users)
   - Regular user uploads → `session` scope (only available in their session)
4. **Confirmation**: "Document '{filename}' ingested ({N} chunks). I can now answer questions about it."

#### 3.5 Configuration

```yaml
flows:
  administration:
    enabled: true
    # Avatar names that have admin rights
    adminAvatars:
      - "@fafa"
      - "@mj"
    # Granular permissions (all true by default)
    permissions:
      managePrompt: true
      manageRag: true
      manageMcp: true
      manageTools: true
      viewStatus: true
      manageAuth: true
      manageWelcome: true
      manageMenu: true
  ragUpload:
    enabled: true
    requiresAuth: true
    # "shared" = admin only, available to all users
    # "session" = any auth user, scoped to their session
    scope: shared
```

Or via environment variable:

```bash
ADMIN_AVATARS="alice.hologram.zone,bob.hologram.zone"
```

#### 3.6 Admin Command Protocol

Admin commands can be triggered via:

1. **Contextual menu** — admin-only menu items (visible when authenticated as admin):
   - "Manage RAG", "View Status", "Configure Prompt"
2. **Natural language** — the LLM detects admin intent and routes to the appropriate handler tool:
   - "List all RAG documents"
   - "Set the system prompt to: You are a travel assistant..."
   - "Remove the file faq.pdf from RAG"
   - "Add an MCP server at https://mcp.example.com/sse"
3. **Combination** — menu triggers a guided flow, natural language for ad-hoc commands

The admin tools are registered as LangChain tools (like existing tools) but gated behind admin role check.

#### 3.7 Tool & MCP Access Control

Access to tools and MCP servers is enforced at the **agent code level**, not by the LLM. Tools the user doesn't have access to are simply not registered in the LangChain agent — the LLM never sees them and cannot call them. This is a hard security boundary, not a prompt-based suggestion.

**Per MCP server**:

```yaml
mcp:
  servers:
    - name: public-tools
      transport: streamable-http
      url: https://mcp.example.com/public
      access: all                          # anyone (default)

    - name: admin-tools
      transport: streamable-http
      url: https://mcp.example.com/admin
      access: admin                        # only admin avatars

    - name: premium-tools
      transport: streamable-http
      url: https://mcp.example.com/premium
      access:
        avatars:                           # explicit allowlist
          - "alice.hologram.zone"
          - "charlie.hologram.zone"
```

**Per tool** (overrides server-level default):

```yaml
mcp:
  servers:
    - name: company-tools
      transport: streamable-http
      url: https://mcp.example.com/api
      access: authenticated
      toolAccess:
        delete_record: admin
        export_data:
          avatars: ["alice.hologram.zone"]
```

**For HTTP tools** (`LLM_TOOLS_CONFIG`):

```json
{
  "name": "getFinancials",
  "endpoint": "https://api.example.com/financials",
  "access": { "avatars": ["alice.hologram.zone"] }
}
```

Access levels:

| Level | Meaning |
| --- | --- |
| `all` | Any user, including unauthenticated (default) |
| `authenticated` | Any user who presented an Avatar credential |
| `admin` | Only avatars listed in `adminAvatars` |
| `{ avatars: [...] }` | Explicit allowlist of avatar names |

**Defense in depth**: even with tool filtering (Layer 1), each tool handler also verifies the session role before executing (Layer 2) as a safety net against caching bugs or race conditions.

#### 3.8 Human-in-the-Loop Approval via Hologram

For sensitive actions, the agent can require **admin approval before executing** — with the approval request delivered over Hologram's encrypted DIDComm channel.

**Flow**:

```
1. User requests action → "Delete all records from Q1"
2. Agent detects the tool/action requires approval
3. Agent parks the request, notifies the user:
   "This action requires admin approval. I've sent a request."
4. Admin receives a Hologram message:
   "User alice.hologram.zone wants to: delete all records from Q1"
   [Approve] [Deny]
5. Admin taps Approve or Deny
6. Agent executes (or declines) and notifies the user of the outcome
```

**What makes this unique**: approval travels over Hologram's DIDComm channel — end-to-end encrypted, admin identity verified by credential, works cross-device (push notification), and every approval/denial is a verifiable interaction.

**Approval policy configuration**:

```yaml
flows:
  approval:
    enabled: true
    approvers:
      - "alice.hologram.zone"
    # "any" = one approver suffices, "all" = every approver must agree
    policy: any
    timeoutMinutes: 30
    rules:
      # Tool invocation rules
      - scope: tool
        match: "delete_*"          # tool name glob pattern
        for: all                   # all users need approval
      - scope: tool
        match: "export_data"
        for: guest                 # only unauthenticated users
      # MCP server rules
      - scope: mcp
        server: "admin-tools"
        for: authenticated         # auth'd but non-admin users
      # RAG management rules
      - scope: rag
        action: remove
        for: non-admin
```

**Implementation pieces**:

1. **Approval queue** — pending requests stored in session/Redis with TTL expiry
2. **Admin notification** — `CoreService` sends a `TextMessage` + `ContextualMenuUpdateMessage` to all online admin sessions with Approve/Deny menu items
3. **Callback routing** — when admin replies, `CoreService` matches it to the pending request by ID, executes or denies
4. **Timeout handling** — auto-deny after `timeoutMinutes`, notify user
5. **Tool wrapper** — `HitlApprovalTool` wraps the target tool: intercepts the call, creates an approval request, suspends execution (parks session state), resumes on approval or returns denial

**Edge cases**:

- **No admin online** — queue the request, deliver when admin connects, auto-deny on timeout
- **Multiple pending requests** — admin sees a numbered list, can approve/deny each independently
- **Admin is the requester** — bypass approval (self-approve)
- **Tool chain** — if a multi-step agent plan hits an approval-gated tool, the entire chain pauses at that step and resumes after approval

### Phase 4: MCP Server Instructions in System Prompt

Inject MCP server instructions into the LLM system prompt for richer context.

- `McpService.getServerInstructions()` is already implemented
- Wire into `ChatbotService.buildPrompt()` or `LlmService.setupToolAgent()`
- Append server instructions to the system prompt when MCP servers are connected

### Phase 5: Modernization (Incremental)

- **LangGraph migration**: Replace `createToolCallingAgent` with LangGraph for more complex agent workflows (branching, multi-step, human-in-the-loop)
- **Streaming responses**: Support token-by-token streaming to the Hologram client for faster perceived response times
- **SQLite sessions**: Replace PostgreSQL + TypeORM with SQLite for simpler local dev (no Docker dependency for DB)
- **Structured outputs**: Use LLM structured output mode for tool calls instead of free-text parsing
- **Multi-agent orchestration**: Allow the bot to delegate to specialized sub-agents for different domains

---

## Configuration Reference

### Environment Variables

| Variable | Description | Default |
|---|---|---|
| `APP_PORT` | Chatbot HTTP port | `3000` |
| `LLM_PROVIDER` | LLM backend: `openai`, `anthropic`, `ollama` | `openai` |
| `OPENAI_API_KEY` | OpenAI API key | — |
| `OPENAI_MODEL` | OpenAI model | `gpt-3.5-turbo` |
| `ANTHROPIC_API_KEY` | Anthropic API key | — |
| `OLLAMA_ENDPOINT` | Ollama server URL | `http://localhost:11434` |
| `AGENT_PACK_PATH` | Path to agent-pack YAML | `./agent-packs/hologram-welcome` |
| `AGENT_PROMPT` | System prompt (overrides agent-pack) | — |
| `RAG_PROVIDER` | RAG backend: `vectorstore`, `langchain` | `vectorstore` |
| `RAG_DOCS_PATH` | Local docs folder | `./docs` |
| `RAG_REMOTE_URLS` | Remote doc URLs (JSON array or CSV) | `[]` |
| `VECTOR_STORE` | Vector store: `redis`, `pinecone` | `redis` |
| `REDIS_URL` | Redis connection URL | `redis://localhost:6379` |
| `LLM_TOOLS_CONFIG` | External tools (JSON array) | `[]` |
| `MCP_SERVERS_CONFIG` | MCP servers (JSON array) | `[]` |
| `CREDENTIAL_DEFINITION_ID` | AnonCred cred def for auth | — |
| `VS_AGENT_ADMIN_URL` | VS Agent admin API | — |

### MCP Server Configuration

Via `MCP_SERVERS_CONFIG` env var (JSON array) or agent-pack `mcp.servers`:

```json
[
  {
    "name": "my-tools",
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "@example/mcp-server"]
  },
  {
    "name": "remote-api",
    "transport": "streamable-http",
    "url": "https://mcp.example.com/sse",
    "headers": { "Authorization": "Bearer TOKEN" }
  }
]
```

Supported transports: `stdio`, `sse`, `streamable-http`.

### Agent Pack YAML Structure

```yaml
metadata:
  name: my-agent
  version: "1.0"
  defaultLanguage: en

languages:
  en:
    greetingMessage: "Hello! How can I help?"
    systemPrompt: "You are a helpful assistant."
    strings:
      WELCOME: "Welcome!"
      AUTH_REQUIRED: "Please authenticate first."

llm:
  provider: openai
  model: gpt-4o-mini
  temperature: 0.2
  agentPrompt: "You are..."

rag:
  provider: langchain
  docsPath: ./docs
  remoteUrls: ["https://example.com/knowledge.pdf"]
  vectorStore:
    type: redis
    indexName: my-agent

memory:
  backend: memory
  window: 8

mcp:
  servers:
    - name: my-tools
      transport: stdio
      command: npx
      args: ["-y", "@example/mcp-server"]

flows:
  welcome:
    enabled: true
    sendOnProfile: true
    templateKey: greetingMessage
  authentication:
    enabled: true
    credentialDefinitionId: ${CREDENTIAL_DEFINITION_ID}
  menu:
    items:
      - id: authenticate
        labelKey: CREDENTIAL
        action: authenticate
        visibleWhen: unauthenticated
      - id: logout
        labelKey: LOGOUT
        action: logout
        visibleWhen: authenticated

tools:
  statistics:
    enabled: true
    endpoint: ${STATISTICS_API_URL}
    requiresAuth: false

integrations:
  vsAgent:
    adminUrl: ${VS_AGENT_ADMIN_URL}
```
