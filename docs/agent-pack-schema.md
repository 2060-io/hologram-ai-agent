# Agent Pack Schema

Agent packs make the AI agent chatbot fully configurable so the same binary can be reused for different conversational agents.

## Goals

- **Single source of truth:** prompts, welcome messages, flows, tools, MCP servers, RAG/memory settings, and integrations live inside one manifest.
- **Backward compatibility:** if `AGENT_PACK_PATH` is not defined or the manifest is invalid, the application falls back to legacy environment variables.
- **Environment overrides:** any string value can reference `${VAR_NAME}` so deployments can override values at runtime.
- **Early validation:** the loader rejects malformed manifests during startup and surfaces warnings.

## Location and structure

```text
agent-packs/
  <agent-id>/
    agent-pack.yaml    # or agent-pack.yml / agent-pack.json
```

The service reads the path provided via `AGENT_PACK_PATH`. If not set, it defaults to `agent-packs/` in the current working directory. Accepted filenames: `agent-pack.yaml`, `agent-pack.yml`, `agent-pack.json`.

## Manifest fields (`agent-pack.yaml`)

| Field          | Type   | Required | Description                                                 |
| -------------- | ------ | -------- | ----------------------------------------------------------- |
| `metadata`     | object | no       | Agent identifiers and descriptive data.                     |
| `languages`    | map    | no       | Per-language prompts/messages (`en`, `es`, etc.).           |
| `llm`          | object | no       | LLM provider and model parameters.                          |
| `rag`          | object | no       | RAG and vector store settings.                              |
| `memory`       | object | no       | Memory backend and session window config.                   |
| `flows`        | object | no       | Welcome, authentication, and menu behavior.                 |
| `tools`        | object | no       | Dynamic tool JSON and bundled tool settings.                |
| `mcp`          | object | no       | MCP (Model Context Protocol) server connections.            |
| `integrations` | object | no       | External service configuration (VS Agent, DB, etc.).        |

All top-level fields are optional.

---

### metadata

```yaml
metadata:
  id: my-agent
  displayName: My Agent
  description: >-
    A conversational agent for managing Wise accounts.
  defaultLanguage: en
  tags: [wise, finance]
```

| Field             | Type     | Default | Description                        |
| ----------------- | -------- | ------- | ---------------------------------- |
| `id`              | string   | —       | Unique agent identifier.           |
| `displayName`     | string   | —       | Human-readable agent name.         |
| `description`     | string   | —       | Optional description.              |
| `defaultLanguage` | string   | `en`    | Default language code.             |
| `tags`            | string[] | —       | Optional tags for categorization.  |

---

### languages

A map keyed by language code (e.g., `en`, `es`, `fr`). Each entry can define:

| Field             | Type              | Description                                                       |
| ----------------- | ----------------- | ----------------------------------------------------------------- |
| `greetingMessage` | string            | Short greeting sent on connection. Supports `{userName}` placeholder. |
| `welcomeMessage`  | string            | Alias for `greetingMessage` (deprecated, use `greetingMessage`).  |
| `systemPrompt`    | string            | LLM system prompt / persona for this language.                    |
| `strings`         | map<string, string> | Localized literals (menu labels, auth messages, etc.).           |

```yaml
languages:
  en:
    greetingMessage: "Hello {userName}! How can I help you today?"
    systemPrompt: |
      You are a helpful financial assistant...
    strings:
      CREDENTIAL: "Authenticate"
      LOGOUT: "Logout"
  es:
    greetingMessage: "¡Hola {userName}! ¿En qué puedo ayudarte?"
    systemPrompt: |
      Eres un asistente financiero...
    strings:
      CREDENTIAL: "Autenticarse"
      LOGOUT: "Cerrar sesión"
```

---

### llm

