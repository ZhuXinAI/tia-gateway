import assert from 'node:assert/strict'
import test from 'node:test'
import { GatewayAcpClient } from '../src/protocols/acp/client.js'
import type { AgentProtocolEvent } from '../src/core/types.js'

function createClient(overrides: Partial<ConstructorParameters<typeof GatewayAcpClient>[0]> = {}) {
  const toolMessages: string[] = []
  const events: AgentProtocolEvent[] = []
  const client = new GatewayAcpClient({
    log: () => undefined,
    sendTyping: async () => undefined,
    onThoughtFlush: async () => undefined,
    onToolCall: async (text) => {
      toolMessages.push(text)
    },
    onEvent: async (event) => {
      events.push(event)
    },
    showThoughts: false,
    showTools: false,
    ...overrides
  })

  return { client, toolMessages, events }
}

test('GatewayAcpClient emits tool call text only when showTools is enabled', async () => {
  const enabled = createClient({ showTools: true })
  await enabled.client.sessionUpdate({
    sessionId: 'session-1',
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: 'tool-1',
      title: 'search_files',
      status: 'running'
    }
  } as any)
  await enabled.client.sessionUpdate({
    sessionId: 'session-1',
    update: {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tool-1',
      status: 'completed'
    }
  } as any)

  assert.deepEqual(enabled.toolMessages, [
    '[Tool] search_files (running)',
    '[Tool] search_files (completed)'
  ])
  assert.deepEqual(
    enabled.events.map((event) =>
      typeof event === 'object' && event !== null && 'type' in event ? event.type : undefined
    ),
    ['tool-call', 'tool-call-update']
  )

  const disabled = createClient()
  await disabled.client.sessionUpdate({
    sessionId: 'session-2',
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: 'tool-2',
      title: 'edit_file',
      status: 'running'
    }
  } as any)

  assert.deepEqual(disabled.toolMessages, [])
  assert.equal(disabled.events.length, 1)
})
