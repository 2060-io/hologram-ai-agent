import { Module } from '@nestjs/common'
import { ChatbotService } from './chatbot.service'
import { ChatbotController } from './chatbot.controller'
import { LlmModule } from '../llm/llm.module'

@Module({
  imports: [LlmModule],
  providers: [ChatbotService],
  controllers: [ChatbotController],
  exports: [ChatbotService],
})
export class ChatbotModule {}
