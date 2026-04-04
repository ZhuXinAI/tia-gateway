import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { GatewayApp } from '../src/core/gateway-app.js'
import { AbstractChannel } from '../src/core/abstract-channel.js'
import type {
  AgentProtocolAdapter,
  AgentProtocolEvent,
  AgentProtocolTurnInput,
  AgentProtocolTurnResult,
  ChannelEvent,
  ChannelMessage
} from '../src/core/types.js'
import { createLogger } from '../src/logging.js'

class FakeChannel extends AbstractChannel {
  readonly sentMessages: Array<{ remoteChatId: string; text: string }> = []
  readonly typingCalls: string[] = []
  readonly events: Array<{ remoteChatId: string; event: ChannelEvent; messageId?: string }> = []

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

  async sendEvent(
    remoteChatId: string,
    event: ChannelEvent,
    message?: ChannelMessage
  ): Promise<void> {
    this.events.push({
      remoteChatId,
      event,
      messageId: message?.id
    })
  }

  async push(message: ChannelMessage): Promise<void> {
    await this.onMessage?.(message)
  }
}

class TextOnlyChannel extends AbstractChannel {
  readonly sentMessages: Array<{ remoteChatId: string; text: string }> = []

  constructor(id: string) {
    super(id, 'telegram')
  }

  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  async send(remoteChatId: string, text: string): Promise<void> {
    this.sentMessages.push({ remoteChatId, text })
  }

  async push(message: ChannelMessage): Promise<void> {
    await this.onMessage?.(message)
  }
}

class FakeProtocol implements AgentProtocolAdapter {
  readonly type = 'acp' as const
  readonly order: string[] = []
  readonly closedSessions: string[] = []
  readonly attachedSessions: Array<{ sessionKey: string; sessionId: string }> = []
  readonly resetSessions: string[] = []
  readonly listedSessions = [
    {
      sessionId: 'session-1',
      title: 'Primary',
      cwd: '/tmp/project',
      updatedAt: '2026-04-03T00:00:00.000Z'
    }
  ]
  readonly protocolEvents: AgentProtocolEvent[] = []

