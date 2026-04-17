import { Logger } from '@nestjs/common'
import { AIMessage, HumanMessage, BaseMessage } from '@langchain/core/messages'
import { BaseChatMemory, type InputValues, type OutputValues, type MemoryVariables } from 'langchain/memory'

import { MemoryService } from './memory.service'
import { ChatMessage } from './interfaces/memory-backend.interface'

/**
 * LangchainSessionMemory
 * Adapter between LangChain and your MemoryService.
 * Uses sessionId (connectionId) as session identifier.
 */
export class LangchainSessionMemory extends BaseChatMemory {
  private readonly logger = new Logger(LangchainSessionMemory.name)

  constructor(
    private readonly memoryService: MemoryService,
    private readonly sessionId: string,
  ) {
    super()
  }

  /**
   * Keys that the prompt expects.
   * Must match the MessagesPlaceholder('chat_history')
   * you use in the agent's prompt.
   */
  get memoryKeys(): string[] {
    return ['chat_history']
  }

  /**
   * Loads the session history from your MemoryService
   * and converts it to the BaseMessage[] format that LangChain expects.
   * @param values
   * @returns
   */
  async loadMemoryVariables(values: InputValues): Promise<MemoryVariables> {
    this.logger.debug(`[loadMemoryVariables] sessionId=${this.sessionId} inputKeys=${Object.keys(values).join(',')}`)

    const history: ChatMessage[] = await this.memoryService.getHistory(this.sessionId)

    this.logger.debug(`[loadMemoryVariables] sessionId=${this.sessionId} messages=${history.length}`)

    const messages: BaseMessage[] = history.map((m, index) => {
      this.logger.debug(
        `[loadMemoryVariables] [${index}] role=${m.role} content="${m.content.slice(0, 100)}${m.content.length > 100 ? '...' : ''}"`,
      )

      return m.role === 'user' ? new HumanMessage(m.content) : new AIMessage(m.content)
    })

    return { chat_history: messages }
  }

  async saveContext(input: InputValues, output: OutputValues): Promise<void> {
    const userInput = (input.input ?? input.question ?? '') as string
    const aiOutput = (output.output ?? output.response ?? '') as string

    this.logger.debug(
      `[saveContext] sessionId=${this.sessionId} rawInput="${userInput.slice(0, 120)}${userInput.length > 120 ? '...' : ''}" rawOutput="${aiOutput.slice(0, 120)}${aiOutput.length > 120 ? '...' : ''}"`,
    )

    if (userInput) {
      this.logger.debug(
        `[saveContext] -> addMessage(role=user) sessionId=${this.sessionId} content="${userInput.slice(0, 120)}${userInput.length > 120 ? '...' : ''}"`,
      )
      await this.memoryService.addMessage(this.sessionId, 'user', userInput)
    }

    // Persist intermediate tool steps so the LLM can reference them on subsequent turns
    const steps = output.intermediateSteps as
      | { action: { tool: string; toolInput: Record<string, unknown> }; observation: string }[]
      | undefined
    if (steps?.length) {
      const summary = steps
        .map((s) => {
          const args = JSON.stringify(s.action.toolInput)
          const obs = s.observation.length > 500 ? s.observation.slice(0, 500) + '…' : s.observation
          return `${s.action.tool}(${args}) → ${obs}`
        })
        .join('\n')
      this.logger.debug(
        `[saveContext] -> addMessage(role=system, tool-steps) sessionId=${this.sessionId} steps=${steps.length}`,
      )
      await this.memoryService.addMessage(this.sessionId, 'system', `[Tool calls]\n${summary}`)
    }

    if (aiOutput) {
      this.logger.debug(
        `[saveContext] -> addMessage(role=system) sessionId=${this.sessionId} content="${aiOutput.slice(0, 120)}${aiOutput.length > 120 ? '...' : ''}"`,
      )
      await this.memoryService.addMessage(this.sessionId, 'system', aiOutput)
    }
  }

  async clear(): Promise<void> {
    this.logger.debug(`[clear] Clearing memory for sessionId=${this.sessionId}`)
    await this.memoryService.clear(this.sessionId)
  }
}
