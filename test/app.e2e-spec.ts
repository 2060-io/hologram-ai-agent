import { Test, TestingModule } from '@nestjs/testing'
import { INestApplication } from '@nestjs/common'
import * as request from 'supertest'
import { ChatbotController } from '../src/chatbot/chatbot.controller'
import { ChatbotService } from '../src/chatbot/chatbot.service'
import { LlmService } from '../src/llm/llm.service'

describe('Chatbot (e2e)', () => {
  let app: INestApplication

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [ChatbotController],
      providers: [
        ChatbotService,
        {
          provide: LlmService,
          useValue: {
            generate: jest.fn().mockResolvedValue('Test response'),
            detectLanguage: jest.fn().mockResolvedValue('en'),
          },
        },
      ],
    }).compile()

    app = moduleFixture.createNestApplication()
    await app.init()
  })

  afterAll(async () => {
    await app.close()
  })

  it('/chatbot/ask (POST)', () => {
    return request(app.getHttpServer())
      .post('/chatbot/ask')
      .send({ userInput: 'Hello', connectionId: 'test-conn' })
      .expect(201)
      .expect((res) => {
        expect(res.body).toHaveProperty('answer')
        expect(res.body.answer).toBe('Test response')
      })
  })
})
