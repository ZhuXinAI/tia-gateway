import type { Logger } from '../logging.js'
import { SerializedSessionManager } from './serialized-session-manager.js'
import type { AgentProtocolAdapter, ChannelAdapter, ChannelMessage, ProtocolContentBlock } from './types.js'

type GatewayTask = {
  channel: ChannelAdapter
  message: ChannelMessage
  sessionKey: string
}

export interface GatewayAppOptions {
  channels: ChannelAdapter[]
  protocol: AgentProtocolAdapter
  idleTimeoutMs: number
  maxConcurrentSessions: number
  logger: Logger
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return typeof error === 'string' ? error : 'Unknown error'
}

export class GatewayApp {
  private readonly sessionManager: SerializedSessionManager<GatewayTask>
  private started = false

  constructor(private readonly options: GatewayAppOptions) {
    this.sessionManager = new SerializedSessionManager<GatewayTask>({
      idleTimeoutMs: options.idleTimeoutMs,
      maxConcurrentSessions: options.maxConcurrentSessions,
      logger: options.logger.child('sessions'),
      onSessionClosed: (sessionKey) => this.options.protocol.closeSession(sessionKey),
      worker: (task) => this.processTask(task)
    })
  }

  async start(): Promise<void> {
    if (this.started) {
      return
    }

    this.started = true
    this.sessionManager.start()

    for (const channel of this.options.channels) {
      channel.onMessage = (message) => this.enqueueTask(channel, message)
      await channel.start()
      this.options.logger.info(`Started channel ${channel.id} (${channel.type})`)
    }
  }

  async stop(): Promise<void> {
    if (!this.started) {
      return
    }

    this.started = false

    await this.sessionManager.stop()
    await Promise.all(this.options.channels.map((channel) => channel.stop()))
    await this.options.protocol.stop()
  }

  private enqueueTask(channel: ChannelAdapter, message: ChannelMessage): Promise<void> {
    return this.sessionManager.enqueue(`${channel.id}:${message.remoteChatId}`, {
      channel,
      message,
      sessionKey: `${channel.id}:${message.remoteChatId}`
    })
  }

  private async processTask(task: GatewayTask): Promise<void> {
    const { channel, message, sessionKey } = task
    const content = this.toProtocolContent(message)
    const log = this.options.logger.child(`${channel.id}:${message.remoteChatId}`)

    try {
      const result = await this.options.protocol.runTurn({
        sessionKey,
        content,
        metadata: {
          channelId: channel.id,
          channelType: channel.type,
          remoteChatId: message.remoteChatId,
          senderId: message.senderId,
          ...(message.metadata ?? {})
        },
        callbacks: {
          onThought: async (text) => {
            if (!text.trim()) {
              return
            }

            await channel.send(message.remoteChatId, text)
          },
          onTyping: async () => {
            await channel.sendTyping?.(message.remoteChatId, message)
          }
        }
      })

      if (result.text.trim()) {
        await channel.send(message.remoteChatId, result.text)
      }
    } catch (error) {
      const errorMessage = `Agent error: ${toErrorMessage(error)}`
      log.error(`Failed to process inbound message ${message.id}`, error)
      await channel.send(message.remoteChatId, errorMessage).catch((sendError) => {
        log.error(`Failed to send error message back to ${message.remoteChatId}`, sendError)
      })
    }
  }

  private toProtocolContent(message: ChannelMessage): ProtocolContentBlock[] {
    if (message.contentBlocks && message.contentBlocks.length > 0) {
      return message.contentBlocks
    }

    return [
      {
        type: 'text',
        text: message.text
      }
    ]
  }
}
