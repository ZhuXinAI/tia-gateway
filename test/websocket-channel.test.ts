import assert from 'node:assert/strict'
import test from 'node:test'
import type { AddressInfo } from 'node:net'
import WebSocket from 'ws'
import { WebSocketChannel } from '../src/channels/websocket-channel.js'
import { createLogger } from '../src/logging.js'

function getPort(channel: WebSocketChannel): number {
  return ((channel as unknown as { server: { address(): AddressInfo | null } }).server.address() as AddressInfo).port
}

async function waitForMessages(
  socket: WebSocket,
  messages: Record<string, unknown>[],
  expectedCount: number
): Promise<Record<string, unknown>[]> {
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${expectedCount} websocket messages`))
    }, 1_000)
    const maybeResolve = (): void => {
      if (messages.length >= expectedCount) {
        clearTimeout(timeout)
        resolve(messages)
      }
    }

    maybeResolve()
    socket.on('message', maybeResolve)
  })
}

test('WebSocketChannel forwards messages and pushes structured outbound events', async () => {
  const channel = new WebSocketChannel({
    id: 'ws-main',
    host: '127.0.0.1',
    port: 0,
    logger: createLogger('error', 'test')
  })

  let receivedText = ''
  channel.onMessage = async (message) => {
    receivedText = message.text
    await channel.sendEvent?.(message.remoteChatId, {
      type: 'protocol-event',
      event: {
        source: 'acp',
        type: 'tool-call',
        toolCallId: 'tool-1',
        title: 'search_files',
        status: 'running'
      }
    })
    await channel.sendEvent?.(message.remoteChatId, {
      type: 'text-delta',
      delta: 'partial '
    })
    await channel.send(message.remoteChatId, 'done')
  }

  await channel.start()
  const port = getPort(channel)

  try {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?chatId=chat-1`)
    const frames: Record<string, unknown>[] = []
    socket.on('message', (data) => {
      frames.push(JSON.parse(data.toString()) as Record<string, unknown>)
    })

    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve())
      socket.once('error', reject)
    })

    const messagesPromise = waitForMessages(socket, frames, 4)
    socket.send(
      JSON.stringify({
        type: 'message',
        id: 'client-1',
        text: 'hello websocket'
      })
    )

    const messages = await messagesPromise
    assert.equal(receivedText, 'hello websocket')
    assert.deepEqual(
      messages.map((message) => message.type),
      ['ready', 'protocol-event', 'text-delta', 'message']
    )
    assert.equal(messages[3]?.text, 'done')

    socket.close()
  } finally {
    await channel.stop()
  }
})
