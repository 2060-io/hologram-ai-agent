import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { McpServerDef } from '../config/agent-pack.loader'

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

  constructor(private readonly config: ConfigService) {
    this.serverDefs = this.config.get<McpServerDef[]>('appConfig.mcpServers') ?? []
  }

  async onModuleInit() {
    if (this.serverDefs.length === 0) {
      this.logger.log('No MCP servers configured. Skipping MCP initialization.')
      return
    }

    this.logger.log(`Connecting to ${this.serverDefs.length} MCP server(s)...`)

    for (const def of this.serverDefs) {
      try {
        await this.connectServer(def)
      } catch (err) {
        this.logger.error(`Failed to connect to MCP server "${def.name}": ${err}`)
      }
    }

    this.logger.log(`MCP initialization complete. ${this.connections.length}/${this.serverDefs.length} server(s) connected.`)
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
  }

  /**
   * Returns all tools discovered from all connected MCP servers.
   */
  async listTools(): Promise<McpToolInfo[]> {
    const allTools: McpToolInfo[] = []

    for (const conn of this.connections) {
      try {
        let cursor: string | undefined
        do {
          const result = await conn.client.listTools({ cursor })
          for (const tool of result.tools) {
            allTools.push({
              serverName: conn.name,
              name: tool.name,
              description: tool.description ?? '',
              inputSchema: (tool.inputSchema as Record<string, unknown>) ?? {},
            })
          }
          cursor = result.nextCursor
        } while (cursor)
      } catch (err) {
        this.logger.error(`Error listing tools from MCP server "${conn.name}": ${err}`)
      }
    }

    return allTools
  }

  /**
   * Calls a tool on the appropriate MCP server.
   */
  async callTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<string> {
    const conn = this.connections.find((c) => c.name === serverName)
    if (!conn) {
      throw new Error(`MCP server "${serverName}" not connected.`)
    }

    const result = await conn.client.callTool({ name: toolName, arguments: args })

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
   * Returns whether any MCP servers are connected.
   */
  get isConnected(): boolean {
    return this.connections.length > 0
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
          env: def.env ? { ...process.env, ...def.env } as Record<string, string> : undefined,
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
          requestInit: def.headers
            ? { headers: def.headers }
            : undefined,
        })
        break
      }
      default:
        throw new Error(`Unsupported MCP transport "${def.transport}" for server "${def.name}".`)
    }

    await client.connect(transport)
    this.connections.push({ name: def.name, client, transport })
    this.logger.log(`Connected to MCP server "${def.name}" via ${def.transport}.`)
  }
}
