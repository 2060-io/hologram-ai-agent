import { Injectable, Logger, OnModuleInit } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { z as zod } from 'zod'
import { ChatOpenAI } from '@langchain/openai'
import { ChatAnthropic } from '@langchain/anthropic'
import { ChatOllama } from '@langchain/ollama'
import { DynamicStructuredTool } from '@langchain/core/tools'
import { createToolCallingAgent } from 'langchain/agents'
import { ChatPromptTemplate, MessagesPlaceholder } from '@langchain/core/prompts'
import { AIMessage, BaseMessage } from '@langchain/core/messages'
import type { Runnable } from '@langchain/core/runnables'
import type { AgentExecutor } from 'langchain/agents'

import { ExternalToolDef, SupportedProviders } from './interfaces/llm-provider.interface'
import { SessionEntity } from 'src/core/models'
import { statisticsFetcherTool, authCheckerTool, createRagRetrieverTool } from './tools/'
import { MemoryService } from 'src/memory/memory.service'
import { LangchainSessionMemory } from 'src/memory/langchain-session-memory'
import { RagService } from '../rag/rag.service'
import { McpService } from '../mcp/mcp.service'
import { ToolCallInterceptorService } from '../rbac/tool-call-interceptor.service'
import { RbacService, UserContext } from '../rbac/rbac.service'

/**
 * LlmService
 *
 * Service responsible for managing the connection with different LLM providers (OpenAI, Anthropic, Ollama).
 * Supports dynamic tool integration, prompt management, and error/logging handling.
 * This service is agnostic to the frontend and can be used from different orchestrators (chatbot, API, etc).
 */
@Injectable()
export class LlmService implements OnModuleInit {
  /** Logger for LlmService operations */
  private readonly logger = new Logger(LlmService.name)
  /** The current LLM instance (OpenAI, Anthropic, or Ollama) */
  private llm: ChatOpenAI | ChatAnthropic | ChatOllama
  /** Tool-calling agent for non-admin users (public tools only) */
  private publicAgent: Runnable | null = null
  /** Tool-calling agent for admin users (all tools) */
  private adminAgent: Runnable | null = null
  /** Tools available for non-admin users */
  private publicTools: DynamicStructuredTool[] = []
  /** Tools available for admin users (superset of publicTools) */
  private adminTools: DynamicStructuredTool[] = []
  /** Base (non-MCP) tools — kept separate so MCP tools can be rebuilt independently */
  private baseTools: DynamicStructuredTool[] = []
  /** Last known McpService.toolsVersion — used to detect lazy tool discoveries */
  private lastToolsVersion = -1
  /** Raw MCP tool metadata — retained for per-user RBAC filtering */
  private allMcpToolInfos: {
    serverName: string
    name: string
    description?: string
    inputSchema: Record<string, unknown>
    isPublic: boolean
  }[] = []
  /** Wrapped MCP tools indexed by "serverName/toolName" for efficient per-role reuse */
  private mcpToolMap = new Map<string, DynamicStructuredTool>()
  /** Cached RBAC-filtered agents keyed by sorted role-set string */
  private rbacAgentCache = new Map<string, { agent: Runnable | null; tools: DynamicStructuredTool[] }>()
  /** The agent's system prompt (loaded from environment) */
  private readonly agentPrompt: string
  /** LLM provider name */
  private readonly provider: SupportedProviders

