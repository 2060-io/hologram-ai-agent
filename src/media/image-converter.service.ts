import { Injectable, Logger } from '@nestjs/common'
import sharp from 'sharp'

export interface ConversionOptions {
  /** Target format: 'jpeg' | 'png' | 'webp'. Default: 'jpeg' */
  format?: 'jpeg' | 'png' | 'webp'
  /** Max width in pixels. Image is resized proportionally if exceeded. */
  maxWidth?: number
  /** Max height in pixels. Image is resized proportionally if exceeded. */
  maxHeight?: number
  /** Max file size in KB. If exceeded, JPEG quality is progressively reduced. */
  maxSizeKb?: number
}

export interface ConvertedImage {
  buffer: Buffer
  mimeType: string
  width: number
  height: number
}

@Injectable()
export class ImageConverterService {
  private readonly logger = new Logger(ImageConverterService.name)

  async convert(input: Buffer, options: ConversionOptions = {}): Promise<ConvertedImage> {
    const format = options.format ?? 'jpeg'
    const maxWidth = options.maxWidth ?? 4096
    const maxHeight = options.maxHeight ?? 4096
    const maxSizeKb = options.maxSizeKb ?? 5120

    let pipeline = sharp(input).resize({
      width: maxWidth,
      height: maxHeight,
      fit: 'inside',
      withoutEnlargement: true,
    })

    let quality = format === 'png' ? undefined : 90

    switch (format) {
      case 'jpeg':
        pipeline = pipeline.jpeg({ quality })
        break
      case 'png':
        pipeline = pipeline.png()
        break
      case 'webp':
        pipeline = pipeline.webp({ quality })
        break
    }

    let buffer = await pipeline.toBuffer()
    const metadata = await sharp(buffer).metadata()

    // Progressive quality reduction for JPEG/WebP if file is too large
    if (format !== 'png' && quality) {
      while (buffer.length > maxSizeKb * 1024 && quality > 20) {
        quality -= 10
        this.logger.debug(`Image too large (${Math.round(buffer.length / 1024)}KB), reducing quality to ${quality}`)
        const reducedPipeline = sharp(input)
          .resize({ width: maxWidth, height: maxHeight, fit: 'inside', withoutEnlargement: true })
        buffer = format === 'jpeg'
          ? await reducedPipeline.jpeg({ quality }).toBuffer()
          : await reducedPipeline.webp({ quality }).toBuffer()
      }
    }

    const mimeType = format === 'jpeg' ? 'image/jpeg' : format === 'png' ? 'image/png' : 'image/webp'

    this.logger.log(
      `Converted image: ${format} ${metadata.width}x${metadata.height} → ${Math.round(buffer.length / 1024)}KB`,
    )

    return {
      buffer,
      mimeType,
      width: metadata.width ?? 0,
      height: metadata.height ?? 0,
    }
  }

  /**
   * Generate a base64-encoded thumbnail for MediaMessage preview.
   * Uses 128x128 at 50% JPEG quality (Hologram convention).
   */
  async generateThumbnail(
    input: Buffer,
    options: { size?: number; quality?: number } = {},
  ): Promise<{ base64: string; mimeType: string }> {
    const size = options.size ?? 128
    const quality = options.quality ?? 50

    const buf = await sharp(input)
      .resize({ width: size, height: size, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality })
      .toBuffer()

    return {
      base64: buf.toString('base64'),
      mimeType: 'image/jpeg',
    }
  }
}
