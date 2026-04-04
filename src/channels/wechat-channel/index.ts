import type { Logger } from '../../logging.js'
import { AbstractChannel } from '../../core/abstract-channel.js'
import { formatPlainText, splitText } from '../../core/text.js'
import { defaultWechatApi } from './api-client.js'
import {
  DEFAULT_LONG_POLL_TIMEOUT_MS,
  DEFAULT_QR_TTL_MS,
  DEFAULT_RECONNECT_DELAY_MS,
  DEFAULT_WECHAT_API_BASE_URL,
  TEXT_CHUNK_LIMIT
} from './constants.js'
import { isWechatChannelAbortedError } from './errors.js'
import { toChannelMessage } from './message-utils.js'
import {
  clearWechatAccount,
  clearWechatQrState,
  loadWechatAccount,
  loadWechatQrState,
  loadWechatRuntimeState,
  resetWechatRuntimeState,
  saveWechatAccount,
  saveWechatQrState,
  saveWechatRuntimeState
} from './storage.js'
import type {
  WechatAccountData,
  WechatApiLike,
  WechatChannelOptions,
  WechatChannelState,
  WechatQrLoginState,
  WechatRuntimeState
} from './types.js'
import {
  buildContextTokenKey,
  createDefaultRuntimeState,
  createWechatClientId,
  isAuthenticationError,
  isQrFresh,
  toErrorMessage
} from './utils.js'

export type {
  WechatApiLike,
  WechatChannelOptions,
  WechatChannelState
} from './types.js'

export class WechatChannel extends AbstractChannel {
  private readonly apiBaseUrl: string
  private readonly api: WechatApiLike
  private readonly now: () => Date
  private readonly longPollTimeoutMs: number
  private readonly qrTtlMs: number
  private readonly reconnectDelayMs: number
  private readonly logger: Logger

  private started = false
  private stopping = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private activeAbortController: AbortController | null = null
  private generation = 0
  private lastPublishedState: string | null = null
  private runtimeState: WechatRuntimeState | null = null

  constructor(private readonly options: WechatChannelOptions) {
    super(options.id, 'wechat')

    this.apiBaseUrl = options.apiBaseUrl ?? DEFAULT_WECHAT_API_BASE_URL
    this.api = options.api ?? defaultWechatApi
    this.now = options.now ?? (() => new Date())
    this.longPollTimeoutMs = options.longPollTimeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS
    this.qrTtlMs = options.qrTtlMs ?? DEFAULT_QR_TTL_MS
    this.reconnectDelayMs = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS
    this.logger = options.logger.child(`wechat:${options.id}`)
  }

  async start(): Promise<void> {
    if (this.started) {
      return
    }

    this.started = true
    this.stopping = false
    this.clearReconnectTimer()
    if (this.options.forceLogin) {
      await this.clearStoredSession()
    }
    this.publishState({
      status: 'connecting',
      accountId: null,
      errorMessage: null
    })
    void this.initialize()
  }

  async stop(): Promise<void> {
    if (!this.started) {
      return
    }

    this.started = false
    this.stopping = true
    this.generation += 1
    this.clearReconnectTimer()
    this.activeAbortController?.abort()
    this.activeAbortController = null
    this.publishState({
      status: 'disconnected',
      accountId: null,
      errorMessage: null
    })
  }

  async send(remoteChatId: string, text: string): Promise<void> {
    const account = await loadWechatAccount(this.options.dataDirectoryPath)
    if (!account) {
      throw new Error('Wechat channel is not authenticated')
    }

    const runtimeState = await this.getRuntimeState()
    const contextToken = runtimeState.contextTokens[buildContextTokenKey(account.botId, remoteChatId)]

    if (!contextToken) {
      throw new Error(`No WeChat context token cached for ${remoteChatId}`)
    }

    const normalizedText = formatPlainText(text.trim())
    if (normalizedText.length === 0) {
      return
    }

    for (const segment of splitText(normalizedText, TEXT_CHUNK_LIMIT)) {
      await this.api.sendMessage({
        baseUrl: account.baseUrl,
        token: account.botToken,
        body: {
          msg: {
            from_user_id: '',
            to_user_id: remoteChatId,
            client_id: createWechatClientId(),
            message_type: 2,
            message_state: 2,
            item_list: [
              {
                type: 1,
                text_item: {
                  text: segment
                }
              }
            ],
            context_token: contextToken
          }
        }
      })
    }

    await this.sendTypingStatus({
      account,
      remoteChatId,
      contextToken,
      status: 'cancel'
    }).catch((error) => {
      if (isWechatChannelAbortedError(error)) {
        return
      }

      this.logger.warn('Failed to clear typing indicator', error)
    })
  }

