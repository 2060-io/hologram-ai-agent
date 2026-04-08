# hologram-generic-ai-agent-mcp-vs Helm Chart

## Overview

This Helm chart deploys the `hologram-generic-ai-agent-mcp-vs` application and all required Kubernetes components: `chatbot`, `vs-agent`, `postgres`, `redis`, `stats`, and (optional) `artemis`.

- The `vs-agent` component is deployed as a Helm dependency (`vs-agent-chart`) and configured entirely via `values.yaml`.

- Ingress definitions are preconfigured and rely on a shared global domain setting.

---

## Custom name

Use `nameOverride` to set a fixed name/prefix for all components (avoids collisions across agents or deployments). If you leave it empty, the chart name is used. Example: to keep the prefix `hologram-welcome-ai-agent`, set it in `values.yaml` or via CLI:

```yaml
nameOverride: hologram-welcome-ai-agent
```

or

```bash
helm upgrade --install hologram-welcome ./charts --namespace <ns> --set nameOverride=hologram-welcome-ai-agent
```

With that setting, resources render as:

- `hologram-welcome-ai-agent-chatbot-0` (app/chatbot)
- `hologram-welcome-ai-agent-postgres-0`
- `hologram-welcome-ai-agent-redis-0`
- `hologram-welcome-ai-agent-stats-0`
- `hologram-welcome` (VS Agent, from dependency)

---

## Installation Guide

### 1. Lint the Chart

Ensure the Helm chart is correctly formatted:

```bash
helm lint ./charts/
```

---

### 2. Render Templates

Preview the generated Kubernetes manifests:

```bash
helm template <release-name> ./charts/ --namespace <your-namespace>
```

---

### 3. Dry-Run Installation

Simulate the installation without modifying your cluster:

```bash
helm install --dry-run --debug <release-name> ./charts/ --namespace <your-namespace>
```

---

### 4. Install the Chart

Ensure the target namespace already exists:

```bash
helm upgrade --install <release-name> ./charts/ --namespace <your-namespace>
```

> **Note:** `<release-name>` is a Helm release identifier. For example:

```bash
helm upgrade hologram-generic-chart ./charts --namespace <your-namespace-prod>
```

---

### 5. Uninstall the Chart

To uninstall the release:

```bash
helm uninstall hologram-generic-chart --namespace <your-namespace>
```

---

## Environment Variable Management

All environment variables used by each component are defined inside `values.yaml` under their corresponding section.

Plain variables are injected via `env` entries.

> The `vs-agent` subchart defines its own environment variables directly in its own templates.

---

## Ingress with Global Domain

All ingress resources use the shared domain defined in `global.domain`. This allows centralized control of subdomain routing per component. Example:

```yaml
host: chatbot.{{ .Values.global.domain }}
tlsSecretName: chatbot.{{ .Values.global.domain }}-cert
```

This pattern is applied to all ingress-enabled components.

---

## Environment Variables by Component

Below is a summary of the environment variables required by each component. All values must be defined under `values.yaml` in their respective section.

### 📦 Chatbot

| Source | Key                      | Description                        |
| ------ | ------------------------ | ---------------------------------- |
| Env    | APP_PORT                 | Port where the chatbot runs        |
| Env    | LOG_LEVEL                | Logging level                      |
| Env    | LLM_PROVIDER             | LLM provider name                  |
| Env    | OPENAI_MODEL             | Model name for OpenAI              |
| Env    | OPENAI_TEMPERATURE       | Temperature for OpenAI completions |
| Env    | OPENAI_MAX_TOKENS        | Max tokens per OpenAI completion   |
| Env    | VECTOR_STORE             | Vector DB to use                   |
| Env    | VECTOR_INDEX_NAME        | Name of vector index               |
| Env    | RAG_PROVIDER             | RAG implementation used            |
| Env    | RAG_DOCS_PATH            | Base path for RAG docs & cache     |
| Env    | RAG_CHUNK_SIZE           | Chunk size for document splitting  |
| Env    | RAG_CHUNK_OVERLAP        | Chunk overlap for splitting        |
| Env    | RAG_REMOTE_URLS          | Remote document URLs (JSON list)   |
| Env    | AGENT_MEMORY_BACKEND     | Memory backend                     |
| Env    | AGENT_MEMORY_WINDOW      | Memory window size                 |
| Env    | AGENT_PACK_PATH          | Path to the mounted agent pack     |
| Env    | VS_AGENT_STATS_ENABLED   | Enable stats fetching              |
| Env    | VS_AGENT_STATS_HOST      | Stats broker host                  |
| Env    | VS_AGENT_STATS_PORT      | Broker port                        |
| Env    | VS_AGENT_STATS_QUEUE     | Broker queue name                  |
| Env    | VS_AGENT_STATS_USER      | Broker user                        |
| Env    | VS_AGENT_STATS_PASSWORD  | Broker password                    |
| Env    | REDIS_URL                | Redis connection URL               |
| Env    | AGENT_PROMPT             | Custom LLM agent prompt            |
| Env    | VS_AGENT_ADMIN_URL       | VS Agent admin URL                 |
| Env    | CREDENTIAL_DEFINITION_ID | VC credential definition           |
| Env    | POSTGRES_HOST            | Postgres host URL                  |
| Env    | LLM_TOOLS_CONFIG         | LLM tools config (JSON)            |
| Env    | STATISTICS_API_URL       | External statistics API endpoint   |
| Env    | STATISTICS_REQUIRE_AUTH  | Require auth on stats              |
| Env    | STATISTICS_TOOL_ENABLED  | Enable/disable bundled stats tool  |
| Env    | OLLAMA_ENDPOINT          | Ollama endpoint                    |
| Env    | OLLAMA_MODEL             | Ollama model name                  |
| Secret | OPENAI_API_KEY           | OpenAI API key                     |
| Secret | ANTHROPIC_API_KEY        | Anthropic API key                  |
| Secret | PINECONE_API_KEY         | Pinecone API key                   |
| Secret | POSTGRES_USER            | DB user                            |
| Secret | POSTGRES_PASSWORD        | DB password                        |
| Secret | POSTGRES_DB_NAME         | DB name                            |

