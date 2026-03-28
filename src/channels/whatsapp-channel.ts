import { rm } from 'node:fs/promises'
import {
  DisconnectReason,
  getContentType,
  isJidBroadcast,
  isJidGroup,
  jidDecode,
  jidNormalizedUser,
  makeWASocket,
  normalizeMessageContent,
  useMultiFileAuthState as createMultiFileAuthState,
  type ConnectionState,
  type WAMessage,
  type WASocket
} from '@whiskeysockets/baileys'
import type { Logger } from '../logging.js'
import { AbstractChannel } from '../core/abstract-channel.js'
import type { ChannelMessage } from '../core/types.js'

const DEFAULT_RECONNECT_DELAY_MS = 1_000
const WHATSAPP_WEB_VERSION: [number, number, number] = [2, 3000, 1033893291]

type WhatsAppInboundTextMessage = {
  id: string
  chatId: string
  isGroup: boolean
  senderId: string
  senderDisplayName: string
  mentionedJids: string[]
  text: string
  timestamp: Date
}

type WhatsAppConnectionUpdate =
  | { status: 'connecting' }
  | { status: 'qr_ready'; qrCodeValue: string }
  | { status: 'connected'; phoneNumber: string | null; botJid: string | null }
  | { status: 'disconnected'; errorMessage: string | null; disconnectReason: number | null }
  | { status: 'error'; errorMessage: string }

type WhatsAppClientLike = {
  onConnectionUpdate(handler: (update: WhatsAppConnectionUpdate) => Promise<void> | void): void
  onText(handler: (message: WhatsAppInboundTextMessage) => Promise<void>): void
  connect(): Promise<void>
  disconnect(reason?: string): Promise<void>
  sendMessage(chatId: string, text: string): Promise<void>
  resetAuthState(): Promise<void>
}

export type WhatsAppChannelState = {
  status: 'disconnected' | 'connecting' | 'qr_ready' | 'connected' | 'error'
  qrCodeValue?: string | null
  phoneNumber?: string | null
  errorMessage?: string | null
}

export interface WhatsAppChannelOptions {
  id: string
  authDirectoryPath: string
  logger: Logger
  forceLogin?: boolean
  groupRequireMention?: boolean
  reconnectDelayMs?: number
  clientFactory?: (authDirectoryPath: string) => Promise<WhatsAppClientLike>
  onQrCode?: (value: string) => Promise<void> | void
  onStateChange?: (state: WhatsAppChannelState) => Promise<void> | void
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return typeof error === 'string' ? error : 'Unknown error'
}

function resolveDisconnectReason(error: unknown): number | null {
  const statusCode =
    error &&
    typeof error === 'object' &&
    'output' in error &&
    error.output &&
    typeof error.output === 'object' &&
    'statusCode' in error.output
      ? Number(error.output.statusCode)
      : Number.NaN

  return Number.isFinite(statusCode) ? statusCode : null
}

function resolvePhoneNumber(jid: string | undefined): string | null {
  const decoded = jidDecode(jid)
  return typeof decoded?.user === 'string' && decoded.user.trim().length > 0 ? decoded.user : null
}

function resolveTimestamp(value: unknown): Date {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value * 1000)
  }

  if (typeof value === 'bigint') {
    return new Date(Number(value) * 1000)
  }

  if (value && typeof value === 'object' && 'toString' in value) {
    const numericValue = Number(String(value))
    if (Number.isFinite(numericValue)) {
      return new Date(numericValue * 1000)
    }
  }

  return new Date()
}

function buildSenderDisplayName(message: WAMessage, senderId: string): string {
  const pushName = typeof message.pushName === 'string' ? message.pushName.trim() : ''
  if (pushName.length > 0) {
    return pushName
  }

  return resolvePhoneNumber(senderId) ?? senderId
}

function normalizeInboundTextMessage(message: WAMessage): WhatsAppInboundTextMessage | null {
  if (message.key.fromMe) {
    return null
  }

  const chatId = message.key.remoteJid
  if (!chatId || isJidBroadcast(chatId)) {
    return null
  }

  const isGroup = Boolean(isJidGroup(chatId))
  const normalizedContent = normalizeMessageContent(message.message)
  const contentType = getContentType(normalizedContent)
  const text =
    contentType === 'conversation'
      ? normalizedContent?.conversation
      : contentType === 'extendedTextMessage'
        ? normalizedContent?.extendedTextMessage?.text
        : null

  if (typeof text !== 'string') {
    return null
  }

  const trimmedText = text.trim()
  if (trimmedText.length === 0) {
    return null
  }

  const senderId = jidNormalizedUser(message.key.participant ?? chatId)
  const mentionedJids =
    contentType === 'extendedTextMessage' &&
    Array.isArray(normalizedContent?.extendedTextMessage?.contextInfo?.mentionedJid)
      ? normalizedContent.extendedTextMessage.contextInfo.mentionedJid
          .filter((jid): jid is string => typeof jid === 'string' && jid.length > 0)
          .map((jid) => jidNormalizedUser(jid))
      : []

  return {
    id: message.key.id ?? `${chatId}:${String(message.messageTimestamp ?? Date.now())}`,
    chatId,
    isGroup,
    senderId,
    senderDisplayName: buildSenderDisplayName(message, senderId),
    mentionedJids,
    text: trimmedText,
    timestamp: resolveTimestamp(message.messageTimestamp)
  }
}