  async sendTyping(remoteChatId: string): Promise<void> {
    const account = await loadWechatAccount(this.options.dataDirectoryPath)
    if (!account) {
      return
    }

    const runtimeState = await this.getRuntimeState()
    const contextToken = runtimeState.contextTokens[buildContextTokenKey(account.botId, remoteChatId)]
    await this.sendTypingStatus({
      account,
      remoteChatId,
      contextToken,
      status: 'typing'
    })
  }

  private async initialize(): Promise<void> {
    const generation = ++this.generation
    const abortController = new AbortController()
    this.activeAbortController?.abort()
    this.activeAbortController = abortController

    try {
      const account = await this.ensureAuthenticated(generation, abortController.signal)
      if (!account || !this.isGenerationActive(generation)) {
        return
      }

      await this.pollMessages(account, generation, abortController.signal)
    } catch (error) {
      if (isWechatChannelAbortedError(error) || !this.isGenerationActive(generation)) {
        return
      }

      if (isAuthenticationError(error)) {
        await this.clearStoredSession()
        this.publishState({
          status: 'disconnected',
          accountId: null,
          errorMessage: null
        })
      } else {
        const errorMessage = toErrorMessage(error)
        this.publishState({
          status: 'error',
          accountId: null,
          errorMessage
        })
        this.logger.error('Wechat channel fatal error', error)
      }

      if (this.started && !this.stopping) {
        this.scheduleReconnect()
      }
    } finally {
      if (this.activeAbortController === abortController) {
        this.activeAbortController = null
      }
    }
  }

  private async ensureAuthenticated(
    generation: number,
    signal: AbortSignal
  ): Promise<WechatAccountData | null> {
    const existingAccount = await loadWechatAccount(this.options.dataDirectoryPath)
    if (existingAccount) {
      this.publishState({
        status: 'connected',
        accountId: existingAccount.userId,
        errorMessage: null
      })
      return existingAccount
    }

    while (this.isGenerationActive(generation)) {
      const qrState = await this.ensureFreshQrState(signal)
      if (!this.isGenerationActive(generation)) {
        return null
      }

      await this.options.onQrCode?.(qrState.qrcodeUrl)
      this.publishState({
        status: 'qr_ready',
        accountId: null,
        errorMessage: null
      })

      while (this.isGenerationActive(generation)) {
        const qrStatus = await this.api.pollQRStatus(this.apiBaseUrl, qrState.qrcode, signal)
        if (!this.isGenerationActive(generation)) {
          return null
        }

        if (qrStatus.status === 'confirmed') {
          if (!qrStatus.bot_token || !qrStatus.ilink_bot_id || !qrStatus.ilink_user_id) {
            throw new Error('Wechat login confirmed but account data was incomplete')
          }

          const account: WechatAccountData = {
            botToken: qrStatus.bot_token,
            botId: qrStatus.ilink_bot_id,
            userId: qrStatus.ilink_user_id,
            baseUrl: qrStatus.baseurl ?? this.apiBaseUrl,
            savedAt: this.now().getTime()
          }

          await saveWechatAccount(this.options.dataDirectoryPath, account)
          await clearWechatQrState(this.options.dataDirectoryPath)
          this.publishState({
            status: 'connected',
            accountId: account.userId,
            errorMessage: null
          })
          return account
        }

        if (qrStatus.status === 'expired') {
          await clearWechatQrState(this.options.dataDirectoryPath)
          break
        }
      }
    }

    return null
  }

  private async ensureFreshQrState(signal: AbortSignal): Promise<WechatQrLoginState> {
    const existingQrState = await loadWechatQrState(this.options.dataDirectoryPath)
    if (existingQrState && isQrFresh(existingQrState, this.now(), this.qrTtlMs)) {
      return existingQrState
    }

    const qrResponse = await this.api.fetchQRCode(this.apiBaseUrl, signal)
    const nextState: WechatQrLoginState = {
      qrcode: qrResponse.qrcode,
      qrcodeUrl: qrResponse.qrcode_img_content,
      createdAt: this.now().getTime()
    }

    await saveWechatQrState(this.options.dataDirectoryPath, nextState)
    return nextState
  }

