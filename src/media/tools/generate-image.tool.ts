import { z } from 'zod'
import { DynamicStructuredTool } from '@langchain/core/tools'
import { Logger } from '@nestjs/common'
import type { ImageGenerationService } from '../image-generation.service'

const logger = new Logger('GenerateImageTool')
const ToolCtor = DynamicStructuredTool as unknown as new (fields: any) => DynamicStructuredTool

/**
 * Creates a LangChain DynamicStructuredTool for image generation.
 * The LLM decides which provider and target specs to use based on context.
 */
export function createGenerateImageTool(imageGenService: ImageGenerationService): DynamicStructuredTool {
  const providerNames = imageGenService.getProviderNames()

  return new ToolCtor({
    name: 'generate_image',
    description:
      `Generate images using an AI image provider. Available providers: [${providerNames.join(', ')}]. ` +
      `The generated images are converted to the target format/size, stored, and sent to the user as a preview. ` +
      `Returns reference IDs (refId) that can be passed to upload_media_to_mcp to upload the converted image to an external service. ` +
      `You MUST specify target_format and target dimensions based on the requirements of the MCP tool that will receive the image ` +
      `(e.g. for X/Twitter: jpeg, max 1200x675, max 5120KB).`,
    schema: z.object({
      provider: z.string().describe(`Image generation provider name. One of: ${providerNames.join(', ')}`),
      prompt: z.string().describe('Text prompt describing the image to generate'),
      n: z.number().int().min(1).max(4).optional().describe('Number of images to generate (1-4, default 1)'),
      size: z.string().optional().describe('Size hint for the provider (e.g. "1024x1024"). Provider-specific.'),
      target_format: z
        .enum(['jpeg', 'png', 'webp'])
        .optional()
        .describe('Target image format after conversion (default: jpeg)'),
      target_max_width: z.number().int().optional().describe('Max width in pixels after conversion'),
      target_max_height: z.number().int().optional().describe('Max height in pixels after conversion'),
      target_max_size_kb: z.number().int().optional().describe('Max file size in KB after conversion (default: 5120)'),
    }),
    func: async (args) => {
      try {
        logger.log(`generate_image called: provider=${args.provider}, prompt="${args.prompt}", n=${args.n ?? 1}`)

        const results = await imageGenService.generate({
          provider: args.provider,
          prompt: args.prompt,
          n: args.n,
          size: args.size,
          targetFormat: args.target_format,
          targetMaxWidth: args.target_max_width,
          targetMaxHeight: args.target_max_height,
          targetMaxSizeKb: args.target_max_size_kb,
        })

        const response = {
          status: 'ok',
          images: results.map((r) => ({
            refId: r.refId,
          })),
          message:
            `Done. ${results.length} image(s) have already been delivered to the user — do NOT call generate_image again for this request. ` +
            `If the user wants to upload an image to an external service, use upload_media_to_mcp with the refId.`,
        }

        return JSON.stringify(response)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.error(`generate_image failed: ${msg}`)
        return JSON.stringify({ status: 'error', message: msg })
      }
    },
  })
}
