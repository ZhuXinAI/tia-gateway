import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { GatewayApp } from '../src/core/gateway-app.js'
import { AbstractChannel } from '../src/core/abstract-channel.js'
import type {
  AgentProtocolAdapter,
  AgentProtocolTurnInput,
  AgentProtocolTurnResult,
  ChannelMessage
} from '../src/core/types.js'
import { createLogger } from '../src/logging.js'

class FakeChannel extends AbstractChannel {
  readonly sentMessages: Array<{ remoteChatId: string; text: string }> = []
  readonly typingCalls: string[] = []

  constructor(id: string) {
    super(id, 'wechat')
  }

  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  async send(remoteChatId: string, text: string): Promise<void> {
    this.sentMessages.push({ remoteChatId, text })
  }

  async sendTyping(remoteChatId: string): Promise<void> {
    this.typingCalls.push(remoteChatId)
  }

  async push(message: ChannelMessage): Promise<void> {
    await this.onMessage?.(message)
  }
}

class FakeProtocol implements AgentProtocolAdapter {
  readonly type = 'acp' as const
  readonly order: string[] = []
  readonly closedSessions: string[] = []

  async runTurn(input: AgentProtocolTurnInput): Promise<AgentProtocolTurnResult> {
    const firstBlock = input.content[0]
    const text = firstBlock?.type === 'text' ? firstBlock.text : '[non-text]'

    this.order.push(`start:${input.sessionKey}:${text}`)
    await input.callbacks?.onTyping?.()
    if (text === 'first') {
      await delay(30)
    }
    this.order.push(`end:${input.sessionKey}:${text}`)

    return {
      text: `reply:${text}`
    }
  }

  async closeSession(sessionKey: string): Promise<void> {
    this.closedSessions.push(sessionKey)
  }

  async stop(): Promise<void> {}
}

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('Timed out waiting for condition')
    }
    await delay(10)
  }
}

test('GatewayApp serializes turns per conversation', async () => {
  const channel = new FakeChannel('wechat-main')
  const protocol = new FakeProtocol()
  const app = new GatewayApp({
    channels: [channel],
    protocol,
    idleTimeoutMs: 60_000,
    maxConcurrentSessions: 10,
    logger: createLogger('error', 'test')
  })

  await app.start()

  await Promise.all([
    channel.push({
      id: 'm1',
      remoteChatId: 'user-1',
      senderId: 'user-1',
      text: 'first',
      timestamp: new Date()
    }),
    channel.push({
      id: 'm2',
      remoteChatId: 'user-1',
      senderId: 'user-1',
      text: 'second',
      timestamp: new Date()
    })
  ])

  await waitFor(() => channel.sentMessages.length === 2)

  assert.deepEqual(protocol.order, [
    'start:wechat-main:user-1:first',
    'end:wechat-main:user-1:first',
    'start:wechat-main:user-1:second',
    'end:wechat-main:user-1:second'
  ])
  assert.deepEqual(
    channel.sentMessages.map((message) => message.text),
    ['reply:first', 'reply:second']
  )
  assert.deepEqual(channel.typingCalls, ['user-1', 'user-1'])

  await app.stop()
  assert.deepEqual(protocol.closedSessions, ['wechat-main:user-1'])
})
