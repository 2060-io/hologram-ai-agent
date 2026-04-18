import OpenAI from 'openai'
import type { DescriptionResult, VisionProvider, VisionProviderConfig } from './vision-provider.interface'

const DEFAULT_PROMPT =
  'Describe this image concisely but completely for an AI agent that will use ' +
  'your description to respond to the user. Include: subject, setting, notable ' +
  'objects, actions, any visible text, and mood. Do not add commentary or ' +
  'interpretation beyond description. Keep it under 200 words.'

/**
 * Vision provider backed by OpenAI chat completions with image inputs
 * (`image_url` content block). Also works with any OpenAI-compatible endpoint
 * that accepts multimodal chat messages (set `baseUrl`).
 */
export class OpenAiVisionProvider implements VisionProvider {
  readonly name: string
  private readonly client: OpenAI
  private readonly model: string
  private readonly prompt: string
  private readonly maxTokens: number
  private readonly detail: 'low' | 'high' | 'auto'
  private readonly language?: string

  constructor(config: VisionProviderConfig) {
    this.name = config.name
    this.model = config.model ?? 'gpt-4o-mini'
    this.prompt = config.prompt ?? DEFAULT_PROMPT
    this.maxTokens = config.maxTokens ?? 500
    this.detail = config.detail ?? 'auto'
    this.language = config.language || undefined

    const apiKey = config.apiKeyEnv ? process.env[config.apiKeyEnv] : process.env.OPENAI_API_KEY
    if (!apiKey && !config.baseUrl) {
      throw new Error(
        `OpenAiVisionProvider "${config.name}": missing API key. ` +
          `Set ${config.apiKeyEnv ?? 'OPENAI_API_KEY'} in the environment.`,
      )
    }

    this.client = new OpenAI({
      apiKey: apiKey || 'not-needed',
      ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
    })
  }

  async describe(imageBuffer: Buffer, mimeType: string, promptOverride?: string): Promise<DescriptionResult> {
    const dataUrl = `data:${mimeType};base64,${imageBuffer.toString('base64')}`
    const instruction =
      (promptOverride?.trim() || this.prompt) +
      (this.language ? `\n\nRespond in language: ${this.language}.` : '')

    const response = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: this.maxTokens,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: instruction },
            { type: 'image_url', image_url: { url: dataUrl, detail: this.detail } },
          ],
        },
      ],
    })

    const text = response.choices?.[0]?.message?.content ?? ''
    return {
      text: typeof text === 'string' ? text : JSON.stringify(text),
      model: response.model,
    }
  }
}