| Field          | Type           | Env override          | Default      | Description                          |
| -------------- | -------------- | --------------------- | ------------ | ------------------------------------ |
| `provider`     | string         | `LLM_PROVIDER`        | `openai`     | LLM provider (`openai`, `ollama`, `anthropic`). Use `openai` for any OpenAI-compatible API. |
| `model`        | string         | `OPENAI_MODEL`        | `gpt-4o-mini`| Model name.                          |
| `temperature`  | number/string  | `OPENAI_TEMPERATURE`  | `0.3`        | Sampling temperature (0–1).          |
| `maxTokens`    | number/string  | `OPENAI_MAX_TOKENS`   | `512`        | Max tokens per completion.           |
| `baseUrl`      | string         | `OPENAI_BASE_URL`     | —            | Base URL for OpenAI-compatible APIs (e.g., Kimi, DeepSeek, Groq, Together AI). |
| `agentPrompt`  | string         | `AGENT_PROMPT`        | —            | Default agent prompt / persona.      |
| `verbose`      | boolean/string | —                     | —            | Enable verbose LLM logging.          |

```yaml
llm:
  provider: openai
  model: gpt-4o-mini
  temperature: 0.3
  maxTokens: 1000
  agentPrompt: |
    You are an AI financial assistant...
```

#### Using OpenAI-compatible providers

Any API that follows the OpenAI chat completions format can be used by setting `provider: openai` and providing a `baseUrl`:

```yaml
# Kimi (Moonshot AI)
llm:
  provider: openai
  model: moonshot-v1-8k
  baseUrl: https://api.moonshot.cn/v1

# DeepSeek
llm:
  provider: openai
  model: deepseek-chat
  baseUrl: https://api.deepseek.com

# Groq
llm:
  provider: openai
  model: llama-3.3-70b-versatile
  baseUrl: https://api.groq.com/openai/v1

# Together AI
llm:
  provider: openai
  model: meta-llama/Llama-3-70b-chat-hf
  baseUrl: https://api.together.xyz/v1
```

