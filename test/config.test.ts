import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { loadGatewayConfig } from '../src/config.js'
import {
  DEFAULT_ACP_AGENT_PRESET,
  resolveAcpAgentSelection
} from '../src/protocols/acp/config.js'

test('resolveAcpAgentSelection resolves built-in ACP presets', () => {
  const resolved = resolveAcpAgentSelection('codex')

  assert.equal(resolved.command, 'npx')
  assert.deepEqual(resolved.args, ['-y', '@zed-industries/codex-acp'])
  assert.equal(resolved.source, 'preset')
})

test('loadGatewayConfig resolves env vars and relative paths', async () => {
  const tempDir = await mkdtemp(join(os.tmpdir(), 'tia-gateway-config-'))
  process.env.TEST_LARK_APP_ID = 'cli_app_id'
  process.env.TEST_LARK_APP_SECRET = 'cli_app_secret'
  process.env.TEST_TELEGRAM_BOT_TOKEN = '123456:test-token'

  const configPath = join(tempDir, 'tia-gateway.config.json')
  await writeFile(
    configPath,
    JSON.stringify(
      {
        protocol: {
          type: 'acp',
          agent: {
            preset: 'claude',
            cwd: './workspace'
          }
        },
        channels: [
          {
            type: 'wechat',
            id: 'wechat-main',
            dataDirectoryPath: './wechat-data'
          },
          {
            type: 'lark',
            id: 'lark-main',
            appId: '${TEST_LARK_APP_ID}',
            appSecret: '${TEST_LARK_APP_SECRET}'
          },
          {
            type: 'telegram',
            id: 'telegram-main',
            botToken: '${TEST_TELEGRAM_BOT_TOKEN}'
          },
          {
            type: 'whatsapp',
            id: 'whatsapp-main',
            authDirectoryPath: './whatsapp-auth',
            groupRequireMention: false
          }
        ]
      },
      null,
      2
    ),
    'utf-8'
  )

  const config = await loadGatewayConfig({ filePath: configPath })

  assert.equal(config.protocol.type, 'acp')
  assert.equal(config.protocol.agent.command, 'npx')
  assert.equal(config.protocol.agent.cwd, join(tempDir, 'workspace'))
  assert.equal(config.channels[0]?.type, 'wechat')
  assert.equal(config.channels[0]?.dataDirectoryPath, join(tempDir, 'wechat-data'))
  assert.equal(config.channels[1]?.type, 'lark')
  assert.equal(config.channels[1]?.appId, 'cli_app_id')
  assert.equal(config.channels[1]?.appSecret, 'cli_app_secret')
  assert.equal(config.channels[2]?.type, 'telegram')
  assert.equal(config.channels[2]?.botToken, '123456:test-token')
  assert.equal(config.channels[3]?.type, 'whatsapp')
  assert.equal(config.channels[3]?.authDirectoryPath, join(tempDir, 'whatsapp-auth'))
  assert.equal(config.channels[3]?.groupRequireMention, false)

  await rm(tempDir, { recursive: true, force: true })
})

test('loadGatewayConfig falls back to defaults when agent and channels are missing', async () => {
  const tempDir = await mkdtemp(join(os.tmpdir(), 'tia-gateway-empty-'))
  const configPath = join(tempDir, 'tia-gateway.config.json')
  await writeFile(
    configPath,
    JSON.stringify(
      {
        channels: []
      },
      null,
      2
    ),
    'utf-8'
  )

  const config = await loadGatewayConfig({ filePath: configPath })
  assert.equal(config.protocol.agent.id, DEFAULT_ACP_AGENT_PRESET)
  assert.equal(config.channels.length, 1)
  assert.equal(config.channels[0]?.type, 'wechat')
  assert.match(config.warnings[0] ?? '', /Defaulting to "codex"/)
  assert.match(config.warnings[1] ?? '', /Defaulting to a single "wechat" channel/)
  await rm(tempDir, { recursive: true, force: true })
})