  async runTurn(input: AgentProtocolTurnInput): Promise<AgentProtocolTurnResult> {
    const firstBlock = input.content[0]
    const text = firstBlock?.type === 'text' ? firstBlock.text : '[non-text]'

    this.order.push(`start:${input.sessionKey}:${text}`)
    await input.callbacks?.onTyping?.()
    await input.callbacks?.onReasoningDelta?.('thinking...')
    await input.callbacks?.onEvent?.({
      source: 'acp',
      type: 'tool-call',
      toolCallId: 'tool-1',
      title: 'edit_file',
      status: 'running'
    })
    await input.callbacks?.onTextDelta?.('partial ')
    this.protocolEvents.push({
      source: 'acp',
      type: 'tool-call',
      toolCallId: 'tool-1',
      title: 'edit_file',
      status: 'running'
    })
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

  async listSessions(): Promise<
    Array<{ sessionId: string; cwd: string; title?: string; updatedAt?: string }>
  > {
    return this.listedSessions
  }

  async attachSession(sessionKey: string, sessionId: string): Promise<void> {
    this.attachedSessions.push({ sessionKey, sessionId })
  }

  async resetSession(sessionKey: string): Promise<void> {
    this.resetSessions.push(sessionKey)
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
  assert.deepEqual(channel.typingCalls, [])
  assert.deepEqual(
    channel.events.map((entry) => entry.event.type),
    [
      'typing',
      'reasoning-delta',
      'protocol-event',
      'text-delta',
      'typing',
      'reasoning-delta',
      'protocol-event',
      'text-delta'
    ]
  )

  await app.stop()
  assert.deepEqual(protocol.closedSessions, ['wechat-main:user-1'])
})

test('GatewayApp handles slash commands locally', async () => {
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

  await channel.push({
    id: 'c1',
    remoteChatId: 'user-1',
    senderId: 'user-1',
    text: '/list',
    timestamp: new Date()
  })
  await waitFor(() => channel.sentMessages.length === 1)
  assert.match(channel.sentMessages[0]!.text, /ACP sessions:/)
  assert.match(channel.sentMessages[0]!.text, /session-1/)
  assert.deepEqual(protocol.order, [])

  await channel.push({
    id: 'c2',
    remoteChatId: 'user-1',
    senderId: 'user-1',
    text: '/attach session-1',
    timestamp: new Date()
  })
  await waitFor(() => channel.sentMessages.length === 2)
  assert.deepEqual(protocol.attachedSessions, [
    { sessionKey: 'wechat-main:user-1', sessionId: 'session-1' }
  ])
  assert.match(channel.sentMessages[1]!.text, /Attached this chat/)

  await channel.push({
    id: 'c3',
    remoteChatId: 'user-1',
    senderId: 'user-1',
    text: '/new',
    timestamp: new Date()
  })
  await waitFor(() => channel.sentMessages.length === 3)
  assert.deepEqual(protocol.resetSessions, ['wechat-main:user-1'])
  assert.match(channel.sentMessages[2]!.text, /Started a fresh session/)

  await channel.push({
    id: 'c4',
    remoteChatId: 'user-1',
    senderId: 'user-1',
    text: 'after commands',
    timestamp: new Date()
  })
  await waitFor(() => channel.sentMessages.length === 4)
  assert.match(channel.sentMessages[3]!.text, /reply:after commands/)

  await app.stop()
})

test('GatewayApp forwards tool call progress as text deltas for event-capable channels', async () => {
  const channel = new FakeChannel('http-main')
  const protocol: AgentProtocolAdapter = {
    type: 'acp',
    async runTurn(input: AgentProtocolTurnInput): Promise<AgentProtocolTurnResult> {
      await input.callbacks?.onToolCall?.('[Tool] search_files (running)')
      await input.callbacks?.onEvent?.({
        source: 'acp',
        type: 'tool-call',
        toolCallId: 'tool-1',
        title: 'search_files',
        status: 'running'
      })
      return { text: 'reply:http' }
    },
    async closeSession(): Promise<void> {},
    async stop(): Promise<void> {}
  }
  const app = new GatewayApp({
    channels: [channel],
    protocol,
    idleTimeoutMs: 60_000,
    maxConcurrentSessions: 10,
    logger: createLogger('error', 'test')
  })

  await app.start()
  await channel.push({
    id: 't1',
    remoteChatId: 'user-1',
    senderId: 'user-1',
    text: 'show me tools',
    timestamp: new Date()
  })

  await waitFor(() => channel.sentMessages.length === 1 && channel.events.length === 2)

  assert.deepEqual(
    channel.events.map((entry) => entry.event.type),
    ['text-delta', 'protocol-event']
  )
  assert.equal(channel.events[0]?.event.type, 'text-delta')
  if (channel.events[0]?.event.type === 'text-delta') {
    assert.match(channel.events[0].event.delta, /\[Tool\] search_files \(running\)/)
  }
  assert.deepEqual(channel.sentMessages.map((entry) => entry.text), ['reply:http'])

  await app.stop()
})

test('GatewayApp forwards tool call progress as standalone messages for text-only channels', async () => {
  const channel = new TextOnlyChannel('telegram-main')
  const protocol: AgentProtocolAdapter = {
    type: 'acp',
    async runTurn(input: AgentProtocolTurnInput): Promise<AgentProtocolTurnResult> {
      await input.callbacks?.onToolCall?.('[Tool] search_files (running)')
      return { text: 'reply:telegram' }
    },
    async closeSession(): Promise<void> {},
    async stop(): Promise<void> {}
  }
  const app = new GatewayApp({
    channels: [channel],
    protocol,
    idleTimeoutMs: 60_000,
    maxConcurrentSessions: 10,
    logger: createLogger('error', 'test')
  })

  await app.start()
  await channel.push({
    id: 't2',
    remoteChatId: 'user-2',
    senderId: 'user-2',
    text: 'show me tools',
    timestamp: new Date()
  })

  await waitFor(() => channel.sentMessages.length === 2)

  assert.deepEqual(channel.sentMessages.map((entry) => entry.text), [
    '[Tool] search_files (running)',
    'reply:telegram'
  ])

  await app.stop()
})