  /**
   * Initializes the LlmService, selects the LLM provider, builds tools if defined,
   * and configures the tool-calling agent if supported.
   *
   * @param config - The NestJS ConfigService instance.
   * @param memoryService - Backend-agnostic chat memory service (in-memory / Redis).
   * @param mcpService - MCP client service for connecting to external MCP servers.
   */
  constructor(
    private readonly config: ConfigService,
    private readonly memoryService: MemoryService,
    private readonly ragService: RagService,
    private readonly mcpService: McpService,
    private readonly toolCallInterceptor: ToolCallInterceptorService,
    private readonly rbacService: RbacService,
  ) {
    this.agentPrompt = this.config.get<string>('appConfig.agentPrompt') ?? 'You are a helpful AI agent called Hologram.'

    this.provider = (this.config.get<string>('LLM_PROVIDER') ?? 'openai') as SupportedProviders
    this.llm = this.instantiateLlm(this.provider)
    const baseTools: DynamicStructuredTool[] = this.buildTools()
    this.baseTools = baseTools
    this.publicTools = [...baseTools]
    this.adminTools = [...baseTools]
    this.logger.debug(`*** BASE TOOLS (sync): ${JSON.stringify(baseTools.map((t) => t.name))}`)

    if (baseTools.length && (this.provider === 'openai' || this.provider === 'anthropic')) {
      this.setupToolAgent(baseTools)
        .then(({ publicAgent, adminAgent }) => {
          this.publicAgent = publicAgent
          this.adminAgent = adminAgent
          this.logger.log(`Tool-enabled agents initialised with ${baseTools.length} base tools.`)
        })
        .catch((err) => this.logger.error(`Failed to build Tool agent: ${err}`))
    } else if (this.provider === 'ollama') {
      this.logger.warn('Ollama does not support tools. Only plain prompts will be used.')
    } else {
      this.logger.log('Initializing without tools.')
    }
  }

  /**
   * After all modules are initialized, discover MCP tools asynchronously
   * and rebuild the agent if new tools are found.
   */
  async onModuleInit() {
    // Attempt initial MCP tool discovery (may be empty if all servers are lazy)
    await this.refreshMcpTools()
  }

  /**
   * Rebuilds MCP tools and agents if McpService.toolsVersion has changed.
   * Safe to call repeatedly — no-ops when tools haven't changed.
   */
  private async refreshMcpTools(): Promise<void> {
    const currentVersion = this.mcpService.toolsVersion
    if (currentVersion === this.lastToolsVersion) return

    try {
      const { publicMcpTools, allMcpTools } = await this.buildMcpTools()
      this.lastToolsVersion = currentVersion

      // Rebuild tool arrays: base tools + MCP tools
      this.publicTools = [...this.baseTools, ...publicMcpTools]
      this.adminTools = [...this.baseTools, ...allMcpTools]

      if (allMcpTools.length > 0) {
        const pubNames = publicMcpTools.map((t) => t.name)
        const adminOnlyNames = allMcpTools.filter((t) => !pubNames.includes(t.name)).map((t) => t.name)
        this.logger.log(
          `MCP tools refreshed: ${allMcpTools.length} total (${pubNames.length} public, ${adminOnlyNames.length} admin-only). toolsVersion=${currentVersion}`,
        )
      }

      // Clear RBAC agent cache since tools have changed
      this.rbacAgentCache.clear()

      // Rebuild agents with updated tool sets
      if ((this.provider === 'openai' || this.provider === 'anthropic') && (this.publicTools.length > 0 || this.adminTools.length > 0)) {
        const { publicAgent, adminAgent } = await this.setupToolAgent(this.publicTools, this.adminTools)
        this.publicAgent = publicAgent
        this.adminAgent = adminAgent
        this.logger.log(
          `Tool agents rebuilt: public=${this.publicTools.length} tools, admin=${this.adminTools.length} tools.`,
        )
      }
    } catch (err) {
      this.logger.error(`Failed to refresh MCP tools: ${err}`)
    }
  }

