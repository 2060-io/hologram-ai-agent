import { registerAs } from '@nestjs/config'
import { config as dotenvConfig } from 'dotenv'
import { loadAgentPack, pickNumber, pickString, resolveRagRemoteUrls, resolveToolsConfig, resolveMcpServers } from './agent-pack.loader'

// Load .env early so resolvePlaceholders() in loadAgentPack() can resolve ${VAR} refs.
// override: true ensures .env values win over stale shell env vars.
dotenvConfig({ path: '.env', override: true })

const agentPackResult = loadAgentPack()
const agentPack = agentPackResult.pack

// Resolve tools configuration (LLM tools and statistics tool)
const { llmToolsConfig, agentPackBundledTools, statisticsToolConfig } = resolveToolsConfig({
  envLlmTools: process.env.LLM_TOOLS_CONFIG,
  packDynamicTools: agentPack?.tools?.dynamicConfig,
  packBundledTools: (agentPack?.tools?.bundled as Record<string, unknown>) ?? {},
})

/**
 * Global application configuration loader.
 * Organizes and documents all environment variables.
 */
export default registerAs('appConfig', () => ({
  // Application General Settings

  agentPack: agentPack ?? null,
  agentPackMeta: {
    manifestPath: agentPackResult.manifestPath,
    warnings: agentPackResult.warnings,
    error: agentPackResult.errorMessage,
  },

  /**
   * Bundled tools provided by the agent pack.
   */
  agentPackBundledTools,

  /**
   * The port number where the application HTTP server runs.
   * Default: 3000
   */
  appPort: parseInt(process.env.APP_PORT || '3000', 10),

  /**
   * Log level for application logging.
   * Default: 1 (minimal logs)
   */
  logLevel: parseInt(process.env.LOG_LEVEL || '1', 10),

  // LLM & Agent Settings

  /**
   * The default agent prompt to define the LLM's persona/role.
   */
  agentPrompt: pickString('AGENT_PROMPT', agentPack?.llm?.agentPrompt, ''),

  /**
   * LLM provider to use: "openai" | "ollama" | "anthropic" | etc.
   * Default: openai
   */
  llmProvider: pickString('LLM_PROVIDER', agentPack?.llm?.provider, 'openai'),

  /**
   * Ollama endpoint URL for local LLM inference.
   * Default: http://localhost:11434
   */
  ollamaEndpoint: process.env.OLLAMA_ENDPOINT || 'http://localhost:11434',

  /**
   * Model name for Ollama provider (e.g., "llama3", "phi3", etc).
   * Default: llama3
   */
  ollamaModel: process.env.OLLAMA_MODEL || 'llama3',

  /**
   * OpenAI API key (required if using OpenAI provider).
   */
  openaiApiKey: process.env.OPENAI_API_KEY || '',

  /**
   * OpenAI Model .
   */
  openaiModel: pickString('OPENAI_MODEL', agentPack?.llm?.model, 'gpt-4o-mini'),

  /**
   * OpenAI temperature (0-1).
   */
  openaiTemperature: pickNumber('OPENAI_TEMPERATURE', agentPack?.llm?.temperature, 0.3),

  /**
   * OpenAI max tokens per completion.
   */
  openaiMaxTokens: pickNumber('OPENAI_MAX_TOKENS', agentPack?.llm?.maxTokens, 512),

  /**
   * Anthropic API key (required if using Anthropic provider, e.g., Claude).
   */
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',

  // RAG (Retrieval Augmented Generation) Settings

  /**
   * Directory path from which RAG loads .txt and .pdf documents for context retrieval.
   */
  ragDocsPath: pickString('RAG_DOCS_PATH', agentPack?.rag?.docsPath, './docs'),

  /**
   * Optional list of remote document URLs to ingest for RAG (CSV or JSON array strings).
   * Supported extensions: .txt, .md, .pdf, .csv
   */
  ragRemoteUrls: resolveRagRemoteUrls(process.env.RAG_REMOTE_URLS, agentPack?.rag?.remoteUrls),

  /**
   * RAG provider selection. "vectorstore" (custom) or "langchain" (with supported vector stores).
   * Default: "vectorstore"
   */
  ragProvider: pickString('RAG_PROVIDER', agentPack?.rag?.provider, 'vectorstore'),

  /**
   * Vector store provider for RAG: "pinecone","redis" etc.
   * Used when RAG_PROVIDER = "langchain"
   * Default: redis
   */
  vectorStore: pickString('VECTOR_STORE', agentPack?.rag?.vectorStore?.type, 'redis'),

  /**
   * Shared index name for all supported vector stores (e.g., Pinecone, Redis).
   * Set as VECTOR_INDEX_NAME in your environment.
   * Default: hologram-ia
   */
  vectorIndexName: pickString('VECTOR_INDEX_NAME', agentPack?.rag?.vectorStore?.indexName, 'agent-ia'),

  /**
   * Pinecone API key (required if using Pinecone vector store).
   */
  pineconeApiKey: pickString('PINECONE_API_KEY', agentPack?.rag?.pinecone?.apiKey, ''),

  // Memory/Session Settings

  /**
   * Memory backend: "memory" for in-memory, "redis" for Redis.
   * Default: memory
   */
  agentMemoryBackend: pickString('AGENT_MEMORY_BACKEND', agentPack?.memory?.backend, 'memory'),

  /**
   * Number of messages/tokens to keep in session memory window.
   * Default: 8
   */
  agentMemoryWindow: pickNumber('AGENT_MEMORY_WINDOW', agentPack?.memory?.window, 8),

  // External Service URLs

  /**
   * Redis database URL for persistent memory/session storage.
   * Default: redis://localhost:6379
   */
  redisUrl: pickString('REDIS_URL', agentPack?.memory?.redisUrl, 'redis://localhost:6379'),

  // PostgreSQL Database Configuration

  /**
   * Hostname or IP address for the PostgreSQL database.
   * Default: "postgres"
   */
  postgresHost: process.env.POSTGRES_HOST || 'postgres',

  /**
   * Username for the PostgreSQL database.
   * Default: "2060demo"
   */
  postgresUser: process.env.POSTGRES_USER || '2060demo',

  /**
   * Name for the PostgreSQL database.
   * Default: "test-service-agent"
   */
  postgresDbName: process.env.POSTGRES_DB_NAME || 'test-service-agent',

  /**
   * Password for the PostgreSQL database.
   * Default: "2060demo"
   */
  postgresPassword: process.env.POSTGRES_PASSWORD || '2060demo',

  // Other Service URLs / Settings

  /**
   * Verifiable credential definition id or URL.
   * Default: "did:web:example.com??service=anoncreds&relativeRef=/credDef/somethinghere"
   */
  credentialDefinitionId: process.env.CREDENTIAL_DEFINITION_ID,

  /**
   * Comma-separated list of avatar names that have admin privileges.
   */
  adminAvatars: process.env.ADMIN_AVATARS
    ? process.env.ADMIN_AVATARS.split(',').map((s: string) => s.trim()).filter(Boolean)
    : (agentPack?.flows?.authentication?.adminAvatars ?? []),

  /**
   * Service Agent Admin API URL.
   */
  vsAgentAdminUrl: process.env.VS_AGENT_ADMIN_URL,

  /**
   * - llmToolsConfig: JSON string defining external tools available to the LLM agent.
   *   Each tool should specify a unique name, description, endpoint, HTTP method,
   *   and any authentication if required.
   *
   *   Example (set in your .env):
   *   LLM_TOOLS_CONFIG=[
   *     {
   *       "name": "getStats",
   *       "description": "Query system statistics by keyword.",
   *       "endpoint": "https://api.example.com/stats?query={query}",
   *       "method": "GET"
   *     }
   *   ]
   *
   *   Puede declararse en agent-pack (tools.dynamicConfig) y sobrescribirse con LLM_TOOLS_CONFIG.
   */
  llmToolsConfig,

  /**
   * Configuración de la herramienta de estadísticas (bundled) que se puede habilitar/ajustar desde
   * el agent pack o variables de entorno.
   */
  statisticsTool: statisticsToolConfig,

  /**
   * Maximum size (in characters or tokens) for each document chunk when splitting documents
   * for Retrieval-Augmented Generation (RAG) processing.
   *
   * This value can be configured via the `RAG_CHUNK_SIZE` environment variable.
   * If not set, it defaults to 1000.
   */
  ragChunkSize: pickNumber('RAG_CHUNK_SIZE', agentPack?.rag?.chunkSize, 1000),

  /**
   * for Retrieval-Augmented Generation (RAG) processing.
   * Overlap size (in characters or tokens) between document chunks when splitting documents
   * This value can be configured via the `RAG_CHUNK_OVERLAP` environment variable.
   * If not set, it defaults to 200.
   */
  chunkOverlap: pickNumber('RAG_CHUNK_OVERLAP', agentPack?.rag?.chunkOverlap, 200),

  // MCP (Model Context Protocol) Server Configuration

  /**
   * MCP servers to connect to at startup.
   * Configurable via MCP_SERVERS_CONFIG env var (JSON array) or agent-pack mcp.servers.
   */
  mcpServers: resolveMcpServers(process.env.MCP_SERVERS_CONFIG, agentPack?.mcp?.servers),
}))
