import { DynamicStructuredTool } from '@langchain/core/tools'
import { z } from 'zod'
import { Logger } from '@nestjs/common'
import { RagService } from '../../rag/rag.service'
const toolCtor = DynamicStructuredTool as unknown as new (fields: any) => DynamicStructuredTool
const logger = new Logger('ragRetrieverTool')

const ragSchema = z
  .object({
    query: z
      .string()
      .describe('User question or focused search query used to retrieve relevant context from the knowledge base.'),
  })
  .strict() as z.ZodTypeAny

/**
 * Factory that creates a RAG retriever tool bound to a RagService instance.
 */
export const createRagRetrieverTool = (ragService: RagService): DynamicStructuredTool =>
  new toolCtor({
    name: 'rag_retriever',
    description:
      'Use this tool to search in the internal knowledge base for information relevant to the current user question. ' +
      'Pass the full user question or a focused search query.',
    schema: ragSchema,
    async func({ query }: { query: string }) {
      logger.log(`[RAG Tool] Called with query="${query}"`)
      const contextArr = await ragService.retrieveContext(query)
      logger.log(`[RAG Tool] Retrieved ${contextArr.length} context snippet(s).`)

      if (!contextArr.length) {
        return 'No relevant documents were found in the knowledge base for this query.'
      }

      return contextArr.join('\n---\n')
    },
    returnDirect: false,
  }) as DynamicStructuredTool
