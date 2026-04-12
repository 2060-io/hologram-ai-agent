import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { ChatbotModule } from './chatbot/chatbot.module'
import { LlmModule } from './llm/llm.module'
import { RagModule } from './rag/rag.module'
import { IntegrationsModule } from './integrations/integrations.module'
import { EventsModule } from '@2060.io/vs-agent-nestjs-client'
import appConfig from './config/app.config'
import { CoreService } from './core/core.service'
import { CoreModule } from './core/core.module'
import { MemoryModule } from './memory/memory.module'
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
      modules: {
        messages: true,
        connections: true,
        stats: process.env.VS_AGENT_STATS_ENABLED === 'true',
      },
      options: {
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
        eventHandler: CoreService,
        url: process.env.VS_AGENT_ADMIN_URL,
        imports: [ChatbotModule, MemoryModule],
      },
    }),
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
