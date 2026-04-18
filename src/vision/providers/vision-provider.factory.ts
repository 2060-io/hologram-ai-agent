import type { VisionProvider, VisionProviderConfig } from './vision-provider.interface'
import { OpenAiVisionProvider } from './openai-vision.provider'

/**
 * Creates a VisionProvider instance based on the provider type in the config.
 * Add new providers here as they are implemented.
 */
export function createVisionProvider(config: VisionProviderConfig): VisionProvider {
  switch (config.type) {
    case 'openai-vision':
    case 'openai-compatible-vision':
      return new OpenAiVisionProvider(config)
    default:
      throw new Error(`Unknown vision provider type: "${config.type}"`)
  }
}
