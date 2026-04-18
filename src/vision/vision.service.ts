import { Injectable, Logger, OnModuleInit } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { createDecipheriv } from 'crypto'
import type {
  DescriptionResult,
  VisionProvider,
  VisionProviderConfig,
} from './providers/vision-provider.interface'
import { createVisionProvider } from './providers/vision-provider.factory'

export interface ImageCiphering {
  algorithm: string
  parameters?: Record<string, unknown>
}

const IMAGE_MIME_PREFIXES = ['image/']

/**
 * Mirrors `SttService`: downloads an image (handling E2EE ciphering), asks a
 * vision provider to describe it, and returns text that the caller injects
 * back into the chat flow so the LLM has context.
 *
 * If `appConfig.visionPassthrough` is set to `true` the intention is to pass
 * the raw image directly to a multimodal LLM instead of pre-describing it.
 * That path is not yet implemented; this service logs a warning and falls
 * back to describe-and-inject so the config surface is already stable for
 * future work without breaking consumers today.
 */
@Injectable()
export class VisionService implements OnModuleInit {
  private readonly logger = new Logger(VisionService.name)
  private provider: VisionProvider | null = null
  private requireAuth = false
  private passthrough = false

  constructor(private readonly config: ConfigService) {}

  async onModuleInit() {
    const providerConfig = this.config.get<VisionProviderConfig>('appConfig.visionProvider')
    this.requireAuth = this.config.get<boolean>('appConfig.visionRequireAuth') ?? false
    this.passthrough = this.config.get<boolean>('appConfig.visionPassthrough') ?? false

    if (!providerConfig) {
      this.logger.log('No vision provider configured. Image media will not be described.')
      return
    }

    if (this.passthrough) {
      this.logger.warn(
        'vision.passthrough=true was set but multimodal pass-through is not yet implemented. ' +
          'Falling back to describe-and-inject.',
      )
    }

    try {
      this.provider = createVisionProvider(providerConfig)
      this.logger.log(
        `Vision provider "${providerConfig.name}" (${providerConfig.type}) initialized. ` +
          `requireAuth=${this.requireAuth}`,
      )
    } catch (err) {
      this.logger.error(`Failed to initialize vision provider "${providerConfig.name}": ${err}`)
    }
  }

  get isEnabled(): boolean {
    return this.provider !== null
  }

  /**
   * True if the given MIME type is an image format that can be described.
   */
  isImageMimeType(mimeType: string): boolean {
    return IMAGE_MIME_PREFIXES.some((prefix) => mimeType.toLowerCase().startsWith(prefix))
  }

  /**
   * True when describe() is allowed for the caller's auth state.
   * Returns false if no provider is configured or auth is required but missing.
   */
  isAllowed(isAuthenticated: boolean): boolean {
    if (!this.isEnabled) return false
    if (this.requireAuth && !isAuthenticated) return false
    return true
  }

  /**
   * Download an image from a URL (decrypting if ciphered) and describe it.
   */
  async describeFromUrl(
    url: string,
    mimeType: string,
    ciphering?: ImageCiphering,
  ): Promise<DescriptionResult> {
    if (!this.provider) {
      throw new Error('Vision provider is not configured.')
    }

    this.logger.log(`Downloading image for description (${mimeType})...`)

    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`Failed to download image from ${url}: ${response.status}`)
    }

    const arrayBuffer = await response.arrayBuffer()
    let buffer: Buffer = Buffer.from(new Uint8Array(arrayBuffer))

    if (ciphering) {
      buffer = this.decrypt(buffer, ciphering)
      this.logger.log(`Decrypted image (${ciphering.algorithm}): ${Math.round(buffer.length / 1024)}KB`)
    }

    this.logger.log(`Downloaded ${Math.round(buffer.length / 1024)}KB image. Describing...`)

    const result = await this.provider.describe(buffer, mimeType)

    this.logger.log(
      `Description complete: "${result.text.slice(0, 120)}${result.text.length > 120 ? '...' : ''}"` +
        ` (model=${result.model ?? 'unknown'})`,
    )

    return result
  }

  private decrypt(encrypted: Buffer, ciphering: ImageCiphering): Buffer {
    const key = ciphering.parameters?.['key'] as string | undefined
    const iv = ciphering.parameters?.['iv'] as string | undefined

    if (!key || !iv) {
      throw new Error(`Missing key or iv in ciphering parameters`)
    }

    const decipher = createDecipheriv(ciphering.algorithm, Buffer.from(key, 'hex'), Buffer.from(iv, 'hex'))
    return Buffer.from(Buffer.concat([decipher.update(encrypted), decipher.final()]))
  }
}