  /**
   * Generates a response from the LLM agent, using tool-enabled agents with LangChain Memory
   * when available, otherwise falls back to a plain system+user prompt.
   *
   * @param userMessage - The raw user input/message for the agent.
   * @param options - Optional parameters, including session information.
   * @returns The generated response from the agent as a string.
   */
  async generate(
    userMessage: string,
    options?: {
      session?: SessionEntity
      isAdmin?: boolean
    },
  ): Promise<string> {
    const session = options?.session
    const isAdmin = options?.isAdmin ?? false
    this.logger.debug(`[generate] Initialize: ${JSON.stringify(session)}, isAdmin=${isAdmin}`)

    this.logger.log(`Generating response for user message: ${userMessage}`)
    try {
      const today = new Date().toISOString().split('T')[0]

      // Proactively connect user-controlled MCP servers so tools are discovered
      // before the agent runs (breaks chicken-and-egg after pod restart)
      if (session?.userName) {
        await this.mcpService.ensureUserConnections(session.userName)
      }

      // Check if MCP tools have been lazily discovered since last call
      await this.refreshMcpTools()

      // Select agent and tools based on admin status and RBAC roles
      let agent: Runnable | null
      let tools: DynamicStructuredTool[]

      if (isAdmin) {
        agent = this.adminAgent
        tools = this.adminTools
      } else if (this.rbacService.isRbacActive() && session?.userRoles?.length) {
        const rbac = await this.getOrCreateRbacAgent(session.userRoles)
        agent = rbac.agent
        tools = rbac.tools
      } else {
        agent = this.publicAgent
        tools = this.publicTools
      }

      if (agent && tools.length && session?.connectionId) {
        this.logger.debug('Using tool-enabled agent with LangChain Memory.')

        const { AgentExecutor } = await import('langchain/agents')

        const memory = new LangchainSessionMemory(this.memoryService, session.connectionId)

        const agentExecutor = new AgentExecutor({
          agent,
          tools,
          memory,
          verbose: this.config.get<boolean>('appConfig.agentVerbose') ?? false,
        }) as any as AgentExecutor

        // Build RBAC user context for ToolCallInterceptor
        const userContext: UserContext = {
          identity: session.userIdentity ?? session.userName ?? '',
          connectionId: session.connectionId,
          roles: session.userRoles ?? [],
          isAuthenticated: session.isAuthenticated ?? false,
        }

        // Wrap in both RBAC context and MCP caller context
        const result = await this.toolCallInterceptor.runWithContext(userContext, () =>
          this.mcpService.runWithCaller(session.userName ?? undefined, () =>
            agentExecutor.invoke(
              {
                input: userMessage,
                today,
              },
              {
                configurable: {
                  isAuthenticated: session?.isAuthenticated ?? false,
                },
              },
            ),
          ),
        )

        this.logger.debug(`Agent executor result: ${JSON.stringify(result)}`)

        const output = (result as any)?.output ?? result

        if (typeof output === 'string') {
          this.logger.log('Agent executor returned output string.')
          return this.sanitizeResponse(output)
        }

        this.logger.warn('Agent executor returned a non-string result. Returning JSON stringified result.')
        return this.sanitizeResponse(JSON.stringify(output))
      }

      /**
       * Fallback: build prompt using only system and user messages (no tools, no LangChain memory).
       */
      this.logger.debug('No agent present. Using plain prompt with system and user messages.')
      const prompt = ChatPromptTemplate.fromMessages([
        ['system', this.agentPrompt],
        ['user', '{input}'],
      ])
      const messages = await prompt.formatMessages({ input: userMessage })

      const response = (await this.llm.invoke(messages)) as string | AIMessage | BaseMessage

      this.logger.debug(`Raw LLM response: ${JSON.stringify(response)}`)

      if (typeof response === 'string') {
        this.logger.log('LLM returned a string response.')
        return this.sanitizeResponse(response)
      }
      if (response && typeof (response as any).content === 'string') {
        this.logger.log('LLM returned a message object with content string.')
        return this.sanitizeResponse((response as any).content)
      }

      this.logger.warn('LLM returned an unexpected response type. Returning JSON stringified response.')
      return this.sanitizeResponse(JSON.stringify(response))
    } catch (error) {
      this.logger.error(
        `Error during agent response generation: ${error instanceof Error ? error.message : String(error)}`,
      )
      throw new Error('Failed to generate agent response. Please check logs for details.')
    }
  }

