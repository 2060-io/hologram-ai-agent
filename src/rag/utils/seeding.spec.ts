import { contentHash, deterministicChunkId, planSeeding, SeedDoc, ManifestLike } from './seeding'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

describe('seeding utils', () => {
  describe('contentHash', () => {
    it('is stable for identical content and differs for different content', () => {
      expect(contentHash('hello')).toBe(contentHash('hello'))
      expect(contentHash('hello')).not.toBe(contentHash('hello!'))
    })
  })

  describe('deterministicChunkId', () => {
    it('is stable across calls', () => {
      const a = deterministicChunkId('doc.md', 3, 'abc123')
      const b = deterministicChunkId('doc.md', 3, 'abc123')
      expect(a).toBe(b)
    })

    it('is a valid uuid shape (required by pgvector ids)', () => {
      expect(deterministicChunkId('doc.md', 0, 'abc123')).toMatch(UUID_RE)
    })

    it('differs by doc, index and content hash', () => {
      const base = deterministicChunkId('doc.md', 0, 'h1')
      expect(deterministicChunkId('other.md', 0, 'h1')).not.toBe(base)
      expect(deterministicChunkId('doc.md', 1, 'h1')).not.toBe(base)
      expect(deterministicChunkId('doc.md', 0, 'h2')).not.toBe(base)
    })
  })

  describe('planSeeding', () => {
    const doc = (id: string, content: string): SeedDoc => ({ id, content, hash: contentHash(content) })
    const row = (docId: string, content: string, chunkIds: string[]): ManifestLike => ({
      docId,
      contentHash: contentHash(content),
      chunkIds,
    })

    it('indexes new documents', () => {
      const plan = planSeeding([doc('a.md', 'A')], [])
      expect(plan.toIndex.map((d) => d.id)).toEqual(['a.md'])
      expect(plan.unchangedDocIds).toEqual([])
      expect(plan.staleChunkIds).toEqual([])
      expect(plan.removedDocIds).toEqual([])
    })

    it('skips unchanged documents', () => {
      const plan = planSeeding([doc('a.md', 'A')], [row('a.md', 'A', ['c1'])])
      expect(plan.toIndex).toEqual([])
      expect(plan.unchangedDocIds).toEqual(['a.md'])
      expect(plan.staleChunkIds).toEqual([])
    })

    it('re-indexes changed documents and marks their old chunks stale', () => {
      const plan = planSeeding([doc('a.md', 'A v2')], [row('a.md', 'A v1', ['c1', 'c2'])])
      expect(plan.toIndex.map((d) => d.id)).toEqual(['a.md'])
      expect(plan.staleChunkIds).toEqual(['c1', 'c2'])
      expect(plan.unchangedDocIds).toEqual([])
    })

    it('cleans up documents removed from the corpus', () => {
      const plan = planSeeding([doc('a.md', 'A')], [row('a.md', 'A', ['c1']), row('gone.md', 'G', ['c9'])])
      expect(plan.removedDocIds).toEqual(['gone.md'])
      expect(plan.staleChunkIds).toEqual(['c9'])
      expect(plan.unchangedDocIds).toEqual(['a.md'])
    })
  })
})
