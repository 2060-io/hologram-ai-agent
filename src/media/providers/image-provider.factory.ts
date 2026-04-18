import type { ImageProvider, ImageProviderConfig } from './image-provider.interface'
import { DalleProvider } from './dalle.provider'
import { GptImageProvider } from './gpt-image.provider'

/**
 * Creates an ImageProvider instance based on the provider type in the config.
 * Add new providers here as they are implemented.
 */
export function createImageProvider(config: ImageProviderConfig): ImageProvider {
  switch (config.type) {
    case 'openai-dalle':
      return new DalleProvider(config)
    case 'openai-gpt-image':
      return new GptImageProvider(config)
    default:
      throw new Error(`Unknown image generation provider type: "${config.type}"`)
  }
}
