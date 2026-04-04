import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createSeedGatewayConfig,
  hasConfiguredAcpAgent,
  listAvailableAgentPresets,
  upsertAcpAgentSelection,
  upsertHttpChannelConfig,
  upsertTelegramChannelConfig,
  upsertWebSocketChannelConfig,
  upsertWhatsAppChannelConfig
} from '../src/cli/config.js'

test('createSeedGatewayConfig provides a usable default config', () => {
  const config = createSeedGatewayConfig(null)

  assert.equal(config.gateway?.logLevel, 'info')
  assert.equal(config.protocol?.type, 'acp')
  assert.equal(config.protocol?.agent?.preset, 'codex')
  assert.equal(config.protocol?.agent?.showThoughts, false)
  assert.equal(config.protocol?.agent?.showTools, false)
  assert.deepEqual(config.channels, [])
})

test('hasConfiguredAcpAgent returns true for preset or raw command', () => {
  assert.equal(
    hasConfiguredAcpAgent({
      protocol: {
        type: 'acp',
        agent: {
          preset: 'codex'
        }
      }
    }),
    true
  )

  assert.equal(
    hasConfiguredAcpAgent({
      protocol: {
        type: 'acp',
        agent: {
          command: 'npx',
          args: ['my-agent', '--acp']
        }
      }
    }),
    true
  )
})

test('hasConfiguredAcpAgent returns false when no usable agent selection is present', () => {
  assert.equal(hasConfiguredAcpAgent(null), false)
  assert.equal(
    hasConfiguredAcpAgent({
      protocol: {
        type: 'acp',
        agent: {}
      }
    }),
    false
  )
  assert.equal(
    hasConfiguredAcpAgent({
      protocol: {
        type: 'acp',
        agent: {
          preset: '   '
        }
      }
    }),
    false
  )
})

test('listAvailableAgentPresets includes built-in and saved custom presets', () => {
  const presets = listAvailableAgentPresets({
    protocol: {
      type: 'acp',
      agents: {
        'my-agent': {
          label: 'My Agent',
          command: 'npx',
          args: ['my-agent-cli', '--acp']
        }
      }
    }
  })

  assert.equal(presets.some((preset) => preset.id === 'codex'), true)
  assert.deepEqual(
    presets.find((preset) => preset.id === 'my-agent'),
    {
      id: 'my-agent',
      preset: {
        label: 'My Agent',
        command: 'npx',
        args: ['my-agent-cli', '--acp']
      },
      source: 'custom'
    }
  )
})

test('upsertAcpAgentSelection stores preset choices and clears raw command fields', () => {
  const updated = upsertAcpAgentSelection(
    {
      protocol: {
        type: 'acp',
        agent: {
          command: 'npx',
          args: ['legacy-agent', '--acp'],
          cwd: './workspace',
          showThoughts: true,
          showTools: true
        }
      }
    },
    {
      mode: 'preset',
      preset: 'claude'
    }
  )

  assert.deepEqual(updated.protocol?.agent, {
    preset: 'claude',
    cwd: './workspace',
    showThoughts: true,
    showTools: true
  })
})

test('upsertAcpAgentSelection stores raw commands and clears preset fields', () => {
  const updated = upsertAcpAgentSelection(
    createSeedGatewayConfig({
      protocol: {
        type: 'acp',
        agent: {
          preset: 'codex',
          showThoughts: false,
          showTools: true
        }
      }
    }),
    {
      mode: 'raw',
      command: 'npx',
      args: ['my-agent', '--acp']
    }
  )

  assert.deepEqual(updated.protocol?.agent, {
    command: 'npx',
    args: ['my-agent', '--acp'],
    showThoughts: false,
    showTools: true
  })
})

test('upsertTelegramChannelConfig updates an existing telegram channel', () => {
  const updated = upsertTelegramChannelConfig(
    {
      channels: [
        {
          id: 'telegram-main',
          type: 'telegram',
          botToken: 'old-token'
        }
      ]
    },
    {
      id: 'telegram-main',
      type: 'telegram',
      botToken: 'new-token'
    }
  )

  assert.deepEqual(updated.channels, [
    {
      id: 'telegram-main',
      type: 'telegram',
      botToken: 'new-token'
    }
  ])
})

test('upsertWhatsAppChannelConfig preserves an existing id while updating settings', () => {
  const updated = upsertWhatsAppChannelConfig(
    {
      channels: [
        {
          id: 'custom-whatsapp',
          type: 'whatsapp',
          authDirectoryPath: '~/.tia-gateway/channels/custom-whatsapp',
          groupRequireMention: true
        }
      ]
    },
    {
      id: 'whatsapp-main',
      type: 'whatsapp',
      authDirectoryPath: '~/.tia-gateway/channels/whatsapp-main',
      groupRequireMention: false
    }
  )

  assert.deepEqual(updated.channels, [
    {
      id: 'custom-whatsapp',
      type: 'whatsapp',
      authDirectoryPath: '~/.tia-gateway/channels/whatsapp-main',
      groupRequireMention: false
    }
  ])
})

test('upsertHttpChannelConfig updates an existing HTTP channel and preserves its id', () => {
  const updated = upsertHttpChannelConfig(
    {
      channels: [
        {
          id: 'custom-http',
          type: 'http',
          host: '127.0.0.1',
          port: 4311,
          chatPath: '/chat',
          ssePath: '/sse',
          serveWebApp: false,
          autoGenerateToken: false
        }
      ]
    },
    {
      id: 'http-main',
      type: 'http',
      host: '0.0.0.0',
      port: 4319,
      chatPath: '/gateway/chat',
      ssePath: '/gateway/sse',
      serveWebApp: true,
      autoGenerateToken: true,
      title: 'Gateway Workbench'
    }
  )

  assert.deepEqual(updated.channels, [
    {
      id: 'custom-http',
      type: 'http',
      host: '0.0.0.0',
      port: 4319,
      chatPath: '/gateway/chat',
      ssePath: '/gateway/sse',
      serveWebApp: true,
      autoGenerateToken: true,
      title: 'Gateway Workbench'
    }
  ])
})

test('upsertWebSocketChannelConfig appends a websocket channel when none exists', () => {
  const updated = upsertWebSocketChannelConfig(
    createSeedGatewayConfig(null),
    {
      id: 'websocket-main',
      type: 'websocket',
      host: '127.0.0.1',
      port: 4312,
      path: '/ws',
      token: 'secret'
    }
  )

  assert.deepEqual(updated.channels, [
    {
      id: 'websocket-main',
      type: 'websocket',
      host: '127.0.0.1',
      port: 4312,
      path: '/ws',
      token: 'secret'
    }
  ])
})