async function createWhatsAppClient(authDirectoryPath: string): Promise<WhatsAppClientLike> {
  let socket: WASocket | null = null
  let handleConnectionUpdate: (update: WhatsAppConnectionUpdate) => Promise<void> | void = () =>
    undefined
  let handleText: (message: WhatsAppInboundTextMessage) => Promise<void> = async () => undefined

  return {
    onConnectionUpdate(handler) {
      handleConnectionUpdate = handler
    },
    onText(handler) {
      handleText = handler
    },
    async connect() {
      const { state, saveCreds } = await createMultiFileAuthState(authDirectoryPath)
      socket = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        version: WHATSAPP_WEB_VERSION
      })

      socket.ev.on('creds.update', () => {
        void saveCreds()
      })
      socket.ev.on('connection.update', (update: Partial<ConnectionState>) => {
        void (async () => {
          if (update.qr) {
            await handleConnectionUpdate({
              status: 'qr_ready',
              qrCodeValue: update.qr
            })
            return
          }

          if (update.connection === 'connecting') {
            await handleConnectionUpdate({ status: 'connecting' })
            return
          }

          if (update.connection === 'open') {
            await handleConnectionUpdate({
              status: 'connected',
              phoneNumber: resolvePhoneNumber(socket?.user?.id),
              botJid:
                typeof socket?.user?.id === 'string' ? jidNormalizedUser(socket.user.id) : null
            })
            return
          }

          if (update.connection === 'close') {
            await handleConnectionUpdate({
              status: 'disconnected',
              errorMessage: toErrorMessage(update.lastDisconnect?.error),
              disconnectReason: resolveDisconnectReason(update.lastDisconnect?.error)
            })
          }
        })()
      })
      socket.ev.on('messages.upsert', ({ messages }) => {
        for (const message of messages) {
          const normalized = normalizeInboundTextMessage(message)
          if (!normalized) {
            continue
          }

          void handleText(normalized)
        }
      })
    },
    async disconnect(reason) {
      socket?.end(reason ? new Error(reason) : undefined)
      socket = null
    },
    async sendMessage(chatId, text) {
      if (!socket) {
        throw new Error('WhatsApp channel is not connected')
      }

      await socket.sendMessage(chatId, { text })
    },
    async resetAuthState() {
      socket?.end(new Error('whatsapp-auth-reset'))
      socket = null
      await rm(authDirectoryPath, { recursive: true, force: true })
    }
  }
}

export class WhatsAppChannel extends AbstractChannel {
  private readonly clientFactory: (authDirectoryPath: string) => Promise<WhatsAppClientLike>
  private readonly logger: Logger
  private readonly groupRequireMention: boolean
  private readonly reconnectDelayMs: number
  private readonly onQrCode?: (value: string) => Promise<void> | void
  private readonly onStateChange?: (state: WhatsAppChannelState) => Promise<void> | void
  private readonly botMentionJids = new Set<string>()
  private client: WhatsAppClientLike | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private started = false
  private stopping = false
  private generation = 0
  private forceLoginPending: boolean

  constructor(private readonly options: WhatsAppChannelOptions) {
    super(options.id, 'whatsapp')

    this.clientFactory = options.clientFactory ?? createWhatsAppClient
    this.logger = options.logger.child(`whatsapp:${options.id}`)
    this.groupRequireMention = options.groupRequireMention ?? true
    this.reconnectDelayMs = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS
    this.onQrCode = options.onQrCode
    this.onStateChange = options.onStateChange
    this.forceLoginPending = options.forceLogin ?? false
  }

  async start(): Promise<void> {
    if (this.started) {
      return
    }

    this.started = true
    this.stopping = false
    await this.emitState({
      status: 'connecting',
      qrCodeValue: null,
      phoneNumber: null,
      errorMessage: null
    })
    void this.initializeClient(this.forceLoginPending)
    this.forceLoginPending = false
  }

  async stop(): Promise<void> {
    if (!this.started) {
      return
    }

    this.started = false
    this.stopping = true
    this.botMentionJids.clear()

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    const activeClient = this.client
    this.client = null
    this.generation += 1

    if (activeClient) {
      await activeClient.disconnect('whatsapp-channel-stopped')
    }

    await this.emitState({
      status: 'disconnected',
      qrCodeValue: null,
      phoneNumber: null,
      errorMessage: null
    })
  }

