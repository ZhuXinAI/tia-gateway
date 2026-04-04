import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import { join } from 'node:path'
import { HttpChannel } from '../src/channels/http-channel/index.js'
import { createLogger } from '../src/logging.js'
import { resolveAcpProtocolConfig } from '../src/protocols/index.js'

function getPort(channel: HttpChannel): number {
  return ((channel as unknown as { server: { address(): AddressInfo | null } }).server.address() as AddressInfo).port
}

async function readSseEvents(response: Response): Promise<Record<string, unknown>[]> {
  const payload = await response.text()
  return payload
    .split('\n\n')
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const dataLine = chunk
        .split('\n')
        .find((line) => line.startsWith('data: '))

      assert.ok(dataLine, `Missing data line in chunk: ${chunk}`)
      return JSON.parse(dataLine.slice('data: '.length)) as Record<string, unknown>
    })
}

test('HttpChannel accepts AI SDK style POST requests and streams UI events', async () => {
  const channel = new HttpChannel({
    id: 'http-main',
    host: '127.0.0.1',
    port: 0,
    logger: createLogger('error', 'test')
  })

  let receivedMessageText = ''
  channel.onMessage = async (message) => {
    receivedMessageText = message.text
    await channel.sendEvent?.(
      message.remoteChatId,
      {
        type: 'reasoning-delta',
        delta: 'thinking...'
      },
      message
    )
    await channel.sendEvent?.(
      message.remoteChatId,
      {
        type: 'protocol-event',
        event: {
          source: 'acp',
          type: 'tool-call',
          toolCallId: 'tool-1',
          title: 'search_files',
          status: 'in_progress',
          rawInput: {
            pattern: 'gateway'
          }
        }
      },
      message
    )
    await channel.sendEvent?.(
      message.remoteChatId,
      {
        type: 'protocol-event',
        event: {
          source: 'acp',
          type: 'tool-call-update',
          toolCallId: 'tool-1',
          title: 'search_files',
          status: 'completed',
          rawOutput: {
            matches: 3
          }
        }
      },
      message
    )
    await channel.sendEvent?.(
      message.remoteChatId,
      {
        type: 'text-delta',
        delta: 'Hello '
      },
      message
    )
    await channel.send(message.remoteChatId, 'world')
  }

  await channel.start()
  const port = getPort(channel)

  try {
    const response = await fetch(`http://127.0.0.1:${port}/chat`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        id: 'chat-1',
        messages: [
          {
            id: 'u1',
            role: 'user',
            parts: [{ type: 'text', text: 'hello gateway' }]
          }
        ]
      })
    })

    assert.equal(response.status, 200)
    assert.equal(response.headers.get('x-vercel-ai-ui-message-stream'), 'v1')
    assert.equal(response.headers.get('content-type'), 'text/event-stream')
    assert.equal(receivedMessageText, 'hello gateway')

    const events = await readSseEvents(response)
    assert.deepEqual(
      events.map((event) => event.type),
      [
        'start',
        'reasoning-start',
        'reasoning-delta',
        'tool-input-start',
        'tool-input-available',
        'data-acp-event',
        'tool-output-available',
        'data-acp-event',
        'text-start',
        'text-delta',
        'text-delta',
        'reasoning-end',
        'text-end',
        'finish'
      ]
    )
    assert.equal(events[2]?.delta, 'thinking...')
    assert.equal(events[3]?.toolName, 'search_files')
    assert.deepEqual(events[4]?.input, { pattern: 'gateway' })
    assert.deepEqual(events[6]?.output, { matches: 3 })
    assert.equal(events[9]?.delta, 'Hello ')
    assert.equal(events[10]?.delta, 'world')
  } finally {
    await channel.stop()
  }
})

test('HttpChannel resumes active streams through the /sse alias', async () => {
  const channel = new HttpChannel({
    id: 'http-main',
    host: '127.0.0.1',
    port: 0,
    logger: createLogger('error', 'test')
  })

  channel.onMessage = async (message) => {
    await delay(20)
    await channel.sendEvent?.(
      message.remoteChatId,
      {
        type: 'text-delta',
        delta: 'hello '
      },
      message
    )
    await delay(20)
    await channel.send(message.remoteChatId, 'again')
  }

  await channel.start()
  const port = getPort(channel)

  try {
    const postResponsePromise = fetch(`http://127.0.0.1:${port}/chat`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        id: 'chat-2',
        message: {
          id: 'u2',
          role: 'user',
          text: 'resume me'
        }
      })
    })

    await delay(10)

    const resumeResponse = await fetch(`http://127.0.0.1:${port}/sse/chat-2`)
    const postResponse = await postResponsePromise

    assert.equal(resumeResponse.status, 200)
    assert.equal(postResponse.status, 200)

    const [postEvents, resumeEvents] = await Promise.all([
      readSseEvents(postResponse),
      readSseEvents(resumeResponse)
    ])

    assert.equal(postEvents.at(-1)?.type, 'finish')
    assert.equal(resumeEvents.at(-1)?.type, 'finish')
    assert.ok(
      resumeEvents.some(
        (event) => event.type === 'text-delta' && event.delta === 'hello '
      )
    )
    assert.ok(
      resumeEvents.some(
        (event) => event.type === 'text-delta' && event.delta === 'again'
      )
    )
  } finally {
    await channel.stop()
  }
})

