import { randomBytes } from 'node:crypto'
import { CHANNEL_VERSION } from './constants.js'
import type {
  WechatQrLoginState,
  WechatRuntimeState
} from './types.js'

export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return typeof error === 'string' ? error : 'Unknown error'
}

export function isAuthenticationError(error: unknown): boolean {
  const message = toErrorMessage(error).toLowerCase()
  return (
    message.includes(' 401:') ||
    message.includes(' 403:') ||
    message.includes('unauthorized') ||
    message.includes('forbidden')
  )
}

export function ensureTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`
}

export function buildBaseInfo(): { channel_version: string } {
  return {
    channel_version: CHANNEL_VERSION
  }
}

function randomWechatUin(): string {
  const uint32 = randomBytes(4).readUInt32BE(0)
  return Buffer.from(String(uint32), 'utf-8').toString('base64')
}

export function buildHeaders(input: { token?: string; body: string }): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'Content-Length': String(Buffer.byteLength(input.body, 'utf-8')),
    'X-WECHAT-UIN': randomWechatUin()
  }

  if (input.token?.trim()) {
    headers.Authorization = `Bearer ${input.token.trim()}`
  }

  return headers
}

export function createDefaultRuntimeState(): WechatRuntimeState {
  return {
    updatesBuf: '',
    contextTokens: {},
    lastMessageId: 0
  }
}

export function buildContextTokenKey(botId: string, userId: string): string {
  return `${botId}:${userId}`
}

export function isQrFresh(qrState: WechatQrLoginState, now: Date, qrTtlMs: number): boolean {
  return now.getTime() - qrState.createdAt < qrTtlMs
}

export function createWechatClientId(): string {
  return `wechat:${Date.now()}-${randomBytes(4).toString('hex')}`
}
