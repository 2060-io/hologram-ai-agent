import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { LlmModule } from './llm/llm.module'
import { RagModule } from './rag/rag.module'
import { IntegrationsModule } from './integrations/integrations.module'
import { EventsModule } from '@verana-labs/vs-agent-nestjs-client'
import appConfig from './config/app.config'
import { VsAgentEventHandler } from './core/vs-agent-event.handler'
import { CoreModule } from './core/core.module'
import { McpModule } from './mcp/mcp.module'
import { RbacModule } from './rbac/rbac.module'

@Module({
  imports: [
    ConfigModule.forRoot({
      envFilePath: '.env',
      load: [appConfig],
      isGlobal: true,
    }),
    CoreModule,
    McpModule,
    RbacModule,
    LlmModule,
    RagModule,
    IntegrationsModule,
    EventsModule.register({
      url: process.env.VS_AGENT_ADMIN_URL || 'http://localhost:3001',
      // When set, the events webhook (POST /events) requires `Authorization: Bearer <key>`,
      // matching EVENTS_WEBHOOK_API_KEY of the VS Agent.
      webhookApiKey: process.env.EVENTS_WEBHOOK_API_KEY || undefined,
      eventHandler: VsAgentEventHandler,
      modules: {
        connections: true,
        stats: process.env.VS_AGENT_STATS_ENABLED === 'true',
      },
      statOptions: {
        host: process.env.VS_AGENT_STATS_HOST,
        port: Number(process.env.VS_AGENT_STATS_PORT),
        queue: process.env.VS_AGENT_STATS_QUEUE,
        username: process.env.VS_AGENT_STATS_USER,
        password: process.env.VS_AGENT_STATS_PASSWORD,
        reconnectLimit: 10,
        threads: 2,
        delay: 1000,
      },
    }),
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
