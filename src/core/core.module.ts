import { Global, Module } from '@nestjs/common'
import { SessionEntity } from './models'
import { CoreService } from './core.service'
import { TypeOrmModule, TypeOrmModuleOptions } from '@nestjs/typeorm'
import { ConnectionEntity, EventsModule } from '@2060.io/vs-agent-nestjs-client'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { ChatbotModule } from '../chatbot/chatbot.module'
import { MemoryModule } from '../memory/memory.module'
import { SttModule } from '../stt/stt.module'
import { AgentContentService } from './agent-content.service'
import { McpConfigEntity } from '../mcp/mcp-config.entity'
import { ApprovalRequestEntity } from '../rbac/approval-request.entity'

@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([ConnectionEntity, SessionEntity]),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService): TypeOrmModuleOptions => ({
        type: 'postgres',
        host: configService.get<string>('appConfig.postgresHost'),
        port: 5432,
        username: configService.get<string>('appConfig.postgresUser'),
        password: configService.get<string>('appConfig.postgresPassword'),
        database: configService.get<string>('appConfig.postgresDbName'),
        entities: [ConnectionEntity, SessionEntity, McpConfigEntity, ApprovalRequestEntity],
        synchronize: true,
        ssl: false,
        logging: false,
        retryAttempts: 10,
        retryDelay: 2000,
      }),
      inject: [ConfigService],
    }),
    ChatbotModule,
    MemoryModule,
    SttModule,
    EventsModule,
  ],
  controllers: [],
  providers: [CoreService, AgentContentService],
  exports: [TypeOrmModule, CoreService, AgentContentService],
})
export class CoreModule {}
