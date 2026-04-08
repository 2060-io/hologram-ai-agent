import * as fs from 'fs'
import * as path from 'path'
import { parse } from 'yaml'
import { z } from 'zod'

const DEFAULT_PACK_DIR = path.join(process.cwd(), 'agent-packs')
const POSSIBLE_FILENAMES = ['agent-pack.yaml', 'agent-pack.yml', 'agent-pack.json']

const LocalizedConfigSchema = z
  .object({
    greetingMessage: z.string().optional(),
    welcomeMessage: z.string().optional(),
    systemPrompt: z.string().optional(),
    strings: z.record(z.string()).optional(),
  })
  .passthrough()
  .transform(({ welcomeMessage, ...rest }) => ({
    ...rest,
    greetingMessage: rest.greetingMessage ?? welcomeMessage,
  }))

const AgentPackSchema = z
  .object({
    metadata: z
      .object({
        id: z.string(),
        displayName: z.string(),
        description: z.string().optional(),
        defaultLanguage: z.string().default('en'),
        tags: z.array(z.string()).optional(),
      })
      .optional(),
    languages: z.record(LocalizedConfigSchema).optional(),
    llm: z
      .object({
        provider: z.string().optional(),
        model: z.string().optional(),
        temperature: z.union([z.number(), z.string()]).optional(),
        maxTokens: z.union([z.number(), z.string()]).optional(),
        agentPrompt: z.string().optional(),
        verbose: z.union([z.boolean(), z.string()]).optional(),
      })
      .optional(),
    rag: z
      .object({
        provider: z.string().optional(),
        docsPath: z.string().optional(),
        remoteUrls: z.any().optional(),
        chunkSize: z.union([z.number(), z.string()]).optional(),
        chunkOverlap: z.union([z.number(), z.string()]).optional(),
        vectorStore: z
          .object({
            type: z.string().optional(),
            indexName: z.string().optional(),
          })
          .optional(),
        pinecone: z
          .object({
            apiKey: z.string().optional(),
          })
          .optional(),
      })
      .optional(),
    memory: z
      .object({
        backend: z.string().optional(),
        window: z.union([z.number(), z.string()]).optional(),
        redisUrl: z.string().optional(),
      })
      .optional(),
    flows: z
      .object({
        welcome: z
          .object({
            enabled: z.union([z.boolean(), z.string()]).optional(),
            sendOnProfile: z.union([z.boolean(), z.string()]).optional(),
            templateKey: z.string().optional(),
          })
          .optional(),
        authentication: z
          .object({
            enabled: z.union([z.boolean(), z.string()]).optional(),
            credentialDefinitionId: z.string().optional(),
            adminAvatars: z.array(z.string()).optional(),
          })
          .optional(),
        menu: z
          .object({
            items: z
              .array(
                z.object({
                  id: z.string(),
                  labelKey: z.string(),
                  action: z.string().optional(),
                  visibleWhen: z.enum(['always', 'authenticated', 'unauthenticated', 'configuring', 'notConfiguring']).optional(),
                }),
              )
              .optional(),
          })
          .optional(),
      })
      .optional(),
    tools: z
      .object({
        dynamicConfig: z.any().optional(),
        bundled: z.record(z.any()).optional(),
      })
      .optional(),
    mcp: z
      .object({
        servers: z
          .array(
            z.object({
              name: z.string(),
              transport: z.enum(['stdio', 'sse', 'streamable-http']),
              url: z.string().optional(),
              command: z.string().optional(),
              args: z.union([z.array(z.string()), z.string()]).optional(),
              env: z.record(z.string()).optional(),
              headers: z.record(z.string()).optional(),
              reconnect: z.union([z.boolean(), z.string()]).optional(),
              accessMode: z.enum(['admin-controlled', 'user-controlled']).optional(),
              userConfig: z
                .object({
                  fields: z
                    .array(
                      z.object({
                        name: z.string(),
                        type: z.enum(['secret', 'text']).optional(),
                        label: z.union([z.string(), z.record(z.string())]).optional(),
                        headerTemplate: z.string().optional(),
                        headerName: z.string().optional(),
                      }),
                    )
                    .optional(),
                })
                .optional(),
              toolAccess: z
                .object({
                  default: z.enum(['public', 'admin']).optional(),
                  public: z.array(z.string()).optional(),
                })
                .optional(),
            }),
          )
          .optional(),
      })
      .optional(),
    integrations: z
      .object({
        vsAgent: z.any().optional(),
        postgres: z.any().optional(),
      })
      .optional(),
  })
  .passthrough()

export type AgentPackConfig = z.infer<typeof AgentPackSchema>