---

### 📦 Vs-Agent (via `vs-agent-chart`)

This subchart is fully configured via the `vs-agent-chart` section in `values.yaml`. All `env` variables are defined directly in the template.

| Key                                    | Description               |
| -------------------------------------- | ------------------------- |
| AGENT_ENDPOINT                         | WebSocket endpoint        |
| AGENT_LABEL                            | Agent display label       |
| AGENT_INVITATION_IMAGE_URL             | Image URL for invitations |
| EVENTS_BASE_URL                        | Event receiver base URL   |
| AGENT_PUBLIC_DID                       | Public DID                |
| ANONCREDS_SERVICE_BASE_URL             | Anoncreds service URL     |
| REDIRECT_DEFAULT_URL_TO_INVITATION_URL | Redirect control          |
| POSTGRES_HOST                          | Postgres service hostname |
| POSTGRES_USER                          | Postgres DB user          |
| POSTGRES_PASSWORD                      | Postgres DB password      |
| REDIS_HOST                             | Redis service hostname    |

---

### 📦 Postgres

| Source | Key               | Description              |
| ------ | ----------------- | ------------------------ |
| Secret | POSTGRES_USER     | Postgres DB user         |
| Secret | POSTGRES_PASSWORD | Postgres DB password     |
| Secret | POSTGRES_DB       | Name of the DB to create |

---

### 📦 Stats

| Source | Key                                         | Description                  |
| ------ | ------------------------------------------- | ---------------------------- |
| Env    | DEBUG                                       | Log level                    |
| Env    | QUARKUS_HTTP_PORT                           | App port                     |
| Env    | COM_MOBIERA_MS_COMMONS_STATS_JMS_QUEUE_NAME | Queue name                   |
| Env    | COM_MOBIERA_MS_COMMONS_STATS_THREADS        | Number of processing threads |
| Env    | COM_MOBIERA_MS_COMMONS_STATS_STANDALONE     | Run in standalone mode       |
| Env    | QUARKUS_ARTEMIS_A0_URL                      | Artemis broker URL           |
| Env    | QUARKUS_ARTEMIS_A0_USERNAME                 | Artemis username             |
| Env    | QUARKUS_DATASOURCE_JDBC_URL                 | JDBC connection string       |
| Env    | QUARKUS_DATASOURCE_USERNAME                 | DB user                      |
| Secret | QUARKUS_DATASOURCE_PASSWORD                 | DB password                  |
| Secret | QUARKUS_ARTEMIS_A0_PASSWORD                 | Artemis password             |

---

### 📦 Artemis

| Source | Key              | Description     |
| ------ | ---------------- | --------------- |
| Secret | ARTEMIS_USER     | Broker user     |
| Secret | ARTEMIS_PASSWORD | Broker password |

---

## Final Notes

- All environment variables are managed through `values.yaml`, using `env` and `secretKeyRef` as needed.
- The `vs-agent` dependency uses inline values only, not `ConfigMaps` or Helm-generated Secrets.
- Ingress routing is centralized via `.Values.global.domain`, enabling consistent hostname and TLS management.
- To bundle a custom `agent-pack`, set `chatbot.agentPack.enabled=true`; the chart will create/mount a ConfigMap at `/app/agent-packs/<name>/agent-pack.yaml` and export `AGENT_PACK_PATH` automatically. You can also point to an existing ConfigMap via `chatbot.agentPack.existingConfigMap`.

### Add agent-pack

```yaml
chatbot:
  agentPack:
    enabled: true
    name: customer-service
    # mountPath: /app/agent-packs/customer-service   # optional
    existingConfigMap: '' # set the name of the already created configMap
    content: |
      metadata:
        id: customer-service
        displayName: Customer Service Agent
        defaultLanguage: es
      languages:
        es:
          greetingMessage: "Hola, soy tu asistente."
          systemPrompt: "Eres un agente de atención."
```
