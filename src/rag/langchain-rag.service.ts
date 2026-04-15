import { Injectable, Logger, OnModuleInit } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Pinecone } from '@pinecone-database/pinecone'
import { PineconeStore } from '@langchain/pinecone'
import { RedisVectorStore } from '@langchain/redis'
import { createClient, RedisClientType } from 'redis'
import { OpenAIEmbeddings, OpenAI } from '@langchain/openai'
import { loadDocuments } from './utils/load-documents'
import { parseRagLoadOptions, RagLoadOptionsDto } from './dto/RagLoadOptionsDto'
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters'

type SupportedStores = 'pinecone' | 'redis'

/**
 * Service for modular Retrieval Augmented Generation (RAG) using LangChainJS.
 * Supports multiple vector stores (Pinecone, Redis) via environment-based configuration.
 * Handles document ingestion, similarity search, and LLM context generation.
 */
@Injectable()
export class LangchainRagService implements OnModuleInit {
  private vectorStore: PineconeStore | RedisVectorStore
  private redisClient: RedisClientType | undefined
  private llm: OpenAI
  private readonly logger = new Logger(LangchainRagService.name)

  /**
   * Constructs the RAG service.
   * @param configService - The NestJS ConfigService for environment/config access.
   */
  constructor(private configService: ConfigService) {}

  /**
   * Initializes the vector store (Pinecone or Redis) and LLM (OpenAI).
   * Selection is dynamic based on VECTOR_STORE env/config.
   * Logs each initialization step for observability.
   */
  async onModuleInit() {
    if (!this.configService.get<boolean>('appConfig.ragEnabled')) {
      this.logger.log('[RAG] (Langchain) RAG not configured — skipping initialization.')
      return
    }
    const vectorStoreProvider = this.configService.get<string>('appConfig.vectorStore') as SupportedStores
    const openaiApiKey = this.configService.get<string>('appConfig.openaiApiKey') || process.env.OPENAI_API_KEY

    let embeddings: OpenAIEmbeddings
    this.logger.log(`Initializing LangchainRagService with VECTOR_STORE: ${vectorStoreProvider}`)

    try {
      embeddings = new OpenAIEmbeddings({ openAIApiKey: openaiApiKey! })
      this.logger.debug('OpenAI embeddings initialized successfully.')
    } catch (error) {
      this.logger.error(`Failed to initialize OpenAI embeddings: ${error.message}`)
      return
    }

    if (vectorStoreProvider === 'pinecone') {
      // Initialize Pinecone vector store
      await this.initPinecone(embeddings)
    } else if (vectorStoreProvider === 'redis') {
      // Initialize Redis vector store
      await this.initRedis(embeddings)
    } else {
      this.logger.error(`Unsupported VECTOR_STORE: ${JSON.stringify(vectorStoreProvider)}`)
      throw new Error(`Unsupported VECTOR_STORE: ${JSON.stringify(vectorStoreProvider)}`)
    }

    await this.loadVectorStore(
      parseRagLoadOptions({
        folderBasePath: this.configService.get<string>('appConfig.ragDocsPath'),
        chunkSize: this.configService.get<number>('appConfig.ragChunkSize'),
        chunkOverlap: this.configService.get<number>('appConfig.chunkOverlap'),
        remoteUrls: this.configService.get<string[]>('appConfig.ragRemoteUrls'),
      }),
    )

    this.logger.log('Seeded vector store with initial document.')
  }

  /**
   * Adds a document to the vector store for RAG-based retrieval.
   * @param id - Unique identifier for the document.
   * @param text - Content of the document to index.
   */
  async addDocument(id: string, text: string) {
    this.logger.debug(`Adding document to vector store | id: ${id}`)
    await this.vectorStore.addDocuments([{ pageContent: text, metadata: { id } }])
    this.logger.verbose(`Document "${id}" added to vector store.`)
  }

