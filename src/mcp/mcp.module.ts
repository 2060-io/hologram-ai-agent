import { Global, Module } from '@nestjs/common'
import { McpService } from './mcp.service'

@Global()
@Module({
  providers: [McpService],
  exports: [McpService],
})
export class McpModule {}
