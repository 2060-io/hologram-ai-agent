import { Module } from '@nestjs/common'
import { RagModule } from '../rag/rag.module'
import { MemoryModule } from '../memory/memory.module'
import { McpModule } from '../mcp/mcp.module'
import { MediaModule } from '../media/media.module'
import { LlmService } from './llm.service'

@Module({
  imports: [RagModule, MemoryModule, McpModule, MediaModule],
  providers: [LlmService],
  exports: [LlmService],
})
export class LlmModule {}
