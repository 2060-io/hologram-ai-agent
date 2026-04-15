import { Test, TestingModule } from '@nestjs/testing'
import { ChatbotService } from './chatbot.service'
import { LlmService } from '../llm/llm.service'

describe('ChatbotService', () => {
  let service: ChatbotService

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChatbotService,
        { provide: LlmService, useValue: { generate: jest.fn(), detectLanguage: jest.fn() } },
      ],
    }).compile()

    service = module.get<ChatbotService>(ChatbotService)
  })

  it('should be defined', () => {
    expect(service).toBeDefined()
  })
})
