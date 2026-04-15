import { Injectable, Logger, OnModuleInit } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import * as Minio from 'minio'

@Injectable()
export class MediaStoreService implements OnModuleInit {
  private readonly logger = new Logger(MediaStoreService.name)
  private client: Minio.Client | null = null
  private publicClient: Minio.Client | null = null
  private bucket: string
  private enabled = false

  private static readonly PRESIGNED_EXPIRY_SECONDS = 24 * 60 * 60

  constructor(private readonly config: ConfigService) {
    this.bucket = process.env.MINIO_BUCKET || 'image-gen'
  }

  async onModuleInit() {
    const endpoint = process.env.MINIO_ENDPOINT
    if (!endpoint) {
      this.logger.log('MinIO not configured (MINIO_ENDPOINT missing). Media store disabled.')
      return
    }

    const port = parseInt(process.env.MINIO_PORT || '9000', 10)
    const accessKey = process.env.MINIO_ACCESS_KEY || 'minioadmin'
    const secretKey = process.env.MINIO_SECRET_KEY || 'minioadmin'
    const useSSL = process.env.MINIO_USE_SSL === 'true'
    const publicUrl = process.env.MINIO_PUBLIC_URL || `http://${endpoint}:${port}`

    try {
      this.client = new Minio.Client({
        endPoint: endpoint,
        port,
        useSSL,
        accessKey,
        secretKey,
      })

      // Public client for presigned URL generation (HMAC signature includes the host)
      const pub = new URL(publicUrl)
      const pubPort = pub.port ? parseInt(pub.port, 10) : pub.protocol === 'https:' ? 443 : 80
      this.publicClient = new Minio.Client({
        endPoint: pub.hostname,
        port: pubPort,
        useSSL: pub.protocol === 'https:',
        accessKey,
        secretKey,
      })

      await this.ensureBucket()
      this.enabled = true
      this.logger.log(`MinIO media store initialized: bucket="${this.bucket}", publicUrl="${publicUrl}"`)
    } catch (err) {
      this.logger.error(`Failed to initialize MinIO media store: ${err}`)
    }
  }

  get isEnabled(): boolean {
    return this.enabled
  }

  /**
   * Upload a buffer to MinIO and return a presigned GET URL (24h TTL).
   */
  async upload(objectName: string, buffer: Buffer, mimeType: string): Promise<string> {
    if (!this.client || !this.publicClient) {
      throw new Error('MinIO media store is not initialized.')
    }

    await this.client.putObject(this.bucket, objectName, buffer, buffer.length, {
      'Content-Type': mimeType,
    })

    const url = await this.publicClient.presignedGetObject(
      this.bucket,
      objectName,
      MediaStoreService.PRESIGNED_EXPIRY_SECONDS,
    )

    this.logger.debug(`Uploaded ${objectName} (${Math.round(buffer.length / 1024)}KB) → presigned URL generated`)
    return url
  }

  /**
   * Download a file from a URL and return the buffer + mime type.
   */
  async downloadFromUrl(url: string): Promise<{ buffer: Buffer; mimeType: string }> {
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`Failed to download media from ${url}: ${response.status}`)
    }
    const mimeType = response.headers.get('content-type') || 'application/octet-stream'
    const arrayBuffer = await response.arrayBuffer()
    return { buffer: Buffer.from(arrayBuffer), mimeType }
  }

  private async ensureBucket(): Promise<void> {
    if (!this.client) return
    const exists = await this.client.bucketExists(this.bucket)
    if (!exists) {
      await this.client.makeBucket(this.bucket)
      const lifecycleConfig = {
        Rule: [
          {
            ID: 'expire-after-24h',
            Status: 'Enabled',
            Expiration: { Days: 1 },
          },
        ],
      }
      await this.client.setBucketLifecycle(this.bucket, lifecycleConfig)
      this.logger.log(`Created bucket "${this.bucket}" with 24h expiry lifecycle rule`)
    }
  }
}