export type AgentPackLoaderResult = {
  pack: AgentPackConfig | null
  manifestPath: string | null
  warnings: string[]
  errorMessage?: string
}

const placeholderRegex = /\$\{([\w\d_]+)\}/g

/**
 * Recursively resolves environment variable placeholders in the given value.
 * Placeholders are in the format ${VAR_NAME} and will be replaced with the
 * corresponding value from process.env if it exists.
 */
function resolvePlaceholders(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(placeholderRegex, (match, varName) => {
      const envValue = process.env[varName]
      return envValue !== undefined ? envValue : match
    })
  }

  if (Array.isArray(value)) {
    return value.map((item) => resolvePlaceholders(item))
  }

  if (value && typeof value === 'object') {
    return Object.entries(value).reduce<Record<string, unknown>>((acc, [key, val]) => {
      acc[key] = resolvePlaceholders(val)
      return acc
    }, {})
  }

  return value
}

/**
 *  Finds the manifest file path given a base path.
 * @param basePath
 * @returns
 */
function findManifestPath(basePath: string): string | null {
  let candidate = basePath

  if (fs.existsSync(basePath) && fs.lstatSync(basePath).isFile()) {
    return basePath
  }

  if (!fs.existsSync(basePath) || !fs.lstatSync(basePath).isDirectory()) {
    return null
  }

  for (const fileName of POSSIBLE_FILENAMES) {
    candidate = path.join(basePath, fileName)
    if (fs.existsSync(candidate)) {
      return candidate
    }
  }

  return null
}

/**
 * Loads and parses the agent pack configuration from the manifest file.
 * @returns
 */
export function loadAgentPack(): AgentPackLoaderResult {
  const warnings: string[] = []
  const basePath = process.env.AGENT_PACK_PATH ? path.resolve(process.env.AGENT_PACK_PATH) : DEFAULT_PACK_DIR
  const manifestPath = findManifestPath(basePath)

  if (!manifestPath) {
    warnings.push(`No se encontró agent-pack en "${basePath}".`)
    return { pack: null, manifestPath: null, warnings }
  }

  try {
    const raw = fs.readFileSync(manifestPath, 'utf-8')
    const data = parse(raw)
    const resolved = resolvePlaceholders(data)
    const pack = AgentPackSchema.parse(resolved)
    return { pack, manifestPath, warnings }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    warnings.push(`Error al cargar agent-pack: ${message}`)
    return { pack: null, manifestPath, warnings, errorMessage: message }
  }
}

/**
 *  Parses a string of remote URLs which can be in JSON array format or comma-separated.
 * @param raw
 * @returns
 */