  /**
   * Instantiates the correct LLM provider (OpenAI, Anthropic, or Ollama) based on configuration.
   *
   * @param provider - The provider to instantiate.
   * @returns An LLM instance.
   */
  private instantiateLlm(provider: SupportedProviders) {
    switch (provider) {
      case 'anthropic':
        return new ChatAnthropic({
          apiKey: this.getOrThrow('ANTHROPIC_API_KEY'),
          modelName: this.config.get<string>('appConfig.anthropicModel') ?? 'claude-3',
        })
      case 'ollama':
        return new ChatOllama({
          baseUrl: this.config.get<string>('appConfig.ollamaBaseUrl') ?? 'http://ollama:11434',
          model: this.config.get<string>('appConfig.ollamaModel') ?? 'llama3',
        })
      case 'openai':
      default: {
        const maxTokens = this.config.get<number>('appConfig.openaiMaxTokens')
        const baseUrl = this.config.get<string>('appConfig.openaiBaseUrl')
        return new ChatOpenAI({
          openAIApiKey: this.getOrThrow('OPENAI_API_KEY'),
          model: this.config.get<string>('appConfig.openaiModel') ?? 'gpt-4o',
          temperature: this.config.get<number>('appConfig.openaiTemperature'),
          maxTokens: -1,
          modelKwargs: maxTokens ? { max_completion_tokens: maxTokens } : undefined,
          ...(baseUrl ? { configuration: { baseURL: baseUrl } } : {}),
        })
      }
    }
  }

  /**
   * Builds the array of DynamicStructuredTool instances based on the LLM_TOOLS_CONFIG environment variable.
   * Each tool is validated, logged, and initialized with its own async function and error handling.
   * If a tool requires authentication (via the `requiresAuth` property), the tool will check
   * the current user's session and return an authentication message if not authenticated.
   *
   * @returns {DynamicStructuredTool[]} An array of DynamicStructuredTool instances, or an empty array if none are configured.
   */
  private static readonly toolCtor = DynamicStructuredTool as unknown as new (fields: any) => DynamicStructuredTool

  private buildTools(): DynamicStructuredTool[] {
    const raw = this.config.get<string>('appConfig.llmToolsConfig')
    const dynamicTools: DynamicStructuredTool[] = []

    if (raw) {
      let defs: ExternalToolDef[]
      try {
        defs = JSON.parse(raw)
      } catch (e) {
        this.logger.error(`Invalid LLM_TOOLS_CONFIG JSON: ${e}`)
        defs = []
      }

      const querySchema: zod.ZodTypeAny = zod.object({
        query: zod.string().describe('Free-form query string passed to the external service.'),
        isAuthenticated: zod.boolean().describe('Authentication flag to restrict access.'),
      }) as zod.ZodTypeAny

      dynamicTools.push(
        ...defs.map(
          (def) =>
            new LlmService.toolCtor({
              name: def.name,
              description: def.description,
              schema: querySchema,
              func: async ({ query }, _runManager, config) => {
                const isAuthenticated: boolean = config?.configurable?.isAuthenticated ?? false
                this.logger.debug(`[Tool] config: ${JSON.stringify(config)}`)
                this.logger.debug(`[Tool] isAuthenticated: ${isAuthenticated}`)

                this.logger.debug(
                  `[DEBUG] isAuthenticated: ${JSON.stringify(isAuthenticated)} && requiresAuth ${JSON.stringify(def.requiresAuth)}`,
                )

                if (def.requiresAuth && !isAuthenticated) {
                  this.logger.debug(`[Tool:${def.name}] Attempted access without authentication.`)
                  return 'Authentication is required to access this feature. Please authenticate and try again.'
                }

                this.logger.log(`[Tool:${def.name}] Called with query: "${query}"`)
                const url = def.endpoint.replace('{query}', encodeURIComponent(query))
                this.logger.log(`[Tool:${def.name}] Requesting URL: ${url}`)
                const res = await fetch(url, {
                  method: def.method ?? 'GET',
                  headers: def.authHeader ? { [def.authHeader]: def.authToken ?? '' } : undefined,
                })
                this.logger.log(`[Tool:${def.name}] HTTP status: ${res.status}`)
                if (!res.ok) {
                  this.logger.error(`[Tool:${def.name}] Returned error: ${res.status}`)
                  throw new Error(`External tool "${def.name}" returned ${res.status}`)
                }
                const text = await res.text()
                this.logger.log(`[Tool:${def.name}] Response body: ${text.slice(0, 300)}`)
                return text
              },
              returnDirect: false,
            }),
        ),
      )
    } else {
      this.logger.log('No LLM_TOOLS_CONFIG found – skipping dynamic tool loading.')
    }

    // RAG tool
    const ragTool = createRagRetrieverTool(this.ragService)

    // Static tools
    const staticTools = [statisticsFetcherTool, authCheckerTool, ragTool]

    // Combine dynamic, static and auth tool
    return [...dynamicTools, ...staticTools]
  }

