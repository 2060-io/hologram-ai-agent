import OpenAI from 'openai'
import type {
  ImageProvider,
  ImageProviderConfig,
  ImageGenerationOptions,
  GeneratedImage,
} from './image-provider.interface'

/**
 * OpenAI gpt-image-* family provider (gpt-image-1, gpt-image-1.5, ...).
 *
 * Differences vs DalleProvider:
 *  - `response_format` is NOT supported by the gpt-image models and must be
 *    omitted. They always return `b64_json` inline. Passing `response_format`
 *    yields a 400 from the API (see OpenAI Images API reference).
 *  - Supported sizes are `1024x1024`, `1024x1536`, `1536x1024`, and `auto` —
 *    the DALL-E 3 sizes (`1792x1024`, `1024x1792`) are rejected.
 *  - Extra tunables: `quality`, `output_format`, `background`.
 *  - `n` can be up to 10 in a single call; no per-request dall-e-3 workaround.
 */
export class GptImageProvider implements ImageProvider {
  private static readonly SUPPORTED_SIZES = new Set(['1024x1024', '1024x1536', '1536x1024', 'auto'])

  readonly name: string
  private readonly client: OpenAI
  private readonly model: string
  private readonly defaultSize: string
  private readonly quality?: 'low' | 'medium' | 'high' | 'auto'
  private readonly outputFormat: 'png' | 'jpeg' | 'webp'
  private readonly background?: 'transparent' | 'opaque' | 'auto'

  constructor(config: ImageProviderConfig) {
    this.name = config.name
    this.model = config.model ?? 'gpt-image-1.5'
    this.defaultSize = config.defaultSize ?? '1024x1024'
    this.quality = config.quality
    this.outputFormat = config.outputFormat ?? 'png'
    this.background = config.background

    const apiKey = config.apiKeyEnv ? process.env[config.apiKeyEnv] : process.env.OPENAI_API_KEY
    if (!apiKey) {
      throw new Error(
        `GptImageProvider "${config.name}": missing API key. ` +
          `Set ${config.apiKeyEnv ?? 'OPENAI_API_KEY'} in the environment.`,
      )
    }

    this.client = new OpenAI({ apiKey })
  }

  async generate(prompt: string, options?: ImageGenerationOptions): Promise<GeneratedImage[]> {
    const n = Math.min(Math.max(options?.n ?? 1, 1), 10)
    const requestedSize = options?.size ?? this.defaultSize
    const size = GptImageProvider.SUPPORTED_SIZES.has(requestedSize)
      ? (requestedSize as '1024x1024' | '1024x1536' | '1536x1024' | 'auto')
      : '1024x1024'

    // Build params explicitly — do NOT include `response_format`; the gpt-image
    // models reject it and always stream back `b64_json` inline.
    const params: Record<string, unknown> = {
      model: this.model,
      prompt,
      n,
      size,
      output_format: this.outputFormat,
    }
    if (this.quality) params.quality = this.quality
    if (this.background) params.background = this.background

    // Cast through `unknown`: the installed SDK's typings model only the
    // DALL-E shape, but gpt-image accepts `output_format` / `quality` /
    // `background` which we need to pass through.
    const response = await this.client.images.generate(
      params as unknown as Parameters<typeof this.client.images.generate>[0],
    )

    const mimeType = `image/${this.outputFormat}`
    const images: GeneratedImage[] = []
    for (const item of response.data ?? []) {
      if (item.b64_json) {
        images.push({
          buffer: Buffer.from(item.b64_json, 'base64'),
          mimeType,
        })
      }
    }
    return images
  }
}
