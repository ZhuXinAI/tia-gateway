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

function parseSlashCommand(text: string): { command: string; args: string[] } | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) {
    return null
  }

  const tokens = trimmed.slice(1).split(/\s+/).filter(Boolean)
  if (tokens.length === 0) {
    return null
  }

  return {
    command: tokens[0]!.toLowerCase(),
    args: tokens.slice(1)
  }
}

function formatSessionList(
  sessions: Array<{ sessionId: string; title?: string; updatedAt?: string; cwd: string }>
): string {
  if (sessions.length === 0) {
    return 'No ACP sessions found.'
  }

  const lines = ['ACP sessions:']
  for (const session of sessions) {
    const title = session.title?.trim() ? ` | ${session.title.trim()}` : ''
    const updatedAt = session.updatedAt ? ` | updated ${session.updatedAt}` : ''
    lines.push(`- ${session.sessionId}${title}${updatedAt} | cwd ${session.cwd}`)
  }
  lines.push('Use /attach <sessionId> to bind this chat to an existing session.')
  lines.push('Use /new to clear the current binding and start a fresh session.')
  return lines.join('\n')
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
    const command = parseSlashCommand(message.text)

    try {
      if (command) {
        const handled = await this.handleSlashCommand({
          channel,
          message,
          sessionKey,
          command: command.command,
          args: command.args
        })

        if (handled) {
          return
        }
      }

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

            if (channel.sendEvent) {
              return
            }

            await channel.send(message.remoteChatId, text)
          },
          onToolCall: async (text) => {
            if (!text.trim()) {
              return
            }

            if (channel.sendEvent) {
              await channel.sendEvent(
                message.remoteChatId,
                {
                  type: 'text-delta',
                  delta: `${text}\n`
                },
                message
              )
              return
            }

            await channel.send(message.remoteChatId, text)
          },
          onTyping: async () => {
            if (channel.sendEvent) {
              await channel.sendEvent(
                message.remoteChatId,
                {
                  type: 'typing'
                },
                message
              )
              return
            }

            await channel.sendTyping?.(message.remoteChatId, message)
          },
          onTextDelta: async (text) => {
            if (!text.trim()) {
              return
            }

            await channel.sendEvent?.(
              message.remoteChatId,
              {
                type: 'text-delta',
                delta: text
              },
              message
            )
          },
          onReasoningDelta: async (text) => {
            if (!text.trim()) {
              return
            }

            await channel.sendEvent?.(
              message.remoteChatId,
              {
                type: 'reasoning-delta',
                delta: text
              },
              message
            )
          },
          onEvent: async (event) => {
            await channel.sendEvent?.(
              message.remoteChatId,
              {
                type: 'protocol-event',
                event
              },
              message
            )
          }
        }
      })

      if (result.text.trim()) {
        await channel.send(message.remoteChatId, result.text)
      }
    } catch (error) {
      const errorMessage = `Agent error: ${toErrorMessage(error)}`
      log.error(`Failed to process inbound message ${message.id}`, error)
      await channel
        .sendEvent?.(
          message.remoteChatId,
          {
            type: 'error',
            message: errorMessage
          },
          message
        )
        ?.catch(() => undefined)
      await channel.send(message.remoteChatId, errorMessage).catch((sendError) => {
        log.error(`Failed to send error message back to ${message.remoteChatId}`, sendError)
      })
    }
  }

  private async handleSlashCommand(input: {
    channel: ChannelAdapter
    message: ChannelMessage
    sessionKey: string
    command: string
    args: string[]
  }): Promise<boolean> {
    const { channel, message, sessionKey, command, args } = input

    if (command === 'new') {
      if (this.options.protocol.resetSession) {
        await this.options.protocol.resetSession(sessionKey)
      } else {
        await this.options.protocol.closeSession(sessionKey)
      }

      await channel.send(
        message.remoteChatId,
        'Started a fresh session for this chat. Next message will open a new agent session.'
      )
      return true
    }

    if (command === 'list') {
      if (!this.options.protocol.listSessions) {
        await channel.send(message.remoteChatId, 'This protocol adapter does not support /list.')
        return true
      }

      const sessions = await this.options.protocol.listSessions()
      await channel.send(message.remoteChatId, formatSessionList(sessions))
      return true
    }

    if (command === 'attach') {
      if (!this.options.protocol.attachSession) {
        await channel.send(message.remoteChatId, 'This protocol adapter does not support /attach.')
        return true
      }

      const sessionId = args[0]?.trim()
      if (!sessionId) {
        await channel.send(message.remoteChatId, 'Usage: /attach <sessionId>')
        return true
      }

      await this.options.protocol.attachSession(sessionKey, sessionId)
      await channel.send(
        message.remoteChatId,
        `Attached this chat to ACP session ${sessionId}.`
      )
      return true
    }

    return false
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