  /**
   * Discovers tools from connected MCP servers and wraps each as a LangChain DynamicStructuredTool.
   * Returns both the full set (for admin) and the public-only set (for non-admin).
   */
  private async buildMcpTools(): Promise<{
    publicMcpTools: DynamicStructuredTool[]
    allMcpTools: DynamicStructuredTool[]
  }> {
    const allInfos = await this.mcpService.listTools(true) // get ALL tools with isPublic metadata
    if (allInfos.length === 0) return { publicMcpTools: [], allMcpTools: [] }

    const wrapTool = (info: (typeof allInfos)[0]) => {
      const zodSchema = this.jsonSchemaToZod(info.inputSchema)

      return new LlmService.toolCtor({
        name: `mcp_${info.serverName}_${info.name}`.replace(/[^a-zA-Z0-9_-]/g, '_'),
        description: info.description || `MCP tool "${info.name}" from server "${info.serverName}"`,
        schema: zodSchema,
        func: async (args: Record<string, unknown>) => {
          this.logger.log(`[MCP Tool:${info.serverName}/${info.name}] Called with args: ${JSON.stringify(args)}`)
          try {
            // Route through ToolCallInterceptor for RBAC checks
            const ctx = this.toolCallInterceptor.getCurrentContext()
            if (ctx && this.rbacService.isRbacActive()) {
              const interceptResult = await this.toolCallInterceptor.execute(
                info.serverName,
                info.name,
                args,
                ctx,
                info.description,
              )
              switch (interceptResult.type) {
                case 'result':
                  this.logger.log(
                    `[MCP Tool:${info.serverName}/${info.name}] Result: ${interceptResult.data.slice(0, 300)}`,
                  )
                  return interceptResult.data
                case 'denied':
                  this.logger.warn(`[MCP Tool:${info.serverName}/${info.name}] DENIED: ${interceptResult.message}`)
                  return interceptResult.message
                case 'pending_approval':
                  this.logger.log(
                    `[MCP Tool:${info.serverName}/${info.name}] PENDING APPROVAL: ${interceptResult.requestId}`,
                  )
                  return interceptResult.message
              }
            }
            // Fallback: no RBAC context or RBAC not active → direct call
            const result = await this.mcpService.callTool(info.serverName, info.name, args, true)
            this.logger.log(`[MCP Tool:${info.serverName}/${info.name}] Result: ${result.slice(0, 300)}`)
            return result
          } catch (err) {
            this.logger.error(`[MCP Tool:${info.serverName}/${info.name}] Error: ${err}`)
            return `Error calling MCP tool "${info.name}": ${err}`
          }
        },
        returnDirect: false,
      })
    }

    // Store metadata and build reusable tool map for per-role filtering
    this.allMcpToolInfos = allInfos
    this.mcpToolMap.clear()
    for (const info of allInfos) {
      this.mcpToolMap.set(`${info.serverName}/${info.name}`, wrapTool(info))
    }

    const allMcpTools = allInfos.map((i) => this.mcpToolMap.get(`${i.serverName}/${i.name}`)!)
    const publicMcpTools = allInfos
      .filter((i) => i.isPublic)
      .map((i) => this.mcpToolMap.get(`${i.serverName}/${i.name}`)!)

    return { publicMcpTools, allMcpTools }
  }

