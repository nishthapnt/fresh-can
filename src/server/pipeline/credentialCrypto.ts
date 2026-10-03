import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

// AES-256-GCM for api_credentials.encrypted_value. Server-only: the key comes
// from CREDENTIALS_ENCRYPTION_KEY (32 random bytes, base64) and must never be
// NEXT_PUBLIC_-prefixed or sent to the browser.
//
// Payload format: "v1.<iv>.<tag>.<ciphertext>" (each base64). `context`
// (the provider id) is bound as GCM additional authenticated data, so a
// ciphertext copied from one provider's row into another's fails to decrypt.

const VERSION = 'v1'
const IV_BYTES = 12

export type CredentialCryptoErrorCode = 'not_configured' | 'bad_key' | 'bad_payload' | 'decrypt_failed'

/** Never carries key material or plaintext in its message. */
export class CredentialCryptoError extends Error {
  constructor(public readonly code: CredentialCryptoErrorCode) {
    super(`Credential crypto error: ${code}`)
    this.name = 'CredentialCryptoError'
  }
}

function loadKey(keyOverride?: string): Buffer {
  const raw = keyOverride ?? process.env.CREDENTIALS_ENCRYPTION_KEY
  if (!raw) throw new CredentialCryptoError('not_configured')
  const key = Buffer.from(raw.trim(), 'base64')
  if (key.length !== 32) throw new CredentialCryptoError('bad_key')
  return key
}

export function isEncryptionConfigured(): boolean {
  try {
    loadKey()
    return true
  } catch {
    return false
  }
}

export function encryptSecret(plaintext: string, context: string, keyOverride?: string): string {
  const key = loadKey(keyOverride)
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(context, 'utf8'))
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [VERSION, iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join('.')
}

export function decryptSecret(payload: string, context: string, keyOverride?: string): string {
  const key = loadKey(keyOverride)
  const parts = payload.split('.')
  if (parts.length !== 4 || parts[0] !== VERSION) throw new CredentialCryptoError('bad_payload')
  try {
    const iv = Buffer.from(parts[1], 'base64')
    const tag = Buffer.from(parts[2], 'base64')
    const ciphertext = Buffer.from(parts[3], 'base64')
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAAD(Buffer.from(context, 'utf8'))
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
  } catch {
    throw new CredentialCryptoError('decrypt_failed')
  }
}
