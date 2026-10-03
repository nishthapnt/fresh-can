import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { CredentialCryptoError, decryptSecret, encryptSecret } from './credentialCrypto'

const KEY = randomBytes(32).toString('base64')
const OTHER_KEY = randomBytes(32).toString('base64')

describe('credentialCrypto', () => {
  it('round-trips and never stores the plaintext', () => {
    const payload = encryptSecret('sk-secret-1234', 'openai', KEY)
    expect(payload).not.toContain('sk-secret-1234')
    expect(decryptSecret(payload, 'openai', KEY)).toBe('sk-secret-1234')
  })

  it('uses a fresh IV each time', () => {
    expect(encryptSecret('x'.repeat(10), 'kie', KEY)).not.toBe(encryptSecret('x'.repeat(10), 'kie', KEY))
  })

  it('fails with the wrong encryption key', () => {
    const payload = encryptSecret('sk-secret-1234', 'openai', KEY)
    expect(() => decryptSecret(payload, 'openai', OTHER_KEY)).toThrow(CredentialCryptoError)
  })

  it('fails on tampered ciphertext', () => {
    const [v, iv, tag, ct] = encryptSecret('sk-secret-1234', 'openai', KEY).split('.')
    const flipped = Buffer.from(ct, 'base64')
    flipped[0] ^= 0xff
    expect(() => decryptSecret([v, iv, tag, flipped.toString('base64')].join('.'), 'openai', KEY)).toThrow(
      CredentialCryptoError,
    )
  })

  it('fails when a ciphertext is moved to another provider (AAD binding)', () => {
    const payload = encryptSecret('sk-secret-1234', 'openai', KEY)
    expect(() => decryptSecret(payload, 'kie', KEY)).toThrow(CredentialCryptoError)
  })

  it('rejects a missing or malformed encryption key without leaking it', () => {
    expect(() => encryptSecret('v', 'openai', 'not-32-bytes')).toThrow('bad_key')
  })

  it('rejects malformed payloads', () => {
    expect(() => decryptSecret('garbage', 'openai', KEY)).toThrow('bad_payload')
  })
})
