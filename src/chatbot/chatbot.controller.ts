import { Controller, Post, Body } from '@nestjs/common'
import { ApiTags, ApiOperation, ApiBody, ApiResponse } from '@nestjs/swagger'
import { ChatbotService } from './chatbot.service'
import { AskDto } from './dto/chatbot.dts'
import { SessionEntity } from '../core/models'

@ApiTags('chatbot')
@Controller('chatbot')
export class ChatbotController {
  constructor(private readonly chatbotService: ChatbotService) {}

  @Post('ask')
  @ApiOperation({ summary: 'Ask a question to the chatbot agent' })
  @ApiBody({ type: AskDto })
  @ApiResponse({
    status: 200,
    description: 'Returns the AI-generated answer.',
    schema: {
      example: {
        answer: 'Hologram is a next-generation digital identity platform...',
      },
    },
  })
  async ask(@Body() askDto: AskDto) {
    const { userInput, connectionId, lang, isAuthenticated, userName, state } = askDto

    const session = {
      connectionId,
      lang,
      isAuthenticated,
      userName,
      state,
    } as SessionEntity

    const answer = await this.chatbotService.chat({ userInput, session })
    return { answer }
  }
}
