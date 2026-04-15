import { Injectable, Logger, OnModuleInit } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { createDecipheriv } from 'crypto'
import type { SttProvider, SttProviderConfig, TranscriptionResult } from './providers/stt-provider.interface'
import { createSttProvider } from './providers/stt-provider.factory'

export interface AudioCiphering {
  algorithm: string
  parameters?: Record<string, unknown>
}

const AUDIO_MIME_PREFIXES = ['audio/']

@Injectable()
export class SttService implements OnModuleInit {
  private readonly logger = new Logger(SttService.name)
  private provider: SttProvider | null = null
  private requireAuth = false

  constructor(private readonly config: ConfigService) {}

  async onModuleInit() {
    const providerConfig = this.config.get<SttProviderConfig>('appConfig.sttProvider')
    this.requireAuth = this.config.get<boolean>('appConfig.sttRequireAuth') ?? false

    if (!providerConfig) {
      this.logger.log('No speech-to-text provider configured. Voice notes will not be transcribed.')
      return
    }

    try {
      this.provider = createSttProvider(providerConfig)
      this.logger.log(
        `STT provider "${providerConfig.name}" (${providerConfig.type}) initialized. ` +
        `requireAuth=${this.requireAuth}`,
      )
    } catch (err) {
      this.logger.error(`Failed to initialize STT provider "${providerConfig.name}": ${err}`)
    }
  }

  get isEnabled(): boolean {
    return this.provider !== null
  }

  /**
   * Returns true if the given MIME type is an audio format that can be transcribed.
   */
  isAudioMimeType(mimeType: string): boolean {
    return AUDIO_MIME_PREFIXES.some((prefix) => mimeType.toLowerCase().startsWith(prefix))
  }

  /**
   * Check whether transcription is allowed for the given session.
   * Returns false if requireAuth is true and the user is not authenticated.
   */
  isAllowed(isAuthenticated: boolean): boolean {
    if (!this.isEnabled) return false
    if (this.requireAuth && !isAuthenticated) return false
    return true
  }

  /**
   * Download audio from a URL and transcribe it.
   */
  async transcribeFromUrl(url: string, mimeType: string, ciphering?: AudioCiphering): Promise<TranscriptionResult> {
    if (!this.provider) {
      throw new Error('STT provider is not configured.')
    }

    this.logger.log(`Downloading audio from URL for transcription (${mimeType})...`)

    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`Failed to download audio from ${url}: ${response.status}`)
    }

    const arrayBuffer = await response.arrayBuffer()
    let buffer: Buffer = Buffer.from(new Uint8Array(arrayBuffer))

    if (ciphering) {
      buffer = this.decrypt(buffer, ciphering)
      this.logger.log(`Decrypted audio (${ciphering.algorithm}): ${Math.round(buffer.length / 1024)}KB`)
    }

    this.logger.log(`Downloaded ${Math.round(buffer.length / 1024)}KB audio. Transcribing...`)

    const result = await this.provider.transcribe(buffer, mimeType)

    this.logger.log(
      `Transcription complete: "${result.text.slice(0, 100)}${result.text.length > 100 ? '...' : ''}" ` +
      `(lang=${result.language ?? 'unknown'}, duration=${result.duration ?? '?'}s)`,
    )

    return result
  }

  private decrypt(encrypted: Buffer, ciphering: AudioCiphering): Buffer {
    const key = ciphering.parameters?.['key'] as string | undefined
    const iv = ciphering.parameters?.['iv'] as string | undefined

    if (!key || !iv) {
      throw new Error(`Missing key or iv in ciphering parameters`)
    }

    const decipher = createDecipheriv(
      ciphering.algorithm,
      Buffer.from(key, 'hex'),
      Buffer.from(iv, 'hex'),
    )
    return Buffer.from(Buffer.concat([decipher.update(encrypted), decipher.final()]))
  }
}
