import type { Logger } from '../../logging.js'

export type WechatAccountData = {
  botToken: string
  botId: string
  userId: string
  baseUrl: string
  savedAt: number
}

export type WechatQrLoginState = {
  qrcode: string
  qrcodeUrl: string
  createdAt: number
}

export type WechatRuntimeState = {
  updatesBuf: string
  contextTokens: Record<string, string>
  lastMessageId: number
}

export type WechatMessageItem = {
  type?: number
  msg_id?: string
  text_item?: {
    text?: string
  }
  voice_item?: {
    text?: string
  }
  file_item?: {
    file_name?: string
  }
}

export type WechatReferenceMessage = {
  message_item?: WechatMessageItem
  title?: string
}

export type WechatInboundMessage = {
  seq?: number
  message_id?: number
  from_user_id?: string
  to_user_id?: string
  client_id?: string
  create_time_ms?: number
  message_type?: number
  message_state?: number
  item_list?: WechatMessageItem[]
  ref_msg?: WechatReferenceMessage
  context_token?: string
}

export type WechatUpdatesResponse = {
  ret?: number
  errcode?: number
  errmsg?: string
  msgs?: WechatInboundMessage[]
  get_updates_buf?: string
}

export type WechatSendMessageRequest = {
  msg?: {
    from_user_id?: string
    to_user_id?: string
    client_id?: string
    message_type?: number
    message_state?: number
    item_list?: Array<{
      type?: number
      text_item?: {
        text?: string
      }
    }>
    context_token?: string
  }
}

export type WechatTypingRequest = {
  ilink_user_id?: string
  typing_ticket?: string
  status?: number
}

export type WechatQrCodeResponse = {
  qrcode: string
  qrcode_img_content: string
}

export type WechatQrStatusResponse = {
  status: 'wait' | 'scaned' | 'confirmed' | 'expired'
  bot_token?: string
  ilink_bot_id?: string
  baseurl?: string
  ilink_user_id?: string
}

export type WechatConfigResponse = {
  ret?: number
  errmsg?: string
  typing_ticket?: string
}

export type WechatApiLike = {
  fetchQRCode(apiBaseUrl: string, signal?: AbortSignal): Promise<WechatQrCodeResponse>
  pollQRStatus(
    apiBaseUrl: string,
    qrcode: string,
    signal?: AbortSignal
  ): Promise<WechatQrStatusResponse>
  getUpdates(input: {
    baseUrl: string
    token: string
    updatesBuf?: string
    timeoutMs?: number
    signal?: AbortSignal
  }): Promise<WechatUpdatesResponse>
  getConfig(input: {
    baseUrl: string
    token: string
    ilinkUserId: string
    contextToken?: string
    timeoutMs?: number
    signal?: AbortSignal
  }): Promise<WechatConfigResponse>
  sendMessage(input: {
    baseUrl: string
    token: string
    body: WechatSendMessageRequest
    timeoutMs?: number
    signal?: AbortSignal
  }): Promise<void>
  sendTyping(input: {
    baseUrl: string
    token: string
    body: WechatTypingRequest
    timeoutMs?: number
    signal?: AbortSignal
  }): Promise<void>
}

export type WechatChannelState = {
  status: 'disconnected' | 'connecting' | 'qr_ready' | 'connected' | 'error'
  accountId?: string | null
  errorMessage?: string | null
}

export interface WechatChannelOptions {
  id: string
  dataDirectoryPath: string
  logger: Logger
  apiBaseUrl?: string
  api?: WechatApiLike
  now?: () => Date
  forceLogin?: boolean
  longPollTimeoutMs?: number
  qrTtlMs?: number
  reconnectDelayMs?: number
  onQrCode?: (qrCodeValue: string) => Promise<void> | void
  onStateChange?: (state: WechatChannelState) => Promise<void> | void
}
