import { Telegraf } from 'telegraf'
import { message } from 'telegraf/filters'
import type { Logger } from '../logging.js'
import { AbstractChannel } from '../core/abstract-channel.js'
import type { ChannelMessage } from '../core/types.js'

type TelegramInboundTextMessage = {
  id: string
  chatId: string
  chatType: string
  senderId: string
  senderUsername: string | null
  senderDisplayName: string
  text: string
  timestamp: Date
}

type TelegramClientLike = {
  onText(handler: (message: TelegramInboundTextMessage) => Promise<void>): void
  launch(): Promise<void>
  stop(reason?: string): void
  sendMessage(chatId: string, text: string): Promise<void>
}

export interface TelegramChannelOptions {
  id: string
  botToken: string
  logger: Logger
  client?: TelegramClientLike
}

function buildDisplayName(input: {
  firstName?: string | null
  lastName?: string | null
  username?: string | null
  id?: string | number
}): string {
  const name = [input.firstName?.trim(), input.lastName?.trim()].filter(Boolean).join(' ').trim()
  if (name.length > 0) {
    return name
  }

  if (input.username?.trim()) {
    return `@${input.username.trim()}`
  }

  return String(input.id ?? '')
}

function createTelegramClient(botToken: string): TelegramClientLike {
  const bot = new Telegraf(botToken)

  return {
    onText(handler) {
      bot.on(message('text'), async (context) => {
        const chat = context.chat
        const sender = context.from

        await handler({
          id: String(context.message.message_id),
          chatId: String(chat.id),
          chatType: String(chat.type),
          senderId: String(sender.id),
          senderUsername: sender.username ?? null,
          senderDisplayName: buildDisplayName({
            firstName: sender.first_name,
            lastName: sender.last_name,
            username: sender.username,
            id: sender.id
          }),
          text: context.message.text,
          timestamp: new Date(context.message.date * 1000)
        })
      })
    },
    async launch() {
      await bot.launch()
    },
    stop(reason) {
      try {
        bot.stop(reason)
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'Bot is not running!') {
          throw error
        }
      }
    },
    async sendMessage(chatId, text) {
      await bot.telegram.sendMessage(chatId, text)
    }
  }
}

function isPrivateChat(chatType: string): boolean {
  return chatType === 'private'
}

export class TelegramChannel extends AbstractChannel {
  private readonly client: TelegramClientLike
  private readonly logger: Logger
  private started = false
  private stopping = false

  constructor(options: TelegramChannelOptions) {
    super(options.id, 'telegram')

    this.client = options.client ?? createTelegramClient(options.botToken)
    this.logger = options.logger.child(`telegram:${options.id}`)
  }

  async start(): Promise<void> {
    if (this.started) {
      return
    }

    this.stopping = false
    this.client.onText(async (message) => {
      const normalized = this.toChannelMessage(message)
      if (!normalized) {
        return
      }

      void this.emitMessage(normalized).catch((error) => {
        this.logger.error(`Failed to process inbound message ${normalized.id}`, error)
      })
    })
    this.started = true

    void Promise.resolve()
      .then(() => this.client.launch())
      .catch((error) => {
        if (this.stopping) {
          return
        }

        this.started = false
        try {
          this.client.stop('telegram-channel-failed')
        } catch {
          // Ignore stop failures while handling launch errors.
        }
        this.logger.error('Telegram channel failed to start', error)
      })
  }

  async stop(): Promise<void> {
    if (!this.started) {
      return
    }

    this.stopping = true
    this.client.stop('telegram-channel-stopped')
    this.started = false
  }

  async send(remoteChatId: string, text: string): Promise<void> {
    await this.client.sendMessage(remoteChatId, text)
  }

  private toChannelMessage(message: TelegramInboundTextMessage): ChannelMessage | null {
    if (!isPrivateChat(message.chatType)) {
      return null
    }

    const text = message.text.trim()
    if (text.length === 0) {
      return null
    }

    return {
      id: message.id,
      remoteChatId: message.chatId,
      senderId: message.senderId,
      text,
      timestamp: message.timestamp,
      metadata: {
        telegramChatId: message.chatId,
        telegramChatType: message.chatType,
        telegramIsBotMentioned: true,
        telegramMessageId: message.id,
        telegramUsername: message.senderUsername,
        telegramDisplayName: message.senderDisplayName
      }
    }
  }
}
