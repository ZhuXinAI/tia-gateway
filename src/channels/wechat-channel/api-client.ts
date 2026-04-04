import {
  DEFAULT_API_TIMEOUT_MS,
  DEFAULT_CONFIG_TIMEOUT_MS,
  DEFAULT_LONG_POLL_TIMEOUT_MS,
  DEFAULT_QR_POLL_TIMEOUT_MS
} from './constants.js'
import { WechatChannelAbortedError } from './errors.js'
import type {
  WechatApiLike,
  WechatConfigResponse,
  WechatQrCodeResponse,
  WechatQrStatusResponse,
  WechatSendMessageRequest,
  WechatTypingRequest,
  WechatUpdatesResponse
} from './types.js'
import {
  buildBaseInfo,
  buildHeaders,
  ensureTrailingSlash
} from './utils.js'

async function fetchJsonWithTimeout<T>(input: {
  url: string
  init?: RequestInit
  timeoutMs: number
  signal?: AbortSignal
  label: string
  onTimeout: () => T
}): Promise<T> {
  const timeoutController = new AbortController()
  const timeoutId = setTimeout(() => {
    timeoutController.abort()
  }, input.timeoutMs)
  const signal = input.signal
    ? AbortSignal.any([input.signal, timeoutController.signal])
    : timeoutController.signal

  try {
    const response = await fetch(input.url, {
      ...input.init,
      signal
    })
    clearTimeout(timeoutId)

    if (!response.ok) {
      const body = await response.text().catch(() => '(unreadable)')
      throw new Error(`${input.label} ${response.status}: ${body}`)
    }

    return (await response.json()) as T
  } catch (error) {
    clearTimeout(timeoutId)

    if (error instanceof Error && error.name === 'AbortError') {
      if (input.signal?.aborted) {
        throw new WechatChannelAbortedError()
      }

      return input.onTimeout()
    }

    throw error
  }
}

async function defaultFetchQRCode(
  apiBaseUrl: string,
  signal?: AbortSignal
): Promise<WechatQrCodeResponse> {
  const url = new URL('ilink/bot/get_bot_qrcode?bot_type=3', ensureTrailingSlash(apiBaseUrl))
  return fetchJsonWithTimeout({
    url: url.toString(),
    timeoutMs: DEFAULT_API_TIMEOUT_MS,
    signal,
    label: 'fetchQRCode',
    onTimeout: () => {
      throw new Error('fetchQRCode timed out')
    }
  })
}

