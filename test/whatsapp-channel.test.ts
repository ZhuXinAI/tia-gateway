import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { WhatsAppChannel } from '../src/channels/whatsapp-channel.js'
import { createLogger } from '../src/logging.js'
import type { ChannelMessage } from '../src/core/types.js'

type ConnectionUpdate =
  | { status: 'connecting' }
  | { status: 'qr_ready'; qrCodeValue: string }
  | { status: 'connected'; phoneNumber: string | null; botJid: string | null }
  | { status: 'disconnected'; errorMessage: string | null; disconnectReason: number | null }
  | { status: 'error'; errorMessage: string }

type InboundTextMessage = {
  id: string
  chatId: string
  isGroup: boolean
  senderId: string
  senderDisplayName: string
  mentionedJids: string[]
  text: string
  timestamp: Date
}

class WhatsAppClientStub {
  connectCalls = 0
  disconnectCalls: string[] = []
  resetAuthStateCalls = 0
  sentMessages: Array<{ chatId: string; text: string }> = []

  private connectionHandler: ((update: ConnectionUpdate) => Promise<void> | void) | null = null
  private textHandler: ((message: InboundTextMessage) => Promise<void>) | null = null

  onConnectionUpdate(handler: (update: ConnectionUpdate) => Promise<void> | void): void {
    this.connectionHandler = handler
  }

  onText(handler: (message: InboundTextMessage) => Promise<void>): void {
    this.textHandler = handler
  }

  async connect(): Promise<void> {
    this.connectCalls += 1
  }

  async disconnect(reason?: string): Promise<void> {
    this.disconnectCalls.push(reason ?? '')
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    this.sentMessages.push({ chatId, text })
  }

  async resetAuthState(): Promise<void> {
    this.resetAuthStateCalls += 1
  }

  async emitConnection(update: ConnectionUpdate): Promise<void> {
    await this.connectionHandler?.(update)
  }

  async deliverText(input: {
    id?: string
    chatId: string
    senderId: string
    senderDisplayName: string
    mentionedJids?: string[]
    text: string
    timestamp?: Date
  }): Promise<void> {
    await this.textHandler?.({
      id: input.id ?? 'wam-msg-1',
      chatId: input.chatId,
      isGroup: input.chatId.endsWith('@g.us'),
      senderId: input.senderId,
      senderDisplayName: input.senderDisplayName,
      mentionedJids: input.mentionedJids ?? [],
      text: input.text,
      timestamp: input.timestamp ?? new Date('2026-03-29T00:00:00.000Z')
    })
  }
}

function createTestChannel(
  clientFactory: (authDirectoryPath: string) => Promise<WhatsAppClientStub>,
  overrides: Partial<ConstructorParameters<typeof WhatsAppChannel>[0]> = {}
): WhatsAppChannel {
  return new WhatsAppChannel({
    id: 'whatsapp-main',
    authDirectoryPath: '/tmp/whatsapp-main',
    clientFactory,
    logger: createLogger('error', 'test'),
    ...overrides
  })
}

test('WhatsAppChannel emits qr state and qr callback during login', async () => {
  const client = new WhatsAppClientStub()
  const states: string[] = []
  const qrCodes: string[] = []
  const channel = createTestChannel(async () => client, {
    onQrCode: (value) => {
      qrCodes.push(value)
    },
    onStateChange: (state) => {
      states.push(state.status)
    }
  })

  await channel.start()
  await delay(0)
  await client.emitConnection({
    status: 'qr_ready',
    qrCodeValue: 'whatsapp-qr-value'
  })

  assert.equal(client.connectCalls, 1)
  assert.deepEqual(states, ['connecting', 'qr_ready'])
  assert.deepEqual(qrCodes, ['whatsapp-qr-value'])
})

