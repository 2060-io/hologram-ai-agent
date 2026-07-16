import { Injectable, Logger, OnModuleInit } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'
import { Pinecone } from '@pinecone-database/pinecone'
import { PineconeStore } from '@langchain/pinecone'
import { RedisVectorStore } from '@langchain/redis'
import { PGVectorStore } from '@langchain/community/vectorstores/pgvector'
import { createClient, RedisClientType } from 'redis'
import { OpenAIEmbeddings, OpenAI } from '@langchain/openai'
import { loadDocuments } from './utils/load-documents'
import { parseRagLoadOptions, RagLoadOptionsDto } from './dto/RagLoadOptionsDto'
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters'
import { RagManifestEntity } from './entities/rag-manifest.entity'
import { contentHash, deterministicChunkId, planSeeding, SeedDoc } from './utils/seeding'

type SupportedStores = 'pinecone' | 'redis' | 'pgvector'

interface Chunk {
  id: string
  content: string
  docId: string
}

/**
 * Service for modular Retrieval Augmented Generation (RAG) using LangChainJS.
 * Supports multiple vector stores (Pinecone, Redis, pgvector) via environment-based configuration.
 * Handles document ingestion, similarity search, and LLM context generation.
 *
 * Seeding is idempotent: chunk ids are deterministic (doc id + chunk index + content hash)
 * and a manifest table records what is already indexed, so restarts skip unchanged
 * documents instead of re-embedding and duplicating the corpus.
 */
@Injectable()
export class LangchainRagService implements OnModuleInit {
  private vectorStore: PineconeStore | RedisVectorStore | PGVectorStore
  private redisClient: RedisClientType | undefined
  private redisKeyPrefix = ''
  private llm: OpenAI
  private readonly logger = new Logger(LangchainRagService.name)

  /**
   * Constructs the RAG service.
   * @param configService - The NestJS ConfigService for environment/config access.
   * @param manifestRepo - Repository tracking which document versions are indexed.
   */
  constructor(
    private configService: ConfigService,
    @InjectRepository(RagManifestEntity)
    private readonly manifestRepo: Repository<RagManifestEntity>,
  ) {}

