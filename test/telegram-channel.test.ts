import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { TelegramChannel } from '../src/channels/telegram-channel.js'
import { createLogger } from '../src/logging.js'
import type { ChannelMessage } from '../src/core/types.js'

class TelegramClientStub {
  launchCalls = 0
  stopCalls: string[] = []
  sentMessages: Array<{ chatId: string; text: string }> = []

  private textHandler:
    | ((message: {
        id: string
        chatId: string
        chatType: string
        senderId: string
        senderUsername: string | null
        senderDisplayName: string
        text: string
        timestamp: Date
      }) => Promise<void>)
    | null = null

  onText(
    handler: (message: {
      id: string
      chatId: string
      chatType: string
      senderId: string
      senderUsername: string | null
      senderDisplayName: string
      text: string
      timestamp: Date
    }) => Promise<void>
  ): void {
    this.textHandler = handler
  }

  async launch(): Promise<void> {
    this.launchCalls += 1
  }

  stop(reason?: string): void {
    this.stopCalls.push(reason ?? '')
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    this.sentMessages.push({ chatId, text })
  }

  async deliverText(input: {
    id?: string
    chatId: string
    chatType?: string
    senderId: string
    senderUsername?: string | null
    senderDisplayName: string
    text: string
    timestamp?: Date
  }): Promise<void> {
    await this.textHandler?.({
      id: input.id ?? 'msg-1',
      chatId: input.chatId,
      chatType: input.chatType ?? 'private',
      senderId: input.senderId,
      senderUsername: input.senderUsername ?? null,
      senderDisplayName: input.senderDisplayName,
      text: input.text,
      timestamp: input.timestamp ?? new Date('2026-03-29T00:00:00.000Z')
    })
  }
}

function createTestChannel(client: TelegramClientStub): TelegramChannel {
  return new TelegramChannel({
    id: 'telegram-main',
    botToken: '123456:test-token',
    client,
    logger: createLogger('error', 'test')
  })
}

test('TelegramChannel starts and stops the injected client', async () => {
  const client = new TelegramClientStub()
  const channel = createTestChannel(client)

  await channel.start()
  await delay(0)
  await channel.stop()

  assert.equal(client.launchCalls, 1)
  assert.deepEqual(client.stopCalls, ['telegram-channel-stopped'])
})

test('TelegramChannel ignores non-private chats', async () => {
  const client = new TelegramClientStub()
  const channel = createTestChannel(client)
  const received: ChannelMessage[] = []
  channel.onMessage = (message) => {
    received.push(message)
  }

  await channel.start()
  await client.deliverText({
    chatId: '-1001',
    chatType: 'group',
    senderId: '1001',
    senderDisplayName: 'Alice',
    text: 'hello group'
  })

  assert.equal(received.length, 0)
})

test('TelegramChannel forwards private text messages with metadata', async () => {
  const client = new TelegramClientStub()
  const channel = createTestChannel(client)
  const received: ChannelMessage[] = []
  channel.onMessage = (message) => {
    received.push(message)
  }

  await channel.start()
  await client.deliverText({
    id: '42',
    chatId: '1001',
    senderId: '1001',
    senderUsername: 'alice',
    senderDisplayName: 'Alice',
    text: 'hello from telegram',
    timestamp: new Date('2026-03-29T00:10:00.000Z')
  })
  await delay(0)

  assert.deepEqual(received[0], {
    id: '42',
    remoteChatId: '1001',
    senderId: '1001',
    text: 'hello from telegram',
    timestamp: new Date('2026-03-29T00:10:00.000Z'),
    metadata: {
      telegramChatId: '1001',
      telegramChatType: 'private',
      telegramIsBotMentioned: true,
      telegramMessageId: '42',
      telegramUsername: 'alice',
      telegramDisplayName: 'Alice'
    }
  })
})

test('TelegramChannel sends assistant replies back to the same chat', async () => {
  const client = new TelegramClientStub()
  const channel = createTestChannel(client)

  await channel.send('1001', 'assistant reply')

  assert.deepEqual(client.sentMessages, [{ chatId: '1001', text: 'assistant reply' }])
})
