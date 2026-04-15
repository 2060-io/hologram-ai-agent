import { Test, TestingModule } from '@nestjs/testing'
import { ConfigService } from '@nestjs/config'
import { LlmService } from './llm.service'
import { MemoryService } from '../memory/memory.service'
import { RagService } from '../rag/rag.service'
import { McpService } from '../mcp/mcp.service'
import { ToolCallInterceptorService } from '../rbac/tool-call-interceptor.service'
import { RbacService } from '../rbac/rbac.service'

describe('LlmService', () => {
  let service: LlmService

  beforeEach(async () => {
    const configGet = jest.fn().mockImplementation((key: string) => {
      const values: Record<string, any> = {
        LLM_PROVIDER: 'openai',
        OPENAI_API_KEY: 'test-key',
        'appConfig.agentPrompt': 'You are a test agent.',
        'appConfig.openaiModel': 'gpt-4o',
        'appConfig.llmToolsConfig': undefined,
        'appConfig.agentVerbose': false,
      }
      return values[key]
    })

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LlmService,
        { provide: ConfigService, useValue: { get: configGet, getOrThrow: configGet } },
        { provide: MemoryService, useValue: {} },
        { provide: RagService, useValue: { retrieveContext: jest.fn().mockResolvedValue([]) } },
        { provide: McpService, useValue: { toolsVersion: 0, listTools: jest.fn().mockResolvedValue([]) } },
        { provide: ToolCallInterceptorService, useValue: {} },
        { provide: RbacService, useValue: { isRbacActive: jest.fn().mockReturnValue(false) } },
      ],
    }).compile()

    service = module.get<LlmService>(LlmService)
  })

  it('should be defined', () => {
    expect(service).toBeDefined()
  })
})
