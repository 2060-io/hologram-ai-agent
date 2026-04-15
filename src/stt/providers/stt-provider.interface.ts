/**
 * Result returned by a speech-to-text provider.
 */
export interface TranscriptionResult {
  text: string
  language?: string
  duration?: number
}

/**
 * Provider-specific configuration loaded from agent-pack.yaml.
 */
export interface SttProviderConfig {
  /** Unique name used to reference this provider. */
  name: string
  /** Provider type identifier (e.g. "openai-whisper", "whisper-compatible"). */
  type: string
  /** Model name (e.g. "whisper-1", "large-v3"). */
  model?: string
  /** Environment variable name holding the API key. */
  apiKeyEnv?: string
  /** Base URL for the API. Empty = OpenAI cloud. Set for self-hosted. */
  baseUrl?: string
  /** Optional language hint (ISO 639-1, e.g. "en", "es"). */
  language?: string
}

/**
 * All speech-to-text providers must implement this interface.
 */
export interface SttProvider {
  readonly name: string
  transcribe(audioBuffer: Buffer, mimeType: string): Promise<TranscriptionResult>
}
