// 访问令牌（HS256 JWT，手写实现，与旧系统 how-api 保持二进制兼容）
import { Buffer } from 'node:buffer'
import { createHmac } from 'node:crypto'

export interface AccessTokenPayload {
  sub: number
  uid6: string
  sid: number
  iat: number
  exp: number
}

function toBase64Url(input: Buffer | string): string {
  const raw = Buffer.isBuffer(input) ? input.toString('base64') : Buffer.from(input).toString('base64')
  return raw.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function fromBase64Url(input: string): Buffer {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  return Buffer.from(padded, 'base64')
}

function safeJsonParse<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T
  }
  catch {
    return null
  }
}

export function signAccessToken(payload: AccessTokenPayload, secret: string): string {
  const header = { alg: 'HS256', typ: 'JWT' }
  const encodedHeader = toBase64Url(JSON.stringify(header))
  const encodedPayload = toBase64Url(JSON.stringify(payload))
  const message = `${encodedHeader}.${encodedPayload}`
  const signature = createHmac('sha256', secret).update(message).digest()
  return `${message}.${toBase64Url(signature)}`
}

export function verifyAccessToken(token: string, secret: string): AccessTokenPayload | null {
  const parts = token.split('.')
  if (parts.length !== 3)
    return null

  const [encodedHeader, encodedPayload, encodedSignature] = parts
  if (!encodedHeader || !encodedPayload || !encodedSignature)
    return null

  const message = `${encodedHeader}.${encodedPayload}`
  const expectedSignature = createHmac('sha256', secret).update(message).digest()
  const actualSignature = fromBase64Url(encodedSignature)

  if (actualSignature.length !== expectedSignature.length)
    return null

  let isSame = 0
  for (let i = 0; i < expectedSignature.length; i++) {
    isSame |= expectedSignature[i] ^ actualSignature[i]
  }
  if (isSame !== 0)
    return null

  const payloadRaw = fromBase64Url(encodedPayload).toString('utf8')
  const payload = safeJsonParse<AccessTokenPayload>(payloadRaw)
  if (!payload)
    return null
  if (!Number.isFinite(payload.sub) || payload.sub <= 0)
    return null
  if (!Number.isFinite(payload.sid) || payload.sid <= 0)
    return null
  if (!Number.isFinite(payload.exp) || !Number.isFinite(payload.iat))
    return null

  const nowSec = Math.floor(Date.now() / 1000)
  if (payload.exp <= nowSec)
    return null

  return payload
}
