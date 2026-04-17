import { Injectable, Logger, OnModuleInit } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { AsyncLocalStorage } from 'async_hooks'
import { randomUUID } from 'crypto'
import { ApiClient, ApiVersion } from '@2060.io/vs-agent-nestjs-client'
import type { ImageProvider, ImageProviderConfig } from './providers/image-provider.interface'
import { createImageProvider } from './providers/image-provider.factory'
import { ImageConverterService, ConversionOptions } from './image-converter.service'
import { MediaStoreService } from './media-store.service'
import { ImageRefStore } from './image-ref.store'
import { encryptBuffer, CipheringInfo } from './media-cipher.util'

export interface GenerateImageRequest {
  provider: string
  prompt: string
  n?: number
  size?: string
  targetFormat?: 'jpeg' | 'png' | 'webp'
  targetMaxWidth?: number
  targetMaxHeight?: number
  targetMaxSizeKb?: number
}

export interface GeneratedImageResult {
  refId: string
  previewUrl: string
  ciphering: CipheringInfo
}

@Injectable()
export class ImageGenerationService implements OnModuleInit {
  private readonly logger = new Logger(ImageGenerationService.name)
  private readonly providers = new Map<string, ImageProvider>()
  private providerConfigs: ImageProviderConfig[] = []

  /** Carries the current caller's connectionId through tool invocations */
  private readonly callerCtx = new AsyncLocalStorage<{ connectionId: string }>()

  private readonly apiClient: ApiClient

  constructor(
    private readonly config: ConfigService,
    private readonly converter: ImageConverterService,
    private readonly mediaStore: MediaStoreService,
    private readonly refStore: ImageRefStore,
  ) {
    const baseUrl = config.get<string>('appConfig.vsAgentAdminUrl') || 'http://localhost:3001'
    this.apiClient = new ApiClient(baseUrl, ApiVersion.V1)
  }

  async onModuleInit() {
    this.providerConfigs = this.config.get<ImageProviderConfig[]>('appConfig.imageGenerationProviders') ?? []

    if (this.providerConfigs.length === 0) {
      this.logger.log('No image generation providers configured.')
      return
    }

    for (const cfg of this.providerConfigs) {
      try {
        const provider = createImageProvider(cfg)
        this.providers.set(cfg.name, provider)
        this.logger.log(`Image provider "${cfg.name}" (${cfg.type}) initialized.`)
      } catch (err) {
        this.logger.error(`Failed to initialize image provider "${cfg.name}": ${err}`)
      }
    }
  }

  get isEnabled(): boolean {
    return this.providers.size > 0 && this.mediaStore.isEnabled
  }

  getProviderNames(): string[] {
    return Array.from(this.providers.keys())
  }

  /**
   * Generate images, convert to target specs, upload to MinIO, and return refs.
   */
  async generate(request: GenerateImageRequest): Promise<{ images: GeneratedImageResult[]; sentMessageId?: string }> {
    const provider = this.providers.get(request.provider)
    if (!provider) {
      throw new Error(
        `Image provider "${request.provider}" not found. Available: ${this.getProviderNames().join(', ')}`,
      )
    }

    if (!this.mediaStore.isEnabled) {
      throw new Error('MinIO media store is not configured. Cannot store generated images.')
    }

    this.logger.log(`Generating ${request.n ?? 1} image(s) with provider "${request.provider}": "${request.prompt}"`)

    // Step 1: Generate raw images from provider
    const rawImages = await provider.generate(request.prompt, {
      n: request.n,
      size: request.size,
    })

    this.logger.log(`Provider returned ${rawImages.length} image(s)`)

    // Step 2: Convert each image to target specs
    const conversionOptions: ConversionOptions = {
      format: request.targetFormat,
      maxWidth: request.targetMaxWidth,
      maxHeight: request.targetMaxHeight,
      maxSizeKb: request.targetMaxSizeKb,
    }

    const results: GeneratedImageResult[] = []
    const eventImages: {
      url: string
      mimeType: string
      width: number
      height: number
      preview: string
      ciphering: CipheringInfo
    }[] = []

    for (const raw of rawImages) {
      const converted = await this.converter.convert(raw.buffer, conversionOptions)

      // Step 3: Generate thumbnail for Hologram preview (64x64, 50% JPEG)
      const thumbnail = await this.converter.generateThumbnail(converted.buffer)

      // Step 4: Encrypt and upload converted image to MinIO
      const { encrypted, ciphering } = encryptBuffer(converted.buffer)
      const objectName = `generated/${randomUUID()}.${request.targetFormat ?? 'jpeg'}`
      const previewUrl = await this.mediaStore.upload(objectName, encrypted, converted.mimeType)

      // Step 5: Store ref for later retrieval by bridge tool
      const refId = this.refStore.add(converted.buffer, converted.mimeType, previewUrl)

      results.push({ refId, previewUrl, ciphering })
      eventImages.push({
        url: previewUrl,
        mimeType: converted.mimeType,
        width: converted.width,
        height: converted.height,
        preview: thumbnail.base64,
        ciphering,
      })
    }

    this.logger.log(`Generated and stored ${results.length} image(s): ${results.map((r) => r.refId).join(', ')}`)

    // Send MediaMessage directly to the user (avoids event triple-fire)
    let sentMessageId: string | undefined
    const ctx = this.callerCtx.getStore()
    if (ctx?.connectionId) {
      try {
        const { MediaItem, MediaMessage } = await import('@2060.io/vs-agent-nestjs-client')
        const items = eventImages.map(
          (img) =>
            new MediaItem({
              uri: img.url,
              mimeType: img.mimeType,
              ...(img.width ? { width: img.width } : {}),
              ...(img.height ? { height: img.height } : {}),
              ...(img.preview ? { preview: img.preview } : {}),
              ...(img.ciphering ? { ciphering: img.ciphering } : {}),
            }),
        )
        const sent = await this.apiClient.messages.send(
          new MediaMessage({
            connectionId: ctx.connectionId,
            items,
          }),
        )
        sentMessageId = sent?.id
        this.logger.log(`Sent MediaMessage ${sentMessageId} to ${ctx.connectionId}: ${items.length} item(s)`)
      } catch (err) {
        this.logger.error(`Failed to send MediaMessage: ${err}`)
      }
    } else {
      this.logger.warn('No connectionId in caller context — MediaMessage will not be sent to user.')
    }

    return { images: results, sentMessageId }
  }

  /**
   * Runs a function with the caller's connectionId in async context.
   * Tool invocations within `fn` will have access to the connectionId.
   */
  async runWithCaller<T>(connectionId: string, fn: () => Promise<T>): Promise<T> {
    return this.callerCtx.run({ connectionId }, fn)
  }
}