  /**
   * Converts a JSON Schema "properties" object into a Zod object schema.
   * Handles string, number, integer, boolean, and array types.
   * Falls back to a single { input: z.string() } if the schema is empty or unparseable.
   */
  private jsonSchemaToZod(schema: Record<string, unknown>): zod.ZodTypeAny {
    const properties = (schema.properties ?? {}) as Record<
      string,
      { type?: string; description?: string; items?: { type?: string } }
    >
    const required = (schema.required ?? []) as string[]

    if (Object.keys(properties).length === 0) {
      return zod.object({ input: zod.string().optional().describe('Input for the tool') })
    }

    const shape: Record<string, zod.ZodTypeAny> = {}
    for (const [key, prop] of Object.entries(properties)) {
      let field: zod.ZodTypeAny
      switch (prop.type) {
        case 'number':
        case 'integer':
          field = zod.number()
          break
        case 'boolean':
          field = zod.boolean()
          break
        case 'array':
          field = zod.array(prop.items?.type === 'number' ? zod.number() : zod.string())
          break
        case 'string':
        default:
          field = zod.string()
          break
      }
      if (prop.description) field = field.describe(prop.description)
      if (!required.includes(key)) field = field.optional()
      shape[key] = field
    }

    return zod.object(shape) as zod.ZodTypeAny
  }

  /**
   * Get or create a cached RBAC-filtered agent for the given role set.
   * Filters MCP tools to only those the user's roles can access (ALLOW or APPROVAL).
   * Admin users should NOT go through this path (handled separately in generate()).
   */
  private async getOrCreateRbacAgent(
    userRoles: string[],
  ): Promise<{ agent: Runnable | null; tools: DynamicStructuredTool[] }> {
    const cacheKey = [...userRoles].sort().join(',') || '__no_roles__'

    const cached = this.rbacAgentCache.get(cacheKey)
    if (cached) return cached

    // Filter MCP tools: keep ALLOW and APPROVAL, exclude DENY
    // Pass empty identity to skip admin bypass (admins don't use this path)
    const filteredMcpTools: DynamicStructuredTool[] = []
    for (const info of this.allMcpToolInfos) {
      const decision = this.rbacService.checkAccess(userRoles, '', info.serverName, info.name)
      if (decision !== 'DENY') {
        const tool = this.mcpToolMap.get(`${info.serverName}/${info.name}`)
        if (tool) filteredMcpTools.push(tool)
      }
    }

    const tools = [...this.baseTools, ...filteredMcpTools]
    this.logger.log(
      `[RBAC] Building agent for roles [${cacheKey}]: ${filteredMcpTools.length} MCP tools accessible (${this.allMcpToolInfos.length} total), ${tools.length} tools overall`,
    )

    if (tools.length === 0 || (this.provider !== 'openai' && this.provider !== 'anthropic')) {
      const entry = { agent: null, tools }
      this.rbacAgentCache.set(cacheKey, entry)
      return entry
    }

    const { publicAgent } = await this.setupToolAgent(tools)
    const entry = { agent: publicAgent as Runnable | null, tools }
    this.rbacAgentCache.set(cacheKey, entry)
    return entry
  }

