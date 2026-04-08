import { Global, Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { McpService } from './mcp.service'
import { McpConfigEntity } from './mcp-config.entity'
import { McpConfigService } from './mcp-config.service'

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([McpConfigEntity])],
  providers: [McpService, McpConfigService],
  exports: [McpService, McpConfigService],
})
export class McpModule {}
