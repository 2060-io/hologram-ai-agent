import { Test, TestingModule } from '@nestjs/testing'
import { ConfigService } from '@nestjs/config'
import { RagService } from './rag.service'
import { VectorStoreService } from './vector-store.service'
import { LangchainRagService } from './langchain-rag.service'

describe('RagService', () => {
  let service: RagService

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RagService,
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue('vectorstore') } },
        { provide: VectorStoreService, useValue: { retrieveContext: jest.fn(), addDocument: jest.fn() } },
        { provide: LangchainRagService, useValue: { retrieveContext: jest.fn(), addDocument: jest.fn() } },
      ],
    }).compile()

    service = module.get<RagService>(RagService)
  })

  it('should be defined', () => {
    expect(service).toBeDefined()
  })
})
