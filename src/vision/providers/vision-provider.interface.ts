/**
 * Result returned by a vision provider.
 */
export interface DescriptionResult {
  /** Textual description of the image contents. */
  text: string
  /** Model that produced the description (informational). */
  model?: string
}

/**
 * Provider-specific configuration loaded from agent-pack.yaml.
 */
export interface VisionProviderConfig {
  /** Unique name used to reference this provider. */
  name: string
  /** Provider type identifier (e.g. "openai-vision"). */
  type: string
  /** Model name (e.g. "gpt-4o-mini", "gpt-5.4-mini"). */
  model?: string
  /** Environment variable name holding the API key. */
  apiKeyEnv?: string
  /** Base URL for the API. Empty = OpenAI cloud. Set for self-hosted. */
  baseUrl?: string
  /** System / instruction prompt guiding the description. */
  prompt?: string
  /** Max output tokens from the vision model. */
  maxTokens?: number
  /** OpenAI image_url `detail` hint. */
  detail?: 'low' | 'high' | 'auto'
  /** Optional output-language hint (ISO 639-1, e.g. "en", "es"). */
  language?: string
}

/**
 * All vision (image-to-text) providers must implement this interface.
 */
export interface VisionProvider {
  readonly name: string
  /**
   * Produce a textual description of the supplied image.
   * @param imageBuffer  Already-decrypted raw image bytes.
   * @param mimeType     e.g. "image/jpeg", "image/png", "image/webp".
   * @param promptOverride  Optional per-call prompt; falls back to the provider's configured prompt.
   */
  describe(imageBuffer: Buffer, mimeType: string, promptOverride?: string): Promise<DescriptionResult>
}
