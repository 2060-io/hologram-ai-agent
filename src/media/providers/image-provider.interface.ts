/**
 * Raw image returned by a provider before any conversion.
 */
export interface GeneratedImage {
  buffer: Buffer
  mimeType: string
}

/**
 * Options passed to every provider's generate() method.
 */
export interface ImageGenerationOptions {
  /** Number of images to generate (provider may cap this). */
  n?: number
  /** Desired size hint (e.g. "1024x1024"). Provider interprets this. */
  size?: string
}

/**
 * Provider-specific configuration loaded from agent-pack.yaml.
 */
export interface ImageProviderConfig {
  /** Unique name used to reference this provider in tool calls. */
  name: string
  /** Provider type identifier (e.g. "openai-dalle", "openai-gpt-image", "stability-ai"). */
  type: string
  /** Model name (e.g. "dall-e-3", "gpt-image-1.5", "stable-diffusion-xl-1024-v1-0"). */
  model?: string
  /** Environment variable name holding the API key (omit if shared with LLM). */
  apiKeyEnv?: string
  /** Default generation size (e.g. "1024x1024"). */
  defaultSize?: string
  /** gpt-image only: rendering quality. */
  quality?: 'low' | 'medium' | 'high' | 'auto'
  /** gpt-image only: native output format returned by the API. */
  outputFormat?: 'png' | 'jpeg' | 'webp'
  /** gpt-image only: background handling. */
  background?: 'transparent' | 'opaque' | 'auto'
}

/**
 * All image generation providers must implement this interface.
 */
export interface ImageProvider {
  readonly name: string
  generate(prompt: string, options?: ImageGenerationOptions): Promise<GeneratedImage[]>
}
