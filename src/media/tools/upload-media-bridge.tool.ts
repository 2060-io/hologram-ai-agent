import { z } from 'zod'
import { DynamicStructuredTool } from '@langchain/core/tools'
import { Logger } from '@nestjs/common'
import type { ImageRefStore } from '../image-ref.store'
import type { McpService } from '../../mcp/mcp.service'

const logger = new Logger('UploadMediaBridgeTool')
const ToolCtor = DynamicStructuredTool as unknown as new (fields: any) => DynamicStructuredTool

/**
 * Creates a LangChain DynamicStructuredTool that bridges image refs to MCP upload tools.
 * Retrieves the converted image buffer from the ref store, converts to base64,
 * and calls the MCP tool internally — keeping large binary data out of the LLM context.
 */
export function createUploadMediaBridgeTool(
  refStore: ImageRefStore,
  mcpService: McpService,
): DynamicStructuredTool {
  return new ToolCtor({
    name: 'upload_media_to_mcp',
    description:
      'Upload a previously generated image (by refId from generate_image) to an MCP server\'s media upload tool. ' +
      'This tool handles the base64 encoding and MCP call internally, so no binary data passes through the conversation. ' +
      'Returns the result from the MCP tool (e.g. a media_id for attaching to posts).',
    schema: z.object({
      ref_id: z.string().describe('The refId returned by generate_image for the image to upload'),
      server: z.string().describe('MCP server name (e.g. "x-mcp")'),
      tool: z.string().describe('MCP tool name for media upload (e.g. "upload_media")'),
      extra_args: z.record(z.string()).optional().describe(
        'Additional arguments to pass to the MCP tool besides the base64 data ' +
        '(e.g. {"mime_type": "image/jpeg", "media_category": "tweet_image"})',
      ),
    }),
    func: async (args) => {
      try {
        const ref = refStore.get(args.ref_id)
        if (!ref) {
          return JSON.stringify({
            status: 'error',
            message: `Image ref "${args.ref_id}" not found or expired. Generate a new image first.`,
          })
        }

        logger.log(
          `upload_media_to_mcp: refId=${args.ref_id} → server="${args.server}" tool="${args.tool}" ` +
          `(${Math.round(ref.buffer.length / 1024)}KB, ${ref.mimeType})`,
        )

        // Build MCP tool arguments: base64 data + mime_type + any extra args
        const mcpArgs: Record<string, unknown> = {
          media_data: ref.buffer.toString('base64'),
          mime_type: ref.mimeType,
          ...(args.extra_args ?? {}),
        }

        // Call the MCP tool directly (bypasses LLM context for binary data)
        const result = await mcpService.callTool(args.server, args.tool, mcpArgs, true)

        logger.log(`upload_media_to_mcp result: ${result.slice(0, 300)}`)

        return result
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.error(`upload_media_to_mcp failed: ${msg}`)
        return JSON.stringify({ status: 'error', message: msg })
      }
    },
  })
}