test('HttpChannel serves the assistant UI shell and protects chat routes with a generated token', async () => {
  const tempHome = await mkdtemp(join(os.tmpdir(), 'tia-gateway-http-web-'))
  const previousHome = process.env.HOME
  const channel = new HttpChannel({
    id: 'http-web',
    host: '127.0.0.1',
    port: 0,
    serveWebApp: true,
    autoGenerateToken: true,
    title: 'Gateway Workbench',
    logger: createLogger('error', 'test')
  })

  channel.onMessage = async (message) => {
    await channel.send(message.remoteChatId, 'secured hello')
  }

  process.env.HOME = tempHome

  await channel.start()
  const port = getPort(channel)

  try {
    const [htmlResponse, jsResponse, cssResponse] = await Promise.all([
      fetch(`http://127.0.0.1:${port}/`),
      fetch(`http://127.0.0.1:${port}/app.js`),
      fetch(`http://127.0.0.1:${port}/app.css`)
    ])

    assert.equal(htmlResponse.status, 200)
    assert.equal(jsResponse.status, 200)
    assert.equal(cssResponse.status, 200)
    assert.match(await htmlResponse.text(), /Gateway Workbench/)
    assert.match(jsResponse.headers.get('content-type') ?? '', /application\/javascript/)
    assert.match(cssResponse.headers.get('content-type') ?? '', /text\/css/)

    const unauthorizedResponse = await fetch(`http://127.0.0.1:${port}/chat`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        id: 'locked-chat',
        message: {
          role: 'user',
          text: 'hello'
        }
      })
    })

    assert.equal(unauthorizedResponse.status, 401)

    const persistedTokenPath = join(
      tempHome,
      '.tia-gateway',
      'channels',
      'http-web',
      'http-token.json'
    )
    const persistedToken = JSON.parse(
      await readFile(persistedTokenPath, 'utf-8')
    ) as { token?: string }

    assert.equal(typeof persistedToken.token, 'string')
    assert.ok(persistedToken.token)

    const authorizedResponse = await fetch(`http://127.0.0.1:${port}/chat`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${persistedToken.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        id: 'locked-chat',
        message: {
          role: 'user',
          text: 'hello'
        }
      })
    })

    assert.equal(authorizedResponse.status, 200)

    const events = await readSseEvents(authorizedResponse)
    assert.equal(events.at(-1)?.type, 'finish')
    assert.ok(
      events.some(
        (event) => event.type === 'text-delta' && event.delta === 'secured hello'
      )
    )
  } finally {
    await channel.stop()

    if (previousHome === undefined) {
      delete process.env.HOME
    } else {
      process.env.HOME = previousHome
    }

    await rm(tempHome, { recursive: true, force: true })
  }
})

test('HttpChannel exposes unified ACP session endpoints for the web shell', async () => {
  const tempHome = await mkdtemp(join(os.tmpdir(), 'tia-gateway-http-sessions-'))
  const previousHome = process.env.HOME
  process.env.HOME = tempHome
  const channel = new HttpChannel({
    id: 'http-web-sessions',
    host: '127.0.0.1',
    port: 0,
    serveWebApp: true,
    acpBridge: {
      config: resolveAcpProtocolConfig({
        raw: {
          agent: {
            command: '/usr/bin/true',
            args: [],
            cwd: process.cwd()
          }
        }
      }),
      protocol: {
        type: 'acp',
        async runTurn() {
          return {
            text: 'not used in this test'
          }
        },
        async closeSession() {},
        async listSessions() {
          return [
            {
              sessionId: 'session-1',
              title: 'Sandbox audit',
              cwd: '/tmp/project',
              updatedAt: '2026-04-04T00:00:00.000Z'
            }
          ]
        },
        async stop() {}
      }
    },
    logger: createLogger('error', 'test')
  })

  await channel.start()
  const port = getPort(channel)

  try {
    const listResponse = await fetch(`http://127.0.0.1:${port}/chat/sessions`)
    assert.equal(listResponse.status, 200)
    const listPayload = (await listResponse.json()) as {
      sessions?: Array<{ chatId?: string; acpSessionId?: string; status?: string }>
    }

    assert.equal(listPayload.sessions?.length, 1)
    assert.equal(listPayload.sessions?.[0]?.acpSessionId, 'session-1')
    assert.equal(listPayload.sessions?.[0]?.status, 'attached')

    const createdResponse = await fetch(`http://127.0.0.1:${port}/chat/sessions`, {
      method: 'POST'
    })
    assert.equal(createdResponse.status, 201)
    const createdPayload = (await createdResponse.json()) as {
      session?: { chatId?: string; status?: string; canDelete?: boolean }
    }
    assert.equal(createdPayload.session?.status, 'draft')
    assert.equal(createdPayload.session?.canDelete, true)

    const detailResponse = await fetch(
      `http://127.0.0.1:${port}/chat/sessions/${createdPayload.session?.chatId ?? ''}`
    )
    assert.equal(detailResponse.status, 200)
    const detailPayload = (await detailResponse.json()) as {
      session?: { messages?: unknown[] }
    }
    assert.deepEqual(detailPayload.session?.messages, [])
  } finally {
    await channel.stop()

    if (previousHome === undefined) {
      delete process.env.HOME
    } else {
      process.env.HOME = previousHome
    }

    await rm(tempHome, { recursive: true, force: true })
  }
})