Set the corresponding API key via `OPENAI_API_KEY` (or the agent pack's environment variable resolution).

---

### rag

| Field                  | Type           | Env override         | Default        | Description                              |
| ---------------------- | -------------- | -------------------- | -------------- | ---------------------------------------- |
| `provider`             | string         | `RAG_PROVIDER`       | `vectorstore`  | RAG provider (`vectorstore`, `langchain`). |
| `docsPath`             | string         | `RAG_DOCS_PATH`      | `./docs`       | Local directory for RAG documents.       |
| `remoteUrls`           | string[]       | `RAG_REMOTE_URLS`    | `[]`           | Remote document URLs (.txt, .md, .pdf, .csv). |
| `chunkSize`            | number/string  | `RAG_CHUNK_SIZE`     | `1000`         | Document chunk size (characters).        |
| `chunkOverlap`         | number/string  | `RAG_CHUNK_OVERLAP`  | `200`          | Overlap between chunks (characters).     |
| `vectorStore.type`     | string         | `VECTOR_STORE`       | `redis`        | Vector store provider (`redis`, `pinecone`). |
| `vectorStore.indexName` | string        | `VECTOR_INDEX_NAME`  | `agent-ia`     | Index name for the vector store.         |
| `pinecone.apiKey`      | string         | `PINECONE_API_KEY`   | —              | Pinecone API key (if using Pinecone).    |

```yaml
rag:
  provider: langchain
  docsPath: ./docs
  remoteUrls:
    - https://example.com/docs/guide.md
  chunkSize: 1000
  chunkOverlap: 200
  vectorStore:
    type: redis
    indexName: my-agent
  pinecone:
    apiKey: ${PINECONE_API_KEY}
```

---

### memory

| Field      | Type          | Env override            | Default                  | Description                     |
| ---------- | ------------- | ----------------------- | ------------------------ | ------------------------------- |
| `backend`  | string        | `AGENT_MEMORY_BACKEND`  | `memory`                 | `memory` (in-memory) or `redis`. |
| `window`   | number/string | `AGENT_MEMORY_WINDOW`   | `8`                      | Session memory window size.     |
| `redisUrl`  | string       | `REDIS_URL`             | `redis://localhost:6379` | Redis URL for persistent storage. |

```yaml
memory:
  backend: redis
  window: 20
  redisUrl: redis://redis:6379
```

---

### flows

#### flows.welcome

| Field           | Type           | Description                                            |
| --------------- | -------------- | ------------------------------------------------------ |
| `enabled`       | boolean/string | Enable the welcome flow.                               |
| `sendOnProfile` | boolean/string | Send greeting when user profile is received.           |
| `templateKey`   | string         | Key in `languages.<lang>` to use as greeting template. |

#### flows.authentication

| Field                    | Type           | Env override                | Description                                                                 |
| ------------------------ | -------------- | --------------------------- | --------------------------------------------------------------------------- |
| `enabled`                | boolean/string | —                           | Enable credential-based authentication.                                     |
| `required`               | boolean/string | `AUTH_REQUIRED`             | Block guest (unauthenticated) users from chatting.                          |
| `credentialDefinitionId` | string         | `CREDENTIAL_DEFINITION_ID`  | Verifiable credential definition ID for authentication.                     |
| `userIdentityAttribute`  | string         | `USER_IDENTITY_ATTRIBUTE`   | Credential attribute used as unique user identity (e.g., `email`, `login`). Default: `name`. |
| `rolesAttribute`         | string         | `ROLES_ATTRIBUTE`           | Credential attribute containing user roles (string, CSV, or JSON array).    |
| `defaultRole`            | string         | `DEFAULT_ROLE`              | Fallback role when credential lacks the roles attribute. Default: `user`.   |
| `adminUsers`             | string[]       | `ADMIN_USERS` (CSV)         | User identities that bypass all RBAC checks. Replaces legacy `adminAvatars`. |
| `adminAvatars`           | string[]       | `ADMIN_AVATARS` (CSV)       | (Legacy) Avatar names with admin privileges. Use `adminUsers` instead.      |

#### flows.menu

| Field   | Type   | Description              |
| ------- | ------ | ------------------------ |
| `items` | array  | List of menu item objects. |

Each menu item:

| Field         | Type   | Description                                                        |
| ------------- | ------ | ------------------------------------------------------------------ |
| `id`          | string | Unique menu item identifier.                                       |
| `labelKey`    | string | (Optional) Key into `languages.<lang>.strings` for the display label. |
| `label`       | string | (Optional) Static label text. Used if `labelKey` is not set.       |
| `action`      | string | Action to trigger (e.g., `authenticate`, `logout`, `mcp-config`, `abort-config`, `my-approval-requests`, `pending-approvals`). |
| `visibleWhen` | enum   | `always`, `authenticated`, `unauthenticated`, `configuring`, `notConfiguring`, `hasApprovalRequests`, `hasPendingApprovals`. |
| `badge`       | string | (Optional) Dynamic badge key. The agent resolves this to a count shown next to the label. Values: `approvalRequestCount`, `pendingApprovalCount`. |

```yaml
flows:
  welcome:
    enabled: true
    sendOnProfile: true
    templateKey: greetingMessage
  authentication:
    enabled: true
    required: true
    credentialDefinitionId: ${CREDENTIAL_DEFINITION_ID}
    userIdentityAttribute: employeeLogin
    rolesAttribute: roles
    defaultRole: employee
    adminUsers:
      - alice@acme.corp
    adminAvatars:          # legacy — prefer adminUsers
      - bob
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
      - id: mcp-config
        labelKey: MCP_CONFIG_MENU
        action: mcp-config
        visibleWhen: notConfiguring
      - id: abort-config
        labelKey: MCP_CONFIG_ABORT
        action: abort-config
        visibleWhen: configuring
      - id: my-approval-requests
        labelKey: MY_APPROVAL_REQUESTS
        action: my-approval-requests
        visibleWhen: hasApprovalRequests
        badge: approvalRequestCount
      - id: pending-approvals
        labelKey: PENDING_APPROVALS
        action: pending-approvals
        visibleWhen: hasPendingApprovals
        badge: pendingApprovalCount
```

---

### tools

| Field           | Type   | Env override       | Description                                         |
| --------------- | ------ | ------------------ | --------------------------------------------------- |
| `dynamicConfig` | any    | `LLM_TOOLS_CONFIG` | JSON string or object defining external LLM tools.  |
| `bundled`       | map    | —                  | Settings for built-in tools (keyed by tool name).   |

#### bundled.statisticsFetcher

| Field              | Type     | Env override              | Default          | Description                       |
| ------------------ | -------- | ------------------------- | ---------------- | --------------------------------- |
| `enabled`          | boolean  | `STATISTICS_TOOL_ENABLED` | `true`           | Enable the statistics tool.       |
| `endpoint`         | string   | `STATISTICS_API_URL`      | —                | Statistics API endpoint URL.      |
| `requiresAuth`     | boolean  | `STATISTICS_REQUIRE_AUTH` | `false`          | Require authentication for stats. |
| `defaultStatClass` | string   | —                         | `USER_CONNECTED` | Default statistics class.         |
| `defaultStatEnums` | array    | —                         | —                | Default enum values for stats.    |

```yaml
tools:
  dynamicConfig: ${LLM_TOOLS_CONFIG}
  bundled:
    statisticsFetcher:
      enabled: true
      endpoint: ${STATISTICS_API_URL}
      requiresAuth: false
      defaultStatClass: USER_CONNECTED
```

---

### mcp

MCP (Model Context Protocol) server configuration. Env override: `MCP_SERVERS_CONFIG` (JSON array string).

```yaml
mcp:
  servers:
    - name: wise
      transport: streamable-http
      url: ${WISE_MCP_URL}
      ...
```

Each server entry:

| Field        | Type                          | Description                                                          |
| ------------ | ----------------------------- | -------------------------------------------------------------------- |
| `name`       | string                        | Unique server name.                                                  |
| `transport`  | enum                          | `stdio`, `sse`, or `streamable-http`.                                |
| `url`        | string                        | Server URL (required for `sse` and `streamable-http`).               |
| `command`    | string                        | Executable command (required for `stdio`).                           |
| `args`       | string[] or string            | Command arguments (for `stdio`).                                     |
| `env`        | map<string, string>           | Environment variables passed to the stdio process.                   |
| `headers`    | map<string, string>           | HTTP headers sent with every request (for `sse`/`streamable-http`). |
| `reconnect`  | boolean/string                | Auto-reconnect on disconnect.                                        |
| `accessMode` | enum                          | `admin-controlled` (default) or `user-controlled`.                   |
| `userConfig` | object                        | User-facing configuration (only when `accessMode: user-controlled`). |
| `toolAccess` | object                        | Tool-level access control.                                           |

#### mcp.servers[].userConfig

When `accessMode` is `user-controlled`, each user is prompted to provide configuration values (e.g., API tokens) through the chat interface.

| Field    | Type  | Description                   |
| -------- | ----- | ----------------------------- |
| `fields` | array | List of user config fields.   |

Each field:

| Field            | Type                     | Description                                                        |
| ---------------- | ------------------------ | ------------------------------------------------------------------ |
| `name`           | string                   | Internal field name (e.g., `token`).                               |
| `type`           | enum                     | `secret` (masked, never logged) or `text`.                         |
| `label`          | string or map<string, string> | Localized prompt label. A map keyed by language code, or a plain string. |
| `headerTemplate` | string                   | Maps the value into a header. e.g., `"Bearer {value}"`.           |
| `headerName`     | string                   | HTTP header name to set. Defaults to `Authorization` if omitted.  |

#### mcp.servers[].toolAccess

Two models are supported. When `roles` is defined, the RBAC model is active; otherwise the legacy model applies.

**Legacy model:**

| Field     | Type     | Description                                                              |
| --------- | -------- | ------------------------------------------------------------------------ |
| `default` | enum     | `public` (all tools available to all users) or `admin` (admin-only by default). |
| `public`  | string[] | Tools explicitly available to all users (when `default: admin`).         |

**RBAC model:**

| Field      | Type                | Description                                                              |
| ---------- | ------------------- | ------------------------------------------------------------------------ |
| `default`  | enum                | `none` (deny unlisted tools), `all` (allow unlisted tools), or legacy values. |
| `roles`    | map<string, string[]> | Maps role names to lists of tool names accessible by that role.        |
| `approval` | array               | List of approval policies (see below).                                   |

Each approval policy:

| Field            | Type     | Description                                              |
| ---------------- | -------- | -------------------------------------------------------- |
| `tools`          | string[] | Tool names that require approval.                        |
| `approvers`      | string[] | Role names that can approve requests for these tools.    |
| `timeoutMinutes` | number   | Minutes before a pending request expires. Default: `60`. |

```yaml
toolAccess:
  default: none
  roles:
    guest: [get_exchange_rate]
    employee: [list_profiles, get_balances, list_transfers]
    finance: [send_money, create_invoice, list_recipients]
  approval:
    - tools: [send_money]
      approvers: [finance-manager, cfo]
      timeoutMinutes: 60
    - tools: [create_invoice]
      approvers: [finance-manager]
      timeoutMinutes: 120
```

When RBAC is active:

- Tools are **filtered per user** — the LLM only sees tools the user's roles can access
- `adminUsers` bypass all RBAC checks and see all tools
- Users holding both a tool role and an approver role get **self-approval** (immediate execution)
- Stale approval requests are automatically expired via a periodic task

#### Example: End-user mode (each user provides their own token)

```yaml
mcp:
  servers:
    - name: wise
      transport: streamable-http
      url: ${WISE_MCP_URL}
      accessMode: user-controlled
      userConfig:
        fields:
          - name: token
            type: secret
            label:
              en: "Please enter your Wise API Token:"
              es: "Por favor, ingresa tu Token de API de Wise:"
            headerTemplate: "Bearer {value}"
      toolAccess:
        default: public
```

#### Example: Corporate mode with RBAC (shared token, role-based access)

When `accessMode` is omitted, it defaults to `admin-controlled`: a shared connection is established at startup using the global `headers`, and all users share it.

```yaml
mcp:
  servers:
    - name: wise
      transport: streamable-http
      url: ${WISE_MCP_URL}
      accessMode: admin-controlled
      headers:
        Authorization: "Bearer ${WISE_API_TOKEN}"
      toolAccess:
        default: none
        roles:
          guest: [get_exchange_rate]
          employee: [list_profiles, get_balances]
          finance: [send_money, create_invoice]
        approval:
          - tools: [send_money]
            approvers: [finance-manager]
            timeoutMinutes: 60
```

#### Example: Corporate mode without RBAC (legacy)

```yaml
mcp:
  servers:
    - name: wise
      transport: streamable-http
      url: ${WISE_MCP_URL}
      accessMode: admin-controlled
      headers:
        Authorization: "Bearer ${WISE_API_TOKEN}"
      toolAccess:
        default: public
```

---

### integrations

Free-form configuration for external services. The schema accepts any structure under `vsAgent` and `postgres`.

```yaml
integrations:
  vsAgent:
    adminUrl: ${VS_AGENT_ADMIN_URL}
    stats:
      enabled: ${VS_AGENT_STATS_ENABLED}
      host: ${VS_AGENT_STATS_HOST}
      port: ${VS_AGENT_STATS_PORT}
      queue: ${VS_AGENT_STATS_QUEUE}
      username: ${VS_AGENT_STATS_USER}
      password: ${VS_AGENT_STATS_PASSWORD}
  postgres:
    host: ${POSTGRES_HOST}
    user: ${POSTGRES_USER}
    password: ${POSTGRES_PASSWORD}
    dbName: ${POSTGRES_DB_NAME}
```

---

## Value resolution order

1. Load `agent-pack.yaml` (or `.yml` / `.json`).
2. Replace `${VAR}` placeholders with `process.env.VAR` when available.
3. Explicit environment variables (e.g., `AGENT_PROMPT`, `LLM_TOOLS_CONFIG`, `MCP_SERVERS_CONFIG`) override the resolved pack values.
4. Fall back to hard-coded defaults when neither pack nor env provides a value.

## Compatibility

- If `AGENT_PACK_PATH` is missing or invalid, a warning is logged and the app continues with legacy env-only configuration.
- Packs can be swapped by mounting a different directory and pointing `AGENT_PACK_PATH` to it (Docker, Kubernetes, etc.).