  private async pollMessages(
    account: WechatAccountData,
    generation: number,
    signal: AbortSignal
  ): Promise<void> {
    const runtimeState = await this.getRuntimeState()

    while (this.isGenerationActive(generation)) {
      const response = await this.api.getUpdates({
        baseUrl: account.baseUrl,
        token: account.botToken,
        updatesBuf: runtimeState.updatesBuf,
        timeoutMs: this.longPollTimeoutMs,
        signal
      })

      if (response.errcode) {
        throw new Error(
          `Wechat getupdates failed: errcode=${response.errcode} errmsg=${response.errmsg ?? 'unknown'}`
        )
      }

      if (typeof response.get_updates_buf === 'string') {
        runtimeState.updatesBuf = response.get_updates_buf
      }

      const inboundMessages =
        response.msgs?.filter(
          (message) =>
            message.message_type === 1 &&
            typeof message.message_id === 'number' &&
            message.message_id > runtimeState.lastMessageId
        ) ?? []

      if (inboundMessages.length > 0) {
        runtimeState.lastMessageId = Math.max(
          runtimeState.lastMessageId,
          ...inboundMessages.map((message) => message.message_id ?? 0)
        )

        for (const message of inboundMessages) {
          if (typeof message.from_user_id === 'string' && typeof message.context_token === 'string') {
            runtimeState.contextTokens[buildContextTokenKey(account.botId, message.from_user_id)] =
              message.context_token
          }
        }
      }

      await saveWechatRuntimeState(this.options.dataDirectoryPath, runtimeState)

      for (const message of inboundMessages) {
        if (!this.isGenerationActive(generation)) {
          return
        }

        if (typeof message.from_user_id === 'string') {
          const contextToken =
            typeof message.context_token === 'string'
              ? message.context_token
              : runtimeState.contextTokens[buildContextTokenKey(account.botId, message.from_user_id)]

          void this.sendTypingStatus({
            account,
            remoteChatId: message.from_user_id,
            contextToken,
            status: 'typing',
            signal
          }).catch((error) => {
            if (isWechatChannelAbortedError(error)) {
              return
            }

            this.logger.warn('Failed to send typing indicator', error)
          })
        }

        const normalized = toChannelMessage(message)
        if (!normalized) {
          continue
        }

        void this.emitMessage(normalized).catch((error) => {
          this.logger.error(`Failed to process inbound message ${normalized.id}`, error)
        })
      }
    }
  }

  private async sendTypingStatus(input: {
    account: WechatAccountData
    remoteChatId: string
    contextToken?: string
    status: 'typing' | 'cancel'
    signal?: AbortSignal
  }): Promise<void> {
    const remoteChatId = input.remoteChatId.trim()
    const contextToken = input.contextToken?.trim()

    if (remoteChatId.length === 0 || !contextToken) {
      return
    }

    const config = await this.api.getConfig({
      baseUrl: input.account.baseUrl,
      token: input.account.botToken,
      ilinkUserId: remoteChatId,
      contextToken,
      signal: input.signal
    })

    if (typeof config.errmsg === 'string' && config.errmsg.trim().length > 0) {
      throw new Error(`Wechat getconfig failed: ${config.errmsg}`)
    }

    const typingTicket = config.typing_ticket?.trim()
    if (!typingTicket) {
      return
    }

    await this.api.sendTyping({
      baseUrl: input.account.baseUrl,
      token: input.account.botToken,
      body: {
        ilink_user_id: remoteChatId,
        typing_ticket: typingTicket,
        status: input.status === 'typing' ? 1 : 2
      },
      signal: input.signal
    })
  }

  private async clearStoredSession(): Promise<void> {
    this.runtimeState = createDefaultRuntimeState()

    await Promise.all([
      clearWechatAccount(this.options.dataDirectoryPath),
      clearWechatQrState(this.options.dataDirectoryPath),
      resetWechatRuntimeState(this.options.dataDirectoryPath)
    ])
  }

  private async getRuntimeState(): Promise<WechatRuntimeState> {
    if (this.runtimeState) {
      return this.runtimeState
    }

    this.runtimeState = await loadWechatRuntimeState(this.options.dataDirectoryPath)
    return this.runtimeState
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer()
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.started || this.stopping) {
        return
      }

      this.publishState({
        status: 'connecting',
        accountId: null,
        errorMessage: null
      })
      void this.initialize()
    }, this.reconnectDelayMs)
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  private isGenerationActive(generation: number): boolean {
    return this.started && !this.stopping && generation === this.generation
  }

  private publishState(state: WechatChannelState): void {
    const signature = JSON.stringify(state)
    if (signature === this.lastPublishedState) {
      return
    }

    this.lastPublishedState = signature
    void this.options.onStateChange?.(state)
  }
}
