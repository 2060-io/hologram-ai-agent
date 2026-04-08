import { Injectable, Logger, OnModuleInit } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'
import { McpConfigEntity } from './mcp-config.entity'
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12
const AUTH_TAG_LENGTH = 16

/**
 * McpConfigService
 *
 * Encrypts and stores per-user MCP server configuration (e.g. tokens)
 * in PostgreSQL using AES-256-GCM. The master key is read from the
 * MCP_CONFIG_ENCRYPTION_KEY environment variable (32-byte hex string).
 */
@Injectable()
export class McpConfigService implements OnModuleInit {
  private readonly logger = new Logger(McpConfigService.name)
  private encryptionKey: Buffer | null = null

  constructor(
    @InjectRepository(McpConfigEntity)
    private readonly repo: Repository<McpConfigEntity>,
  ) {}

  onModuleInit() {
    const keyHex = process.env.MCP_CONFIG_ENCRYPTION_KEY
    if (keyHex) {
      const buf = Buffer.from(keyHex, 'hex')
      if (buf.length !== 32) {
        this.logger.error('MCP_CONFIG_ENCRYPTION_KEY must be exactly 32 bytes (64 hex chars). Per-user MCP config disabled.')
        return
      }
      this.encryptionKey = buf
      this.logger.log('Per-user MCP config encryption initialized.')
    } else {
      this.logger.warn('MCP_CONFIG_ENCRYPTION_KEY not set. Per-user MCP config will be unavailable.')
    }
  }

  /** Whether the encryption subsystem is available */
  get isAvailable(): boolean {
    return this.encryptionKey !== null
  }

  /**
   * Save (upsert) configuration for a user + server pair.
   * @param avatarName - The authenticated avatar name (user identity)
   * @param serverName - The MCP server name (e.g. "github")
   * @param config - Plain-text config object (e.g. { token: "ghp_..." })
   */
  async saveConfig(avatarName: string, serverName: string, config: Record<string, string>): Promise<void> {
    if (!this.encryptionKey) {
      throw new Error('Encryption key not configured. Cannot save MCP config.')
    }

    const plaintext = JSON.stringify(config)
    const iv = randomBytes(IV_LENGTH)
    const cipher = createCipheriv(ALGORITHM, this.encryptionKey, iv, { authTagLength: AUTH_TAG_LENGTH })

    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    const authTag = cipher.getAuthTag()

    const existing = await this.repo.findOne({ where: { avatarName, serverName } })
    if (existing) {
      existing.encryptedCfg = encrypted
      existing.iv = iv
      existing.authTag = authTag
      await this.repo.save(existing)
    } else {
      const entity = this.repo.create({
        avatarName,
        serverName,
        encryptedCfg: encrypted,
        iv,
        authTag,
      })
      await this.repo.save(entity)
    }

    this.logger.debug(`Saved MCP config for avatar="${avatarName}" server="${serverName}"`)
  }

  /**
   * Retrieve and decrypt configuration for a user + server pair.
   * Returns null if no config exists or decryption fails.
   */
  async getConfig(avatarName: string, serverName: string): Promise<Record<string, string> | null> {
    if (!this.encryptionKey) return null

    const entity = await this.repo.findOne({ where: { avatarName, serverName } })
    if (!entity) return null

    try {
      const decipher = createDecipheriv(ALGORITHM, this.encryptionKey, entity.iv, { authTagLength: AUTH_TAG_LENGTH })
      decipher.setAuthTag(entity.authTag)
      const decrypted = Buffer.concat([decipher.update(entity.encryptedCfg), decipher.final()])
      return JSON.parse(decrypted.toString('utf8'))
    } catch (err) {
      this.logger.error(`Failed to decrypt MCP config for avatar="${avatarName}" server="${serverName}": ${err}`)
      return null
    }
  }

  /**
   * Check whether a user has configured a specific MCP server.
   */
  async hasConfig(avatarName: string, serverName: string): Promise<boolean> {
    if (!this.encryptionKey) return false
    const count = await this.repo.count({ where: { avatarName, serverName } })
    return count > 0
  }

  /**
   * Delete configuration for a user + server pair.
   */
  async deleteConfig(avatarName: string, serverName: string): Promise<void> {
    await this.repo.delete({ avatarName, serverName })
    this.logger.debug(`Deleted MCP config for avatar="${avatarName}" server="${serverName}"`)
  }
}
