import { Injectable, Logger, OnModuleInit } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { OpenAI } from 'openai'

import { IRagBackend } from './interfaces/rag-backend.interface'
import { loadDocuments } from './utils/load-documents'
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters'

function cosineSimilarity(a: number[], b: number[]): number {
  const dot = a.reduce((sum, ai, i) => sum + ai * b[i], 0)
  const normA = Math.sqrt(a.reduce((sum, ai) => sum + ai * ai, 0))
  const normB = Math.sqrt(b.reduce((sum, bi) => sum + bi * bi, 0))
  return dot / (normA * normB)
}

@Injectable()
export class VectorStoreService implements IRagBackend, OnModuleInit {
  private openai: OpenAI
  private docs: { id: string; text: string; embedding: number[] }[] = []
  private llmProvider: string
  private readonly logger = new Logger(VectorStoreService.name)

  constructor(private configService: ConfigService) {
    this.llmProvider = this.configService.get<string>('appConfig.llmProvider', 'ollama')
    if (this.llmProvider === 'openai') {
      const openaiApiKey = this.configService.get<string>('appConfig.openaiApiKey')
      this.openai = new OpenAI({ apiKey: openaiApiKey })
    }
    this.logger.log(`Using embeddings provider: "${this.llmProvider}"`)
  }

  async onModuleInit() {
    if (!this.configService.get<boolean>('appConfig.ragEnabled')) {
      this.logger.log('[RAG] (VectorStore) RAG not configured — skipping document ingestion.')
      return
    }
    try {
      const docsPath = this.configService.getOrThrow<string>('appConfig.ragDocsPath')
      const chunkSize = this.configService.get<number>('appConfig.ragChunkSize')
      const chunkOverlap = this.configService.get<number>('appConfig.chunkOverlap')
      const remoteUrls = this.configService.get<string[]>('appConfig.ragRemoteUrls')

      this.logger.log(`[RAG] (VectorStore) Seeding from: ${docsPath}`)
      const rawDocs = await loadDocuments({ folderBasePath: docsPath, logger: this.logger, remoteUrls })

      const splitter = new RecursiveCharacterTextSplitter({ chunkSize, chunkOverlap })
      this.logger.debug(`[RAG] (VectorStore) Splitter -> chunkSize=${chunkSize} overlap=${chunkOverlap}`)

      for (const doc of rawDocs) {
        const chunks = await splitter.createDocuments([doc.content], [{ id: doc.id }])
        this.logger.debug(`[RAG] (VectorStore) "${doc.id}" → ${chunks.length} chunks`)
        let idx = 0
        for (const chunk of chunks) {
          const cid = `${chunk.metadata?.id ?? doc.id}#${++idx}`
          try {
            await this.addDocument(cid, chunk.pageContent)
          } catch (e: any) {
            this.logger.warn(`[RAG] (VectorStore) Failed to index chunk ${cid}: ${e?.message ?? e}`)
          }
        }
      }

      this.logger.log('[RAG] (VectorStore) Seeding complete.')
    } catch (e: any) {
      this.logger.warn(`[RAG] (VectorStore) Seeding failed: ${e?.message ?? e}`)
    }
  }

  async embed(text: string): Promise<number[]> {
    if (this.llmProvider === 'openai') {
      const res = await this.openai.embeddings.create({
        input: text,
        model: 'text-embedding-ada-002',
      })
      return res.data[0].embedding
    } else {
      // Local embeddings
      return text.split('').map((char) => (char.charCodeAt(0) % 17) / 17)
    }
  }

  async addDocument(id: string, text: string) {
    this.logger.debug(`[RAG] (VectorStore) Adding document | id: ${id}`)
    const embedding = await this.embed(text)
    this.docs.push({ id, text, embedding })
  }

  async query(text: string, topK = 3): Promise<{ id: string; text: string; score: number }[]> {
    const embedding = await this.embed(text)
    const results = this.docs
      .map((doc) => ({
        id: doc.id,
        text: doc.text,
        score: cosineSimilarity(embedding, doc.embedding),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
    return results
  }

  async retrieveContext(query: string): Promise<string[]> {
    this.logger.debug(`[RAG] (VectorStore) Retrieving context for query: "${query}"`)
    const results = await this.query(query, 3)
    this.logger.log(`[RAG] (VectorStore) Context hits (${results.length}): ${results.map((r) => r.id).join(', ')}`)
    return results.map((r) => r.text)
  }
}