async function defaultPollQRStatus(
  apiBaseUrl: string,
  qrcode: string,
  signal?: AbortSignal
): Promise<WechatQrStatusResponse> {
  const url = new URL(
    `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
    ensureTrailingSlash(apiBaseUrl)
  )

  return fetchJsonWithTimeout({
    url: url.toString(),
    timeoutMs: DEFAULT_QR_POLL_TIMEOUT_MS,
    signal,
    label: 'pollQRStatus',
    init: {
      headers: {
        'iLink-App-ClientVersion': '1'
      }
    },
    onTimeout: () => ({ status: 'wait' })
  })
}

async function postWechatApi<T>(input: {
  baseUrl: string
  endpoint: string
  body: string
  token?: string
  timeoutMs: number
  signal?: AbortSignal
  label: string
  onTimeout: () => T
}): Promise<T> {
  const url = new URL(input.endpoint, ensureTrailingSlash(input.baseUrl))

  return fetchJsonWithTimeout({
    url: url.toString(),
    timeoutMs: input.timeoutMs,
    signal: input.signal,
    label: input.label,
    init: {
      method: 'POST',
      headers: buildHeaders({
        token: input.token,
        body: input.body
      }),
      body: input.body
    },
    onTimeout: input.onTimeout
  })
}

async function postWechatText(input: {
  baseUrl: string
  endpoint: string
  body: string
  token?: string
  timeoutMs: number
  signal?: AbortSignal
  label: string
}): Promise<string> {
  const timeoutController = new AbortController()
  const timeoutId = setTimeout(() => {
    timeoutController.abort()
  }, input.timeoutMs)
  const signal = input.signal
    ? AbortSignal.any([input.signal, timeoutController.signal])
    : timeoutController.signal
  const url = new URL(input.endpoint, ensureTrailingSlash(input.baseUrl))

  try {
    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: buildHeaders({
        token: input.token,
        body: input.body
      }),
      body: input.body,
      signal
    })
    clearTimeout(timeoutId)

    const rawText = await response.text()
    if (!response.ok) {
      throw new Error(`${input.label} ${response.status}: ${rawText}`)
    }

    return rawText
  } catch (error) {
    clearTimeout(timeoutId)

    if (error instanceof Error && error.name === 'AbortError') {
      if (input.signal?.aborted) {
        throw new WechatChannelAbortedError()
      }

      throw new Error(`${input.label} timed out`)
    }

    throw error
  }
}

async function defaultGetUpdates(input: {
  baseUrl: string
  token: string
  updatesBuf?: string
  timeoutMs?: number
  signal?: AbortSignal
}): Promise<WechatUpdatesResponse> {
  return postWechatApi({
    baseUrl: input.baseUrl,
    endpoint: 'ilink/bot/getupdates',
    body: JSON.stringify({
      get_updates_buf: input.updatesBuf ?? '',
      base_info: buildBaseInfo()
    }),
    token: input.token,
    timeoutMs: input.timeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS,
    signal: input.signal,
    label: 'getUpdates',
    onTimeout: () => ({
      ret: 0,
      msgs: [],
      get_updates_buf: input.updatesBuf
    })
  })
}

async function defaultGetConfig(input: {
  baseUrl: string
  token: string
  ilinkUserId: string
  contextToken?: string
  timeoutMs?: number
  signal?: AbortSignal
}): Promise<WechatConfigResponse> {
  return postWechatApi({
    baseUrl: input.baseUrl,
    endpoint: 'ilink/bot/getconfig',
    body: JSON.stringify({
      ilink_user_id: input.ilinkUserId,
      context_token: input.contextToken,
      base_info: buildBaseInfo()
    }),
    token: input.token,
    timeoutMs: input.timeoutMs ?? DEFAULT_CONFIG_TIMEOUT_MS,
    signal: input.signal,
    label: 'getConfig',
    onTimeout: () => {
      throw new Error('getConfig timed out')
    }
  })
}

async function defaultSendMessage(input: {
  baseUrl: string
  token: string
  body: WechatSendMessageRequest
  timeoutMs?: number
  signal?: AbortSignal
}): Promise<void> {
  await postWechatText({
    baseUrl: input.baseUrl,
    endpoint: 'ilink/bot/sendmessage',
    body: JSON.stringify({
      ...input.body,
      base_info: buildBaseInfo()
    }),
    token: input.token,
    timeoutMs: input.timeoutMs ?? DEFAULT_API_TIMEOUT_MS,
    signal: input.signal,
    label: 'sendMessage'
  })
}

async function defaultSendTyping(input: {
  baseUrl: string
  token: string
  body: WechatTypingRequest
  timeoutMs?: number
  signal?: AbortSignal
}): Promise<void> {
  await postWechatText({
    baseUrl: input.baseUrl,
    endpoint: 'ilink/bot/sendtyping',
    body: JSON.stringify({
      ...input.body,
      base_info: buildBaseInfo()
    }),
    token: input.token,
    timeoutMs: input.timeoutMs ?? DEFAULT_CONFIG_TIMEOUT_MS,
    signal: input.signal,
    label: 'sendTyping'
  })
}

export const defaultWechatApi: WechatApiLike = {
  fetchQRCode: defaultFetchQRCode,
  pollQRStatus: defaultPollQRStatus,
  getUpdates: defaultGetUpdates,
  getConfig: defaultGetConfig,
  sendMessage: defaultSendMessage,
  sendTyping: defaultSendTyping
}