  /**
   * Retrieves relevant context documents from the vector store.
   * @param query - User's question or query string.
   * @returns Array of relevant context snippets.
   */
  async retrieveContext(query: string): Promise<string[]> {
    this.logger.debug(`Retrieving context for query: "${query}"`)
    const results = await this.vectorStore.similaritySearch(query, 3)
    const hitIds = results.map((r) => (r.metadata && (r.metadata as any).id) || '(unknown)')
    this.logger.log(`[RAG] Context hits (${results.length}): ${hitIds.join(', ')}`)
    this.logger.debug(
      `[RAG] Context snippets: ${results
        .map((r, i) => `#${i + 1}(${(r.pageContent || '').length ?? 0} chars)`)
        .join(' | ')}`,
    )
    return results.map((r) => r.pageContent)
  }

  /**
   * Cleans up resources (closes Redis client if used) when the module is destroyed.
   */
  async onModuleDestroy() {
    if (this.redisClient) {
      this.logger.log('Disconnecting Redis client...')
      await this.redisClient.disconnect()
      this.logger.log('Redis client disconnected.')
    }
  }
  /**
   * Loads documents from the specified path into the vector store.
   * Splits documents into chunks for efficient indexing.
   * Handles errors gracefully and logs progress.
   * @param docsPath - Path to the directory containing documents.
   * @param chunkSize - Size of each text chunk for indexing.
   * @param chunkOverlap - Overlap size between chunks (default is 200).
   */
  private async loadVectorStore(options: RagLoadOptionsDto) {
    const { folderBasePath, remoteUrls, chunkSize, chunkOverlap } = options
    try {
      this.logger.log(`[RAG] Loading documents from: ${folderBasePath}`)
      const docs = await loadDocuments({
        folderBasePath,
        logger: this.logger,
        remoteUrls,
      })

      const splitter = new RecursiveCharacterTextSplitter({
        chunkSize,
        chunkOverlap,
      })
      this.logger.debug(`[RAG] Splitter -> chunkSize=${chunkSize} overlap=${chunkOverlap}`)

      for (const doc of docs) {
        const t0 = Date.now()
        const chunks = await splitter.createDocuments([doc.content], [{ id: doc.id }])
        this.logger.debug(`[RAG] "${doc.id}" → ${chunks.length} chunks`)

        for (const chunk of chunks) {
          try {
            await this.addDocument(chunk.metadata.id, chunk.pageContent)
          } catch (error) {
            this.logger.error(
              `[RAG] Error indexing chunk "${chunk.metadata.id}": ${error instanceof Error ? error.message : error}`,
            )
            continue
          }
        }

        this.logger.debug(`[RAG] Indexed "${doc.id}" in ${Date.now() - t0}ms`)
      }

      this.logger.log('[RAG] Seeding complete.')
    } catch (error) {
      const err = error as Error
      this.logger.warn(`[RAG] Seeding failed but service will continue: ${err?.message ?? err}`)
    }
  }
  /**
   * Initializes Pinecone vector store and client.
   * Logs connection status and handles errors.
   * @param embeddings - OpenAIEmbeddings instance for Pinecone vector store.
   */
  private async initPinecone(embeddings: OpenAIEmbeddings) {
    this.logger.log('Connecting to Pinecone...')
    if (!this.configService.get<string>('appConfig.pineconeApiKey')) {
      this.logger.error('Pinecone API key is not configured. Please set appConfig.pineconeApiKey in your environment.')
      throw new Error('Pinecone API key is required for initialization.')
    }
    if (!this.configService.get<string>('appConfig.vectorIndexName')) {
      this.logger.error(
        'Pinecone index name is not configured. Please set appConfig.vectorIndexName in your environment.',
      )
      throw new Error('Pinecone index name is required for initialization.')
    }
    this.logger.debug('Pinecone API key and index name are configured.')
    try {
      const pinecone = new Pinecone({ apiKey: this.configService.get<string>('appConfig.pineconeApiKey')! })
      const indexName = this.configService.get('appConfig.vectorIndexName', process.env.VECTOR_INDEX_NAME ?? '')
      const pineconeIndex = pinecone.index(indexName)
      this.vectorStore = await PineconeStore.fromExistingIndex(embeddings, { pineconeIndex })
      this.logger.log(`Pinecone ready (index=${indexName}).`)
    } catch (error) {
      this.logger.error(`Failed to connect to Pinecone: ${error instanceof Error ? error.message : error}`)
    }
  }

  /**
   * Initializes Redis client and vector store.
   * Logs connection status and handles errors.
   * @param embeddings - OpenAIEmbeddings instance for Redis vector store.
   */
  private async initRedis(embeddings: OpenAIEmbeddings) {
    this.logger.log('Connecting to Redis...')
    const url = this.configService.get<string>('appConfig.redisUrl') || process.env.REDIS_URL
    const indexName = this.configService.get<string>('appConfig.redisIndexName') || process.env.VECTOR_INDEX_NAME!
    this.logger.log(`Connecting to Redis: ${url} (index=${indexName})`)
    try {
      this.redisClient = createClient({ url }) as RedisClientType
      await this.redisClient.connect()
      this.vectorStore = new RedisVectorStore(embeddings, { redisClient: this.redisClient, indexName })
      this.logger.log('Redis vector store initialized.')
    } catch (err: any) {
      this.logger.error(`Redis init failed: ${err?.message ?? err}`)
      throw err
    }
  }
}
