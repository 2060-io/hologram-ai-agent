import type { SttProvider, SttProviderConfig } from './stt-provider.interface'
import { OpenAiWhisperProvider } from './openai-whisper.provider'

/**
 * Creates an SttProvider instance based on the provider type in the config.
 * Add new providers here as they are implemented.
 */
export function createSttProvider(config: SttProviderConfig): SttProvider {
  switch (config.type) {
    case 'openai-whisper':
    case 'whisper-compatible':
      return new OpenAiWhisperProvider(config)
    default:
      throw new Error(`Unknown speech-to-text provider type: "${config.type}"`)
  }
}
