import { createHash } from 'crypto'

/** A document loaded for seeding, with its content hash precomputed. */
export interface SeedDoc {
  id: string
  content: string
  hash: string
}

/** The subset of the persisted manifest needed to plan a seeding run. */
export interface ManifestLike {
  docId: string
  contentHash: string
  chunkIds: string[]
}

/** Result of diffing loaded documents against the persisted manifest. */
export interface SeedingPlan {
  /** New or changed documents that must be (re-)chunked, embedded and indexed. */
  toIndex: SeedDoc[]
  /** Documents whose content is identical to the last indexed version. */
  unchangedDocIds: string[]
  /** Chunk ids to delete: previous chunks of changed docs + chunks of removed docs. */
  staleChunkIds: string[]
  /** Manifest rows to delete because their document is gone from the corpus. */
  removedDocIds: string[]
}

export function contentHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * Deterministic id for a chunk, derived from document id, chunk position and
 * document content hash. Stable across restarts, so re-seeding the same corpus
 * overwrites instead of appending duplicates. Formatted as an RFC-4122-shaped
 * UUID because some backends (pgvector) require uuid ids.
 */
export function deterministicChunkId(docId: string, chunkIndex: number, docHash: string): string {
  const bytes = createHash('sha256').update(`${docId}|${chunkIndex}|${docHash}`, 'utf8').digest()
  bytes[6] = (bytes[6] & 0x0f) | 0x80
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.subarray(0, 16).toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

/**
 * Diff the loaded corpus against the persisted manifest and decide what to
 * index, what to skip and what to clean up. Pure function — easy to test.
 */
export function planSeeding(docs: SeedDoc[], manifest: ManifestLike[]): SeedingPlan {
  const byDocId = new Map(manifest.map((m) => [m.docId, m]))
  const seen = new Set<string>()
  const plan: SeedingPlan = { toIndex: [], unchangedDocIds: [], staleChunkIds: [], removedDocIds: [] }

  for (const doc of docs) {
    seen.add(doc.id)
    const existing = byDocId.get(doc.id)
    if (existing && existing.contentHash === doc.hash) {
      plan.unchangedDocIds.push(doc.id)
    } else {
      if (existing) plan.staleChunkIds.push(...existing.chunkIds)
      plan.toIndex.push(doc)
    }
  }

  for (const row of manifest) {
    if (!seen.has(row.docId)) {
      plan.removedDocIds.push(row.docId)
      plan.staleChunkIds.push(...row.chunkIds)
    }
  }

  return plan
}