test('WhatsAppChannel forwards direct text messages with metadata', async () => {
  const client = new WhatsAppClientStub()
  const channel = createTestChannel(async () => client)
  const received: ChannelMessage[] = []
  channel.onMessage = (message) => {
    received.push(message)
  }

  await channel.start()
  await delay(0)
  await client.deliverText({
    id: 'wam-msg-42',
    chatId: '8613800138000@s.whatsapp.net',
    senderId: '8613800138000@s.whatsapp.net',
    senderDisplayName: 'Alice',
    text: 'hello from whatsapp',
    timestamp: new Date('2026-03-29T00:10:00.000Z')
  })
  await delay(0)

  assert.deepEqual(received[0], {
    id: 'wam-msg-42',
    remoteChatId: '8613800138000@s.whatsapp.net',
    senderId: '8613800138000@s.whatsapp.net',
    text: 'hello from whatsapp',
    timestamp: new Date('2026-03-29T00:10:00.000Z'),
    metadata: {
      whatsappChatId: '8613800138000@s.whatsapp.net',
      whatsappChatType: 'direct',
      whatsappIsBotMentioned: true,
      whatsappMessageId: 'wam-msg-42',
      whatsappPhoneNumber: '8613800138000',
      whatsappDisplayName: 'Alice'
    }
  })
})

test('WhatsAppChannel ignores group messages without a bot mention by default', async () => {
  const client = new WhatsAppClientStub()
  const channel = createTestChannel(async () => client)
  const received: ChannelMessage[] = []
  channel.onMessage = (message) => {
    received.push(message)
  }

  await channel.start()
  await delay(0)
  await client.emitConnection({
    status: 'connected',
    phoneNumber: '8613800999000',
    botJid: '8613800999000@s.whatsapp.net'
  })
  await client.deliverText({
    id: 'wam-msg-group-1',
    chatId: '12345-67890@g.us',
    senderId: '8613800138000@s.whatsapp.net',
    senderDisplayName: 'Alice',
    text: 'hello group'
  })

  assert.equal(received.length, 0)
})

test('WhatsAppChannel can allow all group messages when mention gating is disabled', async () => {
  const client = new WhatsAppClientStub()
  const channel = createTestChannel(async () => client, {
    groupRequireMention: false
  })
  const received: ChannelMessage[] = []
  channel.onMessage = (message) => {
    received.push(message)
  }

  await channel.start()
  await delay(0)
  await client.deliverText({
    id: 'wam-msg-group-2',
    chatId: '12345-67890@g.us',
    senderId: '8613800138000@s.whatsapp.net',
    senderDisplayName: 'Alice',
    text: 'group hello everyone',
    timestamp: new Date('2026-03-29T00:12:00.000Z')
  })
  await delay(0)

  assert.deepEqual(received[0], {
    id: 'wam-msg-group-2',
    remoteChatId: '12345-67890@g.us',
    senderId: '8613800138000@s.whatsapp.net',
    text: 'group hello everyone',
    timestamp: new Date('2026-03-29T00:12:00.000Z'),
    metadata: {
      whatsappChatId: '12345-67890@g.us',
      whatsappChatType: 'group',
      whatsappIsBotMentioned: false,
      whatsappMessageId: 'wam-msg-group-2',
      whatsappPhoneNumber: '8613800138000',
      whatsappDisplayName: 'Alice'
    }
  })
})

test('WhatsAppChannel resets auth state and reconnects after a logged-out disconnect', async () => {
  const firstClient = new WhatsAppClientStub()
  const secondClient = new WhatsAppClientStub()
  let factoryCalls = 0
  const channel = createTestChannel(async () => {
    factoryCalls += 1
    return factoryCalls === 1 ? firstClient : secondClient
  }, {
    reconnectDelayMs: 5
  })

  await channel.start()
  await delay(0)
  await firstClient.emitConnection({
    status: 'disconnected',
    errorMessage: 'Logged out',
    disconnectReason: 401
  })
  await delay(20)

  assert.equal(firstClient.resetAuthStateCalls, 1)
  assert.equal(factoryCalls, 2)
  assert.equal(secondClient.connectCalls, 1)
})

test('WhatsAppChannel sends assistant replies back to the same chat', async () => {
  const client = new WhatsAppClientStub()
  const channel = createTestChannel(async () => client)

  await channel.start()
  await delay(0)
  await channel.send('8613800138000@s.whatsapp.net', 'assistant reply')

  assert.deepEqual(client.sentMessages, [
    {
      chatId: '8613800138000@s.whatsapp.net',
      text: 'assistant reply'
    }
  ])
})
