import OpenAI from 'openai'
import type { ImageProvider, ImageProviderConfig, ImageGenerationOptions, GeneratedImage } from './image-provider.interface'

export class DalleProvider implements ImageProvider {
  readonly name: string
  private readonly client: OpenAI
  private readonly model: string
  private readonly defaultSize: string

  constructor(config: ImageProviderConfig) {
    this.name = config.name
    this.model = config.model ?? 'dall-e-3'
    this.defaultSize = config.defaultSize ?? '1024x1024'

    const apiKey = config.apiKeyEnv
      ? process.env[config.apiKeyEnv]
      : process.env.OPENAI_API_KEY

    if (!apiKey) {
      throw new Error(
        `DalleProvider "${config.name}": missing API key. ` +
        `Set ${config.apiKeyEnv ?? 'OPENAI_API_KEY'} in the environment.`,
      )
    }

    this.client = new OpenAI({ apiKey })
  }

  async generate(prompt: string, options?: ImageGenerationOptions): Promise<GeneratedImage[]> {
    const n = options?.n ?? 1
    const size = (options?.size ?? this.defaultSize) as '256x256' | '512x512' | '1024x1024' | '1792x1024' | '1024x1792'

    const response = await this.client.images.generate({
      model: this.model,
      prompt,
      n: this.model === 'dall-e-3' ? 1 : n,
      size,
      response_format: 'b64_json',
    })

    const images: GeneratedImage[] = []

    for (const item of response.data ?? []) {
      if (item.b64_json) {
        images.push({
          buffer: Buffer.from(item.b64_json, 'base64'),
          mimeType: 'image/png',
        })
      }
    }

    // DALL-E 3 only supports n=1 per request, so loop for multiple images
    if (this.model === 'dall-e-3' && n > 1) {
      for (let i = 1; i < n; i++) {
        const extra = await this.client.images.generate({
          model: this.model,
          prompt,
          n: 1,
          size,
          response_format: 'b64_json',
        })
        for (const item of extra.data ?? []) {
          if (item.b64_json) {
            images.push({
              buffer: Buffer.from(item.b64_json, 'base64'),
              mimeType: 'image/png',
            })
          }
        }
      }
    }

    return images
  }
}