export function parseRemoteUrls(raw: string): string[] {
  try {
    if (raw.trim().startsWith('[')) {
      return JSON.parse(raw)
    }
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

/**
 *  Picks a string value from environment variable, agent pack value, or fallback.
 * @param envKey
 * @param packValue
 * @param fallback
 * @returns
 */
export function pickString(envKey: string, packValue?: unknown, fallback = ''): string {
  const envVal = process.env[envKey]
  if (envVal !== undefined && envVal !== '') return envVal
  if (typeof packValue === 'string' && packValue.length > 0) return packValue
  return fallback
}

/**
 *
 * @param envKey
 * @param packValue
 * @param fallback
 * @returns
 */
export function pickNumber(envKey: string, packValue: unknown, fallback: number): number {
  const envVal = process.env[envKey]
  if (envVal !== undefined && envVal !== '') {
    const parsed = Number(envVal)
    if (!Number.isNaN(parsed)) return parsed
  }

  if (typeof packValue === 'number' && !Number.isNaN(packValue)) return packValue
  if (typeof packValue === 'string' && packValue.trim().length > 0) {
    const parsed = Number(packValue)
    if (!Number.isNaN(parsed)) return parsed
  }

  return fallback
}

/**
 *
 * @param envKey
 * @param packValue
 * @param fallback
 * @returns
 */
export function pickBoolean(envKey: string, packValue: unknown, fallback = false): boolean {
  const envVal = process.env[envKey]
  if (envVal !== undefined) {
    const normalized = envVal.trim().toLowerCase()
    if (['true', '1', 'yes'].includes(normalized)) return true
    if (['false', '0', 'no'].includes(normalized)) return false
  }

  if (typeof packValue === 'boolean') return packValue
  if (typeof packValue === 'string' && packValue.trim().length > 0) {
    const normalized = packValue.trim().toLowerCase()
    if (['true', '1', 'yes'].includes(normalized)) return true
    if (['false', '0', 'no'].includes(normalized)) return false
  }

  return fallback
}

/**
 *
 * @param envRemote
 * @param packRemote
 * @returns
 */
export function resolveRagRemoteUrls(envRemote: string | undefined, packRemote: unknown): string[] {
  if (envRemote && envRemote.trim().length > 0) {
    return parseRemoteUrls(envRemote)
  }

  if (Array.isArray(packRemote)) {
    return packRemote.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
  }

  if (typeof packRemote === 'string' && packRemote.trim().length > 0) {
    return parseRemoteUrls(packRemote)
  }

  return []
}

/**
 * MCP server definition used at runtime.
 */
export interface McpToolAccess {
  /** 'admin' = all tools require admin by default; 'public' = all tools are public by default */
  default: 'admin' | 'public'
  /** Tools explicitly available to all users (only relevant when default is 'admin') */
  public?: string[]
  /** Tools restricted to admin users (only relevant when default is 'public') */
  adminOnly?: string[]
}

export interface McpUserConfigField {
  /** Internal field name (e.g. "token") */
  name: string
  /** Localized display label shown to the user */
  label: Record<string, string>
  /** Field type: 'secret' fields are never echoed or logged */
  type: 'text' | 'secret'
  /** Maps the field value into a request header. e.g. "Bearer {value}" → Authorization header */
  headerTemplate?: string
  /** HTTP header name to set. Defaults to 'Authorization' if omitted. */
  headerName?: string
}

export interface McpServerDef {
  name: string
  transport: 'stdio' | 'sse' | 'streamable-http'
  url?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  headers?: Record<string, string>
  reconnect?: boolean
  toolAccess?: McpToolAccess
  /** 'admin-controlled' = shared token from env; 'user-controlled' = each user provides their own token */
  accessMode?: 'admin-controlled' | 'user-controlled'
  /** Configuration fields to collect from the user (only when accessMode is 'user-controlled') */
  userConfig?: { fields: McpUserConfigField[] }
}

/**
 * Resolves MCP server configuration from env var (MCP_SERVERS_CONFIG) or agent-pack mcp.servers.
 * Env var takes precedence. Accepts a JSON array string.
 */
export function resolveMcpServers(envRaw: string | undefined, packServers: unknown): McpServerDef[] {
  const parse = (raw: string): McpServerDef[] => {
    try {
      const parsed = JSON.parse(raw)
      if (!Array.isArray(parsed)) return []
      return parsed as McpServerDef[]
    } catch {
      return []
    }
  }

  if (envRaw && envRaw.trim().length > 0) {
    return parse(envRaw)
  }

  if (Array.isArray(packServers)) {
    return packServers.map((s) => ({
      ...s,
      args: typeof s.args === 'string' ? JSON.parse(s.args) : s.args,
      reconnect: pickBoolean('', s.reconnect, false),
    })) as McpServerDef[]
  }

  return []
}

export function resolveToolsConfig({
  envLlmTools,
  packDynamicTools,
  packBundledTools,
}: {
  envLlmTools: unknown
  packDynamicTools: unknown
  packBundledTools?: Record<string, unknown>
}) {
  const normalizeDynamic = (raw: unknown): string => {
    if (typeof raw === 'string') {
      const trimmed = raw.trim()
      if (trimmed.length === 0 || /^\$\{.+\}$/.test(trimmed)) return '[]'
      return trimmed
    }
    if (raw && typeof raw === 'object') {
      try {
        return JSON.stringify(raw)
      } catch {
        return '[]'
      }
    }
    return '[]'
  }

  const bundled = packBundledTools ?? {}
  const statisticsBundled = (bundled['statisticsFetcher'] as Record<string, unknown>) ?? {}

  return {
    llmToolsConfig: normalizeDynamic(envLlmTools ?? packDynamicTools ?? '[]'),
    agentPackBundledTools: bundled,
    statisticsToolConfig: {
      enabled: pickBoolean('STATISTICS_TOOL_ENABLED', statisticsBundled['enabled'], true),
      endpoint: pickString('STATISTICS_API_URL', statisticsBundled['endpoint'], ''),
      requiresAuth: pickBoolean('STATISTICS_REQUIRE_AUTH', statisticsBundled['requiresAuth'], false),
      defaultStatClass:
        typeof statisticsBundled['defaultStatClass'] === 'string'
          ? (statisticsBundled['defaultStatClass'] as string)
          : 'USER_CONNECTED',
      defaultStatEnums: Array.isArray(statisticsBundled['defaultStatEnums'])
        ? (statisticsBundled['defaultStatEnums'] as Array<Record<string, unknown>>)
        : undefined,
    },
  }
}
