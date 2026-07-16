import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm'

/**
 * Tracks which version of each RAG source document is currently indexed in the
 * vector store, and which chunk ids belong to it. Lets seeding skip unchanged
 * documents (no re-embedding) and clean up chunks of changed/removed ones.
 */
@Entity('rag_manifest')
export class RagManifestEntity {
  @PrimaryColumn()
  docId: string

  @Column()
  contentHash: string

  @Column('simple-json')
  chunkIds: string[]

  @UpdateDateColumn()
  updatedAt: Date
}
