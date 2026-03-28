import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createSeedGatewayConfig,
  upsertTelegramChannelConfig,
  upsertWhatsAppChannelConfig
} from '../src/cli/config.js'

test('createSeedGatewayConfig provides a usable default config', () => {
  const config = createSeedGatewayConfig(null)

  assert.equal(config.gateway?.logLevel, 'info')
  assert.equal(config.protocol?.type, 'acp')
  assert.equal(config.protocol?.agent?.preset, 'codex')
  assert.deepEqual(config.channels, [])
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