  /**
   * Sets up the tool-enabled agent using LangChain's agent API.
   * This enables dynamic tool-calling with prompt injection and logging.
   *
   * @param tools - Array of DynamicStructuredTool instances.
   */
  private async setupToolAgent(
    publicTools: DynamicStructuredTool[],
    adminToolsOverride?: DynamicStructuredTool[],
  ): Promise<{ publicAgent: Runnable; adminAgent: Runnable }> {
    const rbacPromptAddition = this.rbacService.isRbacActive()
      ? `\n\nIMPORTANT — Tool access is role-based. The tools you see are already filtered for the current user's role and permissions. When the user asks what tools, capabilities, or actions are available to them, or what they can do on a particular MCP server, list every tool you have access to, grouped by MCP server (the server name appears after "mcp_" in the tool name, before the next "_"). For each tool, state its original name and what it does. Some tool calls may require managerial approval before execution — if the system responds that approval is pending, inform the user that their request has been submitted for approval and they will be notified of the outcome.`
      : ''
    const systemPrompt = `Today's date is: {today}.\n${this.agentPrompt}${rbacPromptAddition}`

    this.logger.debug(`***Agent prompt: ${systemPrompt}***`)

    const prompt = ChatPromptTemplate.fromMessages([
      ['system', systemPrompt],
      new MessagesPlaceholder('chat_history'),
      ['user', '{input}'],
      new MessagesPlaceholder('agent_scratchpad'),
    ])

    const publicAgent = createToolCallingAgent({
      llm: this.llm as ChatOpenAI | ChatAnthropic,
      tools: publicTools,
      prompt,
    })

    const adminTools = adminToolsOverride ?? publicTools
    const adminAgent =
      adminTools === publicTools
        ? publicAgent
        : createToolCallingAgent({
            llm: this.llm as ChatOpenAI | ChatAnthropic,
            tools: adminTools,
            prompt,
          })

    return { publicAgent, adminAgent }
  }

  /**
   * Utility: Retrieves the required environment variable from ConfigService or process.env.
   * Throws an error if the variable is missing.
   *
   * @param envVar - The name of the environment variable.
   * @returns The string value of the variable.
   */
  private getOrThrow(envVar: string): string {
    const value = this.config.get<string>(envVar) ?? process.env[envVar]
    if (!value) throw new Error(`Environment variable ${envVar} is required.`)
    return value
  }

  /**
   * Removes common meta prefixes (e.g., "Response:", "System:") from model outputs
   * so end-users only see the actual reply text.
   */
  private sanitizeResponse(text: string): string {
    const normalized = text.replace(/[\r\n]+/g, '\n').trim()

    const lines = normalized
      .split('\n')
      .map((line) => line.trim())
      // Drop meta/thought lines the model may emit.
      .filter((line) => !/^(response|assistant|system|analysis|thought|user)\s*:/i.test(line))

    const cleaned = lines.join('\n')
    const stripPrefixes = cleaned.replace(/^(response|assistant|system|analysis|thought)\s*:\s*/i, '')
    const stripInline = stripPrefixes.replace(/\n(response|assistant|system|analysis|thought)\s*:\s*/gi, '\n')

    return stripInline.trim()
  }

  async detectLanguage(this: LlmService, text: string): Promise<string> {
    this.logger.debug(`[LLM LANG DETECT] Analyzing: "${text}"`)
    const prompt = `Detect the language of the following text. Only reply with the ISO 639-1 code (like "en", "es", "fr"). Text: ${text}`
    try {
      const response = (await this.llm.invoke([{ role: 'user', content: prompt }])) as string | AIMessage | BaseMessage

      let langCode: string | undefined
      if (typeof response === 'string') langCode = response.trim().toLowerCase()
      else if (response && typeof (response as any).content === 'string')
        langCode = (response as any).content.trim().toLowerCase()

      this.logger.debug(`[LLM LANG DETECT] Model replied: "${langCode}"`)
      // Extra check: Only accept if matches a real ISO code
      if (langCode && /^[a-z]{2}$/.test(langCode)) return langCode
      return 'en'
    } catch (err) {
      this.logger.error(`[LLM LANG DETECT] Error: ${err}`)
      return 'en'
    }
  }
}
