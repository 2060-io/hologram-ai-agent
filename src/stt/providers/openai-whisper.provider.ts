import OpenAI from 'openai'
import { Uploadable } from 'openai/uploads'
import type { SttProvider, SttProviderConfig, TranscriptionResult } from './stt-provider.interface'

/**
 * Mime-type to file extension mapping for audio formats supported by Whisper.
 */
const MIME_TO_EXT: Record<string, string> = {
  'audio/flac': 'flac',
  'audio/mp3': 'mp3',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'mp4',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/webm': 'webm',
  'audio/aac': 'aac',
}

/**
 * Provider for OpenAI Whisper API and any Whisper-compatible self-hosted endpoint.
 * Both expose the same `/v1/audio/transcriptions` endpoint.
 */
export class OpenAiWhisperProvider implements SttProvider {
  readonly name: string
  private readonly client: OpenAI
  private readonly model: string
  private readonly language?: string

  constructor(config: SttProviderConfig) {
    this.name = config.name
    this.model = config.model ?? 'whisper-1'
    this.language = config.language || undefined

    const apiKey = config.apiKeyEnv
      ? process.env[config.apiKeyEnv]
      : process.env.OPENAI_API_KEY

    if (!apiKey && !config.baseUrl) {
      throw new Error(
        `OpenAiWhisperProvider "${config.name}": missing API key. ` +
        `Set ${config.apiKeyEnv ?? 'OPENAI_API_KEY'} in the environment.`,
      )
    }

    this.client = new OpenAI({
      apiKey: apiKey || 'not-needed',
      ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
    })
  }

  async transcribe(audioBuffer: Buffer, mimeType: string): Promise<TranscriptionResult> {
    const ext = MIME_TO_EXT[mimeType] ?? 'ogg'
    const fileName = `audio.${ext}`

    const file: Uploadable = new File(
      [new Uint8Array(audioBuffer)],
      fileName,
      { type: mimeType },
    )

    const response = await this.client.audio.transcriptions.create({
      model: this.model,
      file,
      ...(this.language ? { language: this.language } : {}),
      response_format: 'verbose_json',
    })

    return {
      text: response.text,
      language: (response as any).language ?? undefined,
      duration: (response as any).duration ?? undefined,
    }
  }
}