  async send(remoteChatId: string, text: string): Promise<void> {
    if (!this.client) {
      throw new Error('WhatsApp channel is not connected')
    }

    await this.client.sendMessage(remoteChatId, text)
  }

  private async initializeClient(resetAuthState: boolean): Promise<void> {
    const generation = ++this.generation

    try {
      const client = await this.clientFactory(this.options.authDirectoryPath)
      if (!this.started || this.stopping || generation !== this.generation) {
        await client.disconnect('whatsapp-channel-stale')
        return
      }

      this.client = client
      client.onConnectionUpdate((update) => this.handleConnectionUpdate(update, generation))
      client.onText(async (message) => {
        if (generation !== this.generation || this.stopping) {
          return
        }

        await this.handleInboundMessage(message)
      })

      if (resetAuthState) {
        await client.resetAuthState()
      }

      await client.connect()
    } catch (error) {
      this.logger.error('WhatsApp channel failed to initialize', error)
      await this.emitState({
        status: 'error',
        qrCodeValue: null,
        phoneNumber: null,
        errorMessage: toErrorMessage(error)
      })
      if (!this.stopping && this.started) {
        this.scheduleReconnect()
      }
    }
  }

  private async handleConnectionUpdate(
    update: WhatsAppConnectionUpdate,
    generation: number
  ): Promise<void> {
    if (generation !== this.generation || this.stopping) {
      return
    }

    if (update.status === 'connecting') {
      await this.emitState({
        status: 'connecting',
        qrCodeValue: null,
        phoneNumber: null,
        errorMessage: null
      })
      return
    }

    if (update.status === 'qr_ready') {
      await this.onQrCode?.(update.qrCodeValue)
      await this.emitState({
        status: 'qr_ready',
        qrCodeValue: update.qrCodeValue,
        phoneNumber: null,
        errorMessage: null
      })
      return
    }

    if (update.status === 'connected') {
      this.botMentionJids.clear()
      for (const jid of [
        update.botJid,
        update.phoneNumber ? `${update.phoneNumber}@s.whatsapp.net` : null
      ]) {
        if (typeof jid === 'string' && jid.length > 0) {
          this.botMentionJids.add(jidNormalizedUser(jid))
        }
      }

      await this.emitState({
        status: 'connected',
        qrCodeValue: null,
        phoneNumber: update.phoneNumber,
        errorMessage: null
      })
      return
    }

    if (update.status === 'error') {
      this.logger.error(`WhatsApp channel reported an error: ${update.errorMessage}`)
      await this.emitState({
        status: 'error',
        qrCodeValue: null,
        phoneNumber: null,
        errorMessage: update.errorMessage
      })
      return
    }

    this.botMentionJids.clear()
    await this.emitState({
      status: 'disconnected',
      qrCodeValue: null,
      phoneNumber: null,
      errorMessage: update.errorMessage
    })

    if (!this.started || this.stopping) {
      return
    }

    const activeClient = this.client
    this.client = null

    if (update.disconnectReason === DisconnectReason.loggedOut && activeClient) {
      await activeClient.resetAuthState()
    }

    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.started || this.stopping) {
        return
      }

      void this.emitState({
        status: 'connecting',
        qrCodeValue: null,
        phoneNumber: null,
        errorMessage: null
      })
      void this.initializeClient(false)
    }, this.reconnectDelayMs)
  }

  private async handleInboundMessage(message: WhatsAppInboundTextMessage): Promise<void> {
    if (message.isGroup && this.groupRequireMention && !this.isBotMentioned(message)) {
      return
    }

    const normalized: ChannelMessage = {
      id: message.id,
      remoteChatId: message.chatId,
      senderId: message.senderId,
      text: message.text,
      timestamp: message.timestamp,
      metadata: {
        whatsappChatId: message.chatId,
        whatsappChatType: message.isGroup ? 'group' : 'direct',
        whatsappIsBotMentioned: message.isGroup ? this.isBotMentioned(message) : true,
        whatsappMessageId: message.id,
        whatsappPhoneNumber: resolvePhoneNumber(message.senderId),
        whatsappDisplayName: message.senderDisplayName
      }
    }

    void this.emitMessage(normalized).catch((error) => {
      this.logger.error(`Failed to process inbound message ${normalized.id}`, error)
    })
  }

  private isBotMentioned(message: WhatsAppInboundTextMessage): boolean {
    if (message.mentionedJids.length === 0) {
      return false
    }

    if (this.botMentionJids.size === 0) {
      return true
    }

    return message.mentionedJids.some((jid) => this.botMentionJids.has(jidNormalizedUser(jid)))
  }

  private async emitState(state: WhatsAppChannelState): Promise<void> {
    await this.onStateChange?.(state)
  }
}