  /**
   * Initializes the vector store (Pinecone, Redis or pgvector) and LLM (OpenAI).
   * Selection is dynamic based on VECTOR_STORE env/config.
   * Logs each initialization step for observability.
   */
  async onModuleInit() {
    if (!this.configService.get<boolean>('appConfig.ragEnabled')) {
      this.logger.log('[RAG] (Langchain) RAG not configured — skipping initialization.')
      return
    }
    if (this.configService.get<string>('appConfig.ragProvider', 'langchain') !== 'langchain') {
      this.logger.log('[RAG] (Langchain) Not the selected RAG provider — skipping initialization.')
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
    } else if (vectorStoreProvider === 'pgvector') {
      // Initialize Postgres/pgvector vector store
      await this.initPgvector(embeddings)
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
  }

  /**
   * Adds (or replaces) a single document in the vector store for RAG-based retrieval.
   * Idempotent: re-adding the same id replaces its previous chunks.
   * @param id - Unique identifier for the document.
   * @param text - Content of the document to index.
   */
  async addDocument(id: string, text: string) {
    this.logger.debug(`Adding document to vector store | id: ${id}`)
    const hash = contentHash(text)
    const chunkId = deterministicChunkId(id, 0, hash)

    const previous = await this.manifestRepo.findOneBy({ docId: id })
    if (previous) await this.deleteChunks(previous.chunkIds)

    await this.deleteChunks([chunkId])
    await this.addChunks([{ id: chunkId, content: text, docId: id }])
    await this.manifestRepo.save({ docId: id, contentHash: hash, chunkIds: [chunkId] })
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
   * Cleans up resources (closes Redis/Postgres clients if used) when the module is destroyed.
   */
  async onModuleDestroy() {
    if (this.redisClient) {
      this.logger.log('Disconnecting Redis client...')
      await this.redisClient.disconnect()
      this.logger.log('Redis client disconnected.')
    }
    if (this.vectorStore instanceof PGVectorStore) {
      this.logger.log('Closing pgvector pool...')
      await this.vectorStore.end()
      this.logger.log('pgvector pool closed.')
    }
  }

  /**
   * Synchronizes the vector store with the document corpus (local folder + remote URLs).
   * Uses the manifest to skip unchanged documents (no re-embedding cost), re-index
   * changed ones, and delete chunks of removed ones. Safe to run on every boot.
   * @param options - Validated load options (paths, chunking, remote URLs).
   */
  private async loadVectorStore(options: RagLoadOptionsDto) {
    const { folderBasePath, remoteUrls, chunkSize, chunkOverlap } = options
    try {
      this.logger.log(`[RAG] Loading documents from: ${folderBasePath}`)
      const loaded = await loadDocuments({
        folderBasePath,
        logger: this.logger,
        remoteUrls,
      })
      const docs: SeedDoc[] = loaded.map((d) => ({ ...d, hash: contentHash(d.content) }))

      const manifest = await this.manifestRepo.find()
      const plan = planSeeding(docs, manifest)

      if (plan.unchangedDocIds.length) {
        this.logger.log(`[RAG] ${plan.unchangedDocIds.length} document(s) unchanged — skipping re-indexing.`)
      }
      if (plan.staleChunkIds.length) {
        await this.deleteChunks(plan.staleChunkIds)
        this.logger.log(`[RAG] Deleted ${plan.staleChunkIds.length} stale chunk(s).`)
      }
      if (plan.removedDocIds.length) {
        await this.manifestRepo.delete(plan.removedDocIds)
        this.logger.log(`[RAG] Forgot ${plan.removedDocIds.length} removed document(s).`)
      }

      const splitter = new RecursiveCharacterTextSplitter({
        chunkSize,
        chunkOverlap,
      })
      this.logger.debug(`[RAG] Splitter -> chunkSize=${chunkSize} overlap=${chunkOverlap}`)

      for (const doc of plan.toIndex) {
        const t0 = Date.now()
        const chunks = await splitter.createDocuments([doc.content], [{ id: doc.id }])
        const chunkIds = chunks.map((_, index) => deterministicChunkId(doc.id, index, doc.hash))
        this.logger.debug(`[RAG] "${doc.id}" → ${chunks.length} chunks`)

        try {
          // Deterministic ids already make re-adds collision-stable, but delete first
          // so seeding stays idempotent even if the manifest was lost or reset.
          await this.deleteChunks(chunkIds)
          await this.addChunks(
            chunks.map((chunk, index) => ({ id: chunkIds[index], content: chunk.pageContent, docId: doc.id })),
          )
          await this.manifestRepo.save({ docId: doc.id, contentHash: doc.hash, chunkIds })
        } catch (error) {
          this.logger.error(`[RAG] Error indexing "${doc.id}": ${error instanceof Error ? error.message : error}`)
          continue
        }

        this.logger.debug(`[RAG] Indexed "${doc.id}" in ${Date.now() - t0}ms`)
      }

      this.logger.log(
        `[RAG] Seeding complete (${plan.toIndex.length} indexed, ${plan.unchangedDocIds.length} unchanged).`,
      )
    } catch (error) {
      const err = error as Error
      this.logger.warn(`[RAG] Seeding failed but service will continue: ${err?.message ?? err}`)
    }
  }

  /**
   * Writes chunks to the vector store under their deterministic ids.
   * Redis takes full key names; Pinecone/pgvector take ids.
   */
  private async addChunks(chunks: Chunk[]) {
    if (!chunks.length) return
    const documents = chunks.map((chunk) => ({ pageContent: chunk.content, metadata: { id: chunk.docId } }))
    if (this.vectorStore instanceof RedisVectorStore) {
      await this.vectorStore.addDocuments(documents, {
        keys: chunks.map((chunk) => `${this.redisKeyPrefix}${chunk.id}`),
      })
    } else {
      await this.vectorStore.addDocuments(documents, { ids: chunks.map((chunk) => chunk.id) })
    }
  }

  /**
   * Deletes chunks by id. All supported stores accept `{ ids }`
   * (Redis prefixes them with its configured keyPrefix internally).
   */
  private async deleteChunks(chunkIds: string[]) {
    if (!chunkIds.length) return
    const store = this.vectorStore as unknown as { delete: (params: { ids: string[] }) => Promise<void> }
    await store.delete({ ids: chunkIds })
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
      this.redisKeyPrefix = `doc:${indexName}:`
      this.vectorStore = new RedisVectorStore(embeddings, {
        redisClient: this.redisClient,
        indexName,
        keyPrefix: this.redisKeyPrefix,
      })
      this.logger.log('Redis vector store initialized.')
    } catch (err: any) {
      this.logger.error(`Redis init failed: ${err?.message ?? err}`)
      throw err
    }
  }

  /**
   * Initializes the Postgres/pgvector vector store, reusing the application's
   * Postgres connection settings. Requires a server with the pgvector extension
   * available (e.g. the pgvector/pgvector image); the table and extension are
   * created on first run.
   * @param embeddings - OpenAIEmbeddings instance for the pgvector store.
   */
  private async initPgvector(embeddings: OpenAIEmbeddings) {
    const host = this.configService.get<string>('appConfig.postgresHost')
    const tableName = this.configService.get<string>('appConfig.pgvectorTable') || 'rag_embeddings'
    this.logger.log(`Connecting to Postgres/pgvector: ${host} (table=${tableName})`)
    try {
      this.vectorStore = await PGVectorStore.initialize(embeddings, {
        postgresConnectionOptions: {
          host,
          port: 5432,
          user: this.configService.get<string>('appConfig.postgresUser'),
          password: this.configService.get<string>('appConfig.postgresPassword'),
          database: this.configService.get<string>('appConfig.postgresDbName'),
        },
        tableName,
      })
      this.logger.log('pgvector vector store initialized.')
    } catch (err: any) {
      this.logger.error(
        `pgvector init failed (is the Postgres server built with the pgvector extension, e.g. pgvector/pgvector:pg16?): ${err?.message ?? err}`,
      )
      throw err
    }
  }
}
