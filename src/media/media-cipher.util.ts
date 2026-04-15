import { randomBytes, createCipheriv } from 'crypto'

export interface CipheringInfo {
  algorithm: string
  parameters: Record<string, unknown>
}

/**
 * Encrypts a buffer using AES-256-CBC with random key and IV.
 * Returns the encrypted buffer and the ciphering metadata
 * (to be included in the MediaItem so the recipient can decrypt).
 */
export function encryptBuffer(plainBuffer: Buffer): {
  encrypted: Buffer
  ciphering: CipheringInfo
} {
  const key = randomBytes(32)
  const iv = randomBytes(16)

  const cipher = createCipheriv('aes-256-cbc', key, iv)
  const encrypted = Buffer.concat([cipher.update(plainBuffer), cipher.final()])

  return {
    encrypted,
    ciphering: {
      algorithm: 'aes-256-cbc',
      parameters: {
        key: key.toString('hex'),
        iv: iv.toString('hex'),
      },
    },
  }
}
