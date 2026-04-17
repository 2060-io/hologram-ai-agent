import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { AsyncLocalStorage } from 'async_hooks'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { McpServerDef, McpToolAccess } from '../config/agent-pack.loader'
import { McpConfigService } from './mcp-config.service'

interface McpConnection {
  name: string
  client: Client
  transport: StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport
}

export interface McpToolInfo {
  serverName: string
  name: string
  description: string
  inputSchema: Record<string, unknown>
  /** Whether this tool is accessible to non-admin users */
  isPublic: boolean
}

/**
 * McpService
 *
 * Manages MCP client connections to configured MCP servers.
 * On module init, connects to all servers defined in config (env or agent-pack).
 * Exposes discovered tools that can be converted to LangChain DynamicStructuredTools.
 */
@Injectable()
export class McpService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(McpService.name)
  private readonly connections: McpConnection[] = []
  private readonly serverDefs: McpServerDef[]

  /** AsyncLocalStorage carries the current caller's avatarName through tool invocations */
  private readonly callerCtx = new AsyncLocalStorage<{ avatarName?: string }>()

  /** Per-user MCP connections keyed by "avatarName:serverName" */
  private readonly userConnections = new Map<string, McpConnection>()

  /** Maps server name → accessMode */
  private readonly accessModeMap = new Map<string, string>()

  /** Cached tool definitions per server (populated at startup or lazily on first per-user connect) */
  private readonly serverToolCache = new Map<string, McpToolInfo[]>()

  /** Incremented when new tools are discovered — allows consumers to detect changes */
  private _toolsVersion = 0
  get toolsVersion(): number {
    return this._toolsVersion
  }

  constructor(
    private readonly config: ConfigService,
    private readonly mcpConfigService: McpConfigService,
  ) {
    this.serverDefs = this.config.get<McpServerDef[]>('appConfig.mcpServers') ?? []
  }

  async onModuleInit() {
    if (this.serverDefs.length === 0) {
      this.logger.log('No MCP servers configured. Skipping MCP initialization.')
      return
    }

    this.logger.log(`Connecting to ${this.serverDefs.length} MCP server(s)...`)

    for (const def of this.serverDefs) {
      // Always register metadata regardless of connection
      if (def.toolAccess) this.toolAccessMap.set(def.name, def.toolAccess)
      if (def.accessMode) this.accessModeMap.set(def.name, def.accessMode)

      // Skip shared connection for user-controlled servers without valid admin headers
      if (def.accessMode === 'user-controlled' && this.hasUnresolvedHeaders(def)) {
        this.logger.log(
          `Skipping shared connection for user-controlled server "${def.name}" (no admin token). Tools will be discovered on first user connection.`,
        )
        continue
      }

      try {
        await this.connectServer(def)
      } catch (err) {
        this.logger.error(`Failed to connect to MCP server "${def.name}": ${err}`)
      }
    }

    this.logger.log(
      `MCP initialization complete. ${this.connections.length}/${this.serverDefs.length} server(s) connected.`,
    )
  }

  async onModuleDestroy() {
    for (const conn of this.connections) {
      try {
        await conn.client.close()
        this.logger.debug(`Disconnected from MCP server "${conn.name}".`)
      } catch (err) {
        this.logger.warn(`Error disconnecting from MCP server "${conn.name}": ${err}`)
      }
    }
    this.connections.length = 0

    // Close per-user connections
    for (const [key, conn] of this.userConnections) {
      try {
        await conn.client.close()
      } catch (err) {
        this.logger.warn(`Error closing user connection "${key}": ${err}`)
      }
    }
    this.userConnections.clear()
  }

  /**
   * Runs a function with the caller's avatarName in async context.
   * MCP tool invocations within `fn` will use per-user credentials for user-controlled servers.
   */
  async runWithCaller<T>(avatarName: string | undefined, fn: () => Promise<T>): Promise<T> {
    return this.callerCtx.run({ avatarName }, fn)
  }

  /**
   * Returns tools discovered from all connected MCP servers,
   * filtered by the caller's admin status.
   *
   * @param isAdmin - If true, returns all tools; if false, returns only public tools.
   */
  async listTools(isAdmin = false): Promise<McpToolInfo[]> {
    const allTools: McpToolInfo[] = []
    const discoveredServers = new Set<string>()

    // Consider all shared server defs (admin-controlled, or user-controlled with a shared admin connection).
    // For each, try to use the live connection; if absent or errored, attempt a single reconnect.
    for (const def of this.serverDefs) {
      if (def.accessMode === 'user-controlled' && this.hasUnresolvedHeaders(def)) continue

      let conn = this.connections.find((c) => c.name === def.name)
      if (!conn) {
        const ok = await this.reconnectShared(def.name)
        if (!ok) continue
        conn = this.connections.find((c) => c.name === def.name)
        if (!conn) continue
      }

      discoveredServers.add(conn.name)
      const access = this.toolAccessMap.get(conn.name)

      const fetchOnce = async (c: McpConnection): Promise<McpToolInfo[] | 'retry'> => {
        const collected: McpToolInfo[] = []
        try {
          let cursor: string | undefined
          do {
            const result = await c.client.listTools({ cursor })
            for (const tool of result.tools) {
              collected.push({
                serverName: c.name,
                name: tool.name,
                description: tool.description ?? '',
                inputSchema: (tool.inputSchema as Record<string, unknown>) ?? {},
                isPublic: this.isToolPublic(tool.name, access),
              })
            }
            cursor = result.nextCursor
          } while (cursor)
          return collected
        } catch (err) {
          this.logger.warn(`Error listing tools from MCP server "${c.name}": ${err}. Attempting reconnect...`)
          return 'retry'
        }
      }

      let tools = await fetchOnce(conn)
      if (tools === 'retry') {
        const ok = await this.reconnectShared(conn.name)
        if (ok) {
          const newConn = this.connections.find((c) => c.name === def.name)
          if (newConn) tools = await fetchOnce(newConn)
        }
      }
      if (tools !== 'retry') {
        allTools.push(...tools)
      } else {
        this.logger.error(`Giving up on listTools for "${def.name}" after reconnect attempt.`)
      }
    }

    // Include lazily-discovered tools from servers without a shared connection
    for (const [serverName, tools] of this.serverToolCache) {
      if (!discoveredServers.has(serverName)) {
        allTools.push(...tools)
      }
    }

    if (isAdmin) return allTools
    return allTools.filter((t) => t.isPublic)
  }

  /**
   * Calls a tool on the appropriate MCP server.
   * Enforces access control: non-admin callers can only invoke public tools.
   *
   * @param isAdmin - Whether the caller has admin privileges.
   */
  async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
    isAdmin = false,
  ): Promise<string> {
    const accessMode = this.accessModeMap.get(serverName)
    let sharedConn = this.connections.find((c) => c.name === serverName) ?? null

    // For admin-controlled servers, a shared connection is required — attempt to (re)connect if missing
    if (!sharedConn && accessMode !== 'user-controlled') {
      const ok = await this.reconnectShared(serverName)
      if (!ok) throw new Error(`MCP server "${serverName}" not connected.`)
      sharedConn = this.connections.find((c) => c.name === serverName) ?? null
      if (!sharedConn) throw new Error(`MCP server "${serverName}" not connected.`)
    }

    // Execution guard: reject admin-only tools for non-admin callers
    if (!isAdmin) {
      const access = this.toolAccessMap.get(serverName)
      if (!this.isToolPublic(toolName, access)) {
        this.logger.warn(
          `[ACCESS] Non-admin caller attempted to call admin-only tool "${toolName}" on server "${serverName}".`,
        )
        return 'This tool requires administrator privileges. Please contact an admin.'
      }
    }

    // For user-controlled servers, resolve the per-user connection
    const conn = await this.resolveConnection(serverName, sharedConn)
    if (!conn) {
      return 'You need to configure your credentials for this service first. Use the "MCP Server Config" menu option.'
    }

    const invoke = async (c: McpConnection) => c.client.callTool({ name: toolName, arguments: args })

    // Only shared (admin-controlled) connections are auto-reconnected here.
    // Per-user connections are recreated lazily via resolveConnection on next call.
    const isShared = accessMode !== 'user-controlled'
    let result
    try {
      result = await invoke(conn)
    } catch (err) {
      if (!isShared) throw err
      this.logger.warn(`[MCP] callTool "${serverName}/${toolName}" failed: ${err}. Attempting reconnect and retry...`)
      const ok = await this.reconnectShared(serverName)
      if (!ok) throw err
      const retryConn = this.connections.find((c) => c.name === serverName)
      if (!retryConn) throw err
      result = await invoke(retryConn)
    }

    // Extract text content from the result
    if (result.content && Array.isArray(result.content)) {
      return result.content
        .filter((c: { type: string }) => c.type === 'text')
        .map((c: { type: string; text?: string }) => c.text ?? '')
        .join('\n')
    }

    if (result.structuredContent) {
      return JSON.stringify(result.structuredContent)
    }

    return JSON.stringify(result)
  }

  /**
   * Returns the server instructions (if any) from all connected servers.
   * Useful for injecting into the system prompt.
   */
  getServerInstructions(): string[] {
    return this.connections
      .map((conn) => {
        const instructions = conn.client.getInstructions()
        return instructions ? `[${conn.name}]: ${instructions}` : null
      })
      .filter((s): s is string => s !== null)
  }

  /**
   * Returns whether any MCP servers are connected or have lazily-discovered tools.
   */
  get isConnected(): boolean {
    return this.connections.length > 0 || this.serverToolCache.size > 0
  }

  /**
   * Returns whether any MCP server definitions exist (even if not yet connected).
   */
  get hasServerDefs(): boolean {
    return this.serverDefs.length > 0
  }

  /**
   * Returns the names of all configured MCP servers (from the agent pack / env),
   * regardless of whether they are currently connected. Useful for building tool
   * schemas that need to reference valid server names.
   */
  getServerNames(): string[] {
    return this.serverDefs.map((d) => d.name)
  }

  /** Per-server tool access configuration, keyed by server name */
  private readonly toolAccessMap = new Map<string, McpToolAccess | undefined>()

  /**
   * Determines if a specific tool is public (accessible to non-admin users).
   */
  private isToolPublic(toolName: string, access?: McpToolAccess): boolean {
    if (!access) return true // no access config → all public
    if (access.default === 'admin') {
      // Default admin: only explicitly listed public tools are accessible
      return (access.public ?? []).includes(toolName)
    }
    // Default public: all tools public unless explicitly listed as adminOnly
    return !(access.adminOnly ?? []).includes(toolName)
  }

  private async connectServer(def: McpServerDef): Promise<void> {
    const client = new Client({ name: `hologram-agent/${def.name}`, version: '1.0.0' })
    let transport: StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport

    switch (def.transport) {
      case 'stdio': {
        if (!def.command) {
          throw new Error(`MCP server "${def.name}" with stdio transport requires a "command" field.`)
        }
        const args = def.args ?? []
        transport = new StdioClientTransport({
          command: def.command,
          args,
          env: def.env ? ({ ...process.env, ...def.env } as Record<string, string>) : undefined,
        })
        break
      }
      case 'sse': {
        if (!def.url) {
          throw new Error(`MCP server "${def.name}" with sse transport requires a "url" field.`)
        }
        transport = new SSEClientTransport(new URL(def.url))
        break
      }
      case 'streamable-http': {
        if (!def.url) {
          throw new Error(`MCP server "${def.name}" with streamable-http transport requires a "url" field.`)
        }
        transport = new StreamableHTTPClientTransport(new URL(def.url), {
          requestInit: def.headers ? { headers: def.headers } : undefined,
        })
        break
      }
      default:
        throw new Error(`Unsupported MCP transport "${def.transport}" for server "${def.name}".`)
    }

    await client.connect(transport)
    this.connections.push({ name: def.name, client, transport })
    // Metadata may already have been registered in onModuleInit; set here as fallback for direct calls
    if (!this.toolAccessMap.has(def.name)) this.toolAccessMap.set(def.name, def.toolAccess)
    if (def.accessMode && !this.accessModeMap.has(def.name)) this.accessModeMap.set(def.name, def.accessMode)

    // Attach close/error handlers so we can detect when the remote MCP server
    // restarts or the transport dies, and drop the stale connection. The next
    // listTools/callTool will then trigger a reconnect attempt.
    transport.onclose = () => {
      const idx = this.connections.findIndex((c) => c.name === def.name && c.transport === transport)
      if (idx >= 0) {
        this.connections.splice(idx, 1)
        this.logger.warn(`[MCP] Transport closed for server "${def.name}". Will reconnect on next use.`)
      }
    }
    transport.onerror = (err: unknown) => {
      this.logger.warn(`[MCP] Transport error for server "${def.name}": ${err}`)
    }

    this.logger.log(
      `Connected to MCP server "${def.name}" via ${def.transport}. accessMode=${def.accessMode ?? 'admin-controlled'}, toolAccess: ${def.toolAccess ? `default=${def.toolAccess.default}` : 'none (all public)'}`,
    )
  }

  /**
   * Closes any stale shared connection for the given server and reconnects.
   * Bumps toolsVersion so LlmService refreshes its tool cache.
   * Returns true if reconnection succeeded.
   */
  private async reconnectShared(serverName: string): Promise<boolean> {
    const def = this.serverDefs.find((d) => d.name === serverName)
    if (!def) return false

    // Drop any existing connection for this server (may already be gone via onclose)
    const idx = this.connections.findIndex((c) => c.name === serverName)
    if (idx >= 0) {
      const stale = this.connections[idx]
      this.connections.splice(idx, 1)
      try {
        await stale.client.close()
      } catch {
        /* ignore */
      }
    }

    try {
      await this.connectServer(def)
      this._toolsVersion++
      this.logger.log(`[MCP] Reconnected to server "${serverName}" (toolsVersion=${this._toolsVersion}).`)
      return true
    } catch (err) {
      this.logger.error(`[MCP] Failed to reconnect server "${serverName}": ${err}`)
      return false
    }
  }

  /**
   * Checks whether a server definition has unresolved ${...} placeholders in its headers.
   */
  private hasUnresolvedHeaders(def: McpServerDef): boolean {
    if (!def.headers) return false
    return Object.values(def.headers).some((v) => /\$\{[^}]+\}/.test(v))
  }

  /**
   * Resolves the MCP connection to use for a tool call.
   * For user-controlled servers, returns a per-user connection with the user's decrypted headers.
   * Returns null if the server is user-controlled but the user hasn't configured credentials.
   */
  private async resolveConnection(serverName: string, sharedConn: McpConnection | null): Promise<McpConnection | null> {
    const accessMode = this.accessModeMap.get(serverName)
    if (accessMode !== 'user-controlled') {
      return sharedConn // admin-controlled: use shared connection
    }

    const ctx = this.callerCtx.getStore()
    const avatarName = ctx?.avatarName
    if (!avatarName) {
      this.logger.warn(`[ACCESS] User-controlled server "${serverName}" called without caller context.`)
      return null
    }

    // Check cache
    const cacheKey = `${avatarName}:${serverName}`
    const cached = this.userConnections.get(cacheKey)
    if (cached) return cached

    // Decrypt user config
    const userConfig = await this.mcpConfigService.getConfig(avatarName, serverName)
    if (!userConfig) {
      this.logger.debug(`[ACCESS] No config found for avatar="${avatarName}" server="${serverName}".`)
      return null
    }

    // Build per-user headers
    const serverDef = this.serverDefs.find((d) => d.name === serverName)
    if (!serverDef?.url || !serverDef.userConfig?.fields) return null

    const headers = this.buildUserHeaders(serverDef, userConfig)

    // Create per-user connection
    try {
      const client = new Client({ name: `hologram-agent/${serverName}/${avatarName}`, version: '1.0.0' })
      const transport = new StreamableHTTPClientTransport(new URL(serverDef.url), {
        requestInit: { headers },
      })
      await client.connect(transport)
      const conn: McpConnection = { name: serverName, client, transport }
      this.userConnections.set(cacheKey, conn)
      this.logger.log(`[MCP_USER] Created per-user connection for avatar="${avatarName}" server="${serverName}".`)

      // Lazy tool discovery: cache tool definitions on first per-user connection
      if (!this.serverToolCache.has(serverName)) {
        await this.discoverAndCacheTools(conn, serverName)
      }

      return conn
    } catch (err) {
      this.logger.error(
        `[MCP_USER] Failed to create per-user connection for avatar="${avatarName}" server="${serverName}": ${err}`,
      )
      return null
    }
  }

  /**
   * Discovers tools from a connection and caches them at the server level.
   * Increments toolsVersion so consumers (e.g. LlmService) know to rebuild agents.
   */
  private async discoverAndCacheTools(conn: McpConnection, serverName: string): Promise<void> {
    const access = this.toolAccessMap.get(serverName)
    const tools: McpToolInfo[] = []
    try {
      let cursor: string | undefined
      do {
        const result = await conn.client.listTools({ cursor })
        for (const tool of result.tools) {
          tools.push({
            serverName,
            name: tool.name,
            description: tool.description ?? '',
            inputSchema: (tool.inputSchema as Record<string, unknown>) ?? {},
            isPublic: this.isToolPublic(tool.name, access),
          })
        }
        cursor = result.nextCursor
      } while (cursor)
    } catch (err) {
      this.logger.error(`[MCP] Failed to discover tools for server "${serverName}": ${err}`)
      return
    }
    this.serverToolCache.set(serverName, tools)
    this._toolsVersion++
    this.logger.log(
      `[MCP] Lazily discovered ${tools.length} tool(s) for server "${serverName}" (toolsVersion=${this._toolsVersion})`,
    )
  }

  /**
   * Tests a per-user connection after config is saved.
   * Attempts to connect and list tools to validate the credentials.
   * On success, caches the connection and discovers tools.
   * On failure, cleans up and returns false.
   */
  async testUserConnection(avatarName: string, serverName: string): Promise<boolean> {
    // Clear any stale cached connection
    await this.invalidateUserConnection(avatarName, serverName)

    const userConfig = await this.mcpConfigService.getConfig(avatarName, serverName)
    if (!userConfig) return false

    const serverDef = this.serverDefs.find((d) => d.name === serverName)
    if (!serverDef?.url || !serverDef.userConfig?.fields) return false

    const headers = this.buildUserHeaders(serverDef, userConfig)

    let client: Client | undefined
    let transport: StreamableHTTPClientTransport | undefined
    try {
      client = new Client({ name: `hologram-agent/${serverName}/${avatarName}`, version: '1.0.0' })
      transport = new StreamableHTTPClientTransport(new URL(serverDef.url), {
        requestInit: { headers },
      })
      await client.connect(transport)

      // Validate: attempt to list tools (will fail with bad credentials)
      await client.listTools()

      // Success → cache the connection
      const cacheKey = `${avatarName}:${serverName}`
      const conn: McpConnection = { name: serverName, client, transport }
      this.userConnections.set(cacheKey, conn)
      this.logger.log(`[MCP_USER] Connection test passed for avatar="${avatarName}" server="${serverName}"`)

      // Lazy tool discovery
      if (!this.serverToolCache.has(serverName)) {
        await this.discoverAndCacheTools(conn, serverName)
      }

      return true
    } catch (err) {
      this.logger.warn(`[MCP_USER] Connection test failed for avatar="${avatarName}" server="${serverName}": ${err}`)
      if (client) {
        try {
          await client.close()
        } catch {
          /* ignore */
        }
      }
      return false
    }
  }

  /**
   * Builds per-user headers by merging base headers (stripping unresolved placeholders)
   * with user-provided values via headerTemplate.
   */
  private buildUserHeaders(serverDef: McpServerDef, userConfig: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {}

    // Copy base headers, skipping any with unresolved ${...} placeholders
    if (serverDef.headers) {
      for (const [k, v] of Object.entries(serverDef.headers)) {
        if (!/\$\{[^}]+\}/.test(v)) {
          headers[k] = v
        }
      }
    }

    // Apply user-provided values via headerTemplate
    for (const field of serverDef.userConfig?.fields ?? []) {
      if (field.headerTemplate && userConfig[field.name]) {
        const headerName = field.headerName ?? 'Authorization'
        headers[headerName] = field.headerTemplate.replace('{value}', userConfig[field.name])
      }
    }

    return headers
  }

  /**
   * Proactively establishes per-user connections for all user-controlled servers
   * where the user has saved config. This ensures lazy tool discovery happens
   * before the LLM agent runs, breaking the chicken-and-egg problem where tools
   * can't be called because they haven't been discovered yet.
   */
  async ensureUserConnections(avatarName: string): Promise<void> {
    for (const def of this.serverDefs) {
      if (def.accessMode !== 'user-controlled') continue

      const cacheKey = `${avatarName}:${def.name}`
      if (this.userConnections.has(cacheKey)) continue

      const userConfig = await this.mcpConfigService.getConfig(avatarName, def.name)
      if (!userConfig) continue

      if (!def.url || !def.userConfig?.fields) continue

      const headers = this.buildUserHeaders(def, userConfig)
      try {
        const client = new Client({ name: `hologram-agent/${def.name}/${avatarName}`, version: '1.0.0' })
        const transport = new StreamableHTTPClientTransport(new URL(def.url), {
          requestInit: { headers },
        })
        await client.connect(transport)
        const conn: McpConnection = { name: def.name, client, transport }
        this.userConnections.set(cacheKey, conn)
        this.logger.log(`[MCP_USER] Proactively connected avatar="${avatarName}" server="${def.name}".`)

        if (!this.serverToolCache.has(def.name)) {
          await this.discoverAndCacheTools(conn, def.name)
        }
      } catch (err) {
        this.logger.warn(
          `[MCP_USER] Proactive connection failed for avatar="${avatarName}" server="${def.name}": ${err}`,
        )
      }
    }
  }

  /**
   * Invalidates cached per-user connections for a specific avatar + server.
   * Call this when the user updates their credentials.
   */
  async invalidateUserConnection(avatarName: string, serverName: string): Promise<void> {
    const key = `${avatarName}:${serverName}`
    const conn = this.userConnections.get(key)
    if (conn) {
      try {
        await conn.client.close()
      } catch {
        /* ignore */
      }
      this.userConnections.delete(key)
      this.logger.debug(`[MCP_USER] Invalidated connection for avatar="${avatarName}" server="${serverName}".`)
    }
  }
}
