import { Injectable, Logger } from '@nestjs/common'
import { randomUUID } from 'crypto'

export interface ImageRef {
  refId: string
  buffer: Buffer
  mimeType: string
  previewUrl: string
  createdAt: number
}

const DEFAULT_TTL_MS = 60 * 60 * 1000 // 1 hour

@Injectable()
export class ImageRefStore {
  private readonly logger = new Logger(ImageRefStore.name)
  private readonly store = new Map<string, ImageRef>()
  private cleanupInterval: ReturnType<typeof setInterval> | null = null

  constructor() {
    // Periodically clean expired refs
    this.cleanupInterval = setInterval(() => this.purgeExpired(), 5 * 60 * 1000)
  }

  /**
   * Store a converted image and return a unique refId.
   */
  add(buffer: Buffer, mimeType: string, previewUrl: string): string {
    const refId = randomUUID()
    this.store.set(refId, {
      refId,
      buffer,
      mimeType,
      previewUrl,
      createdAt: Date.now(),
    })
    this.logger.debug(`Stored image ref "${refId}" (${Math.round(buffer.length / 1024)}KB, ${mimeType})`)
    return refId
  }

  /**
   * Retrieve a stored image by refId. Returns null if expired or not found.
   */
  get(refId: string): ImageRef | null {
    const ref = this.store.get(refId)
    if (!ref) return null
    if (Date.now() - ref.createdAt > DEFAULT_TTL_MS) {
      this.store.delete(refId)
      return null
    }
    return ref
  }

  /**
   * Remove a specific ref (e.g. after successful upload to MCP).
   */
  remove(refId: string): void {
    this.store.delete(refId)
  }

  private purgeExpired(): void {
    const now = Date.now()
    let purged = 0
    for (const [key, ref] of this.store) {
      if (now - ref.createdAt > DEFAULT_TTL_MS) {
        this.store.delete(key)
        purged++
      }
    }
    if (purged > 0) {
      this.logger.debug(`Purged ${purged} expired image ref(s). ${this.store.size} remaining.`)
    }
  }

  onModuleDestroy() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval)
    }
  }
}
