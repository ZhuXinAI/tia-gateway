#!/usr/bin/env node

import { once } from 'node:events'
import { parseArgs } from 'node:util'
import qrcodeTerminal from 'qrcode-terminal'
import { createChannels } from '../channels/index.js'
import { loadGatewayConfig } from '../config.js'
import { GatewayApp } from '../core/gateway-app.js'
import { createLogger } from '../logging.js'
import { PACKAGE_NAME, PACKAGE_VERSION } from '../meta.js'
import { createProtocolAdapter, listBuiltInAgents } from '../protocols/index.js'

function printHelp(): void {
  console.log(`${PACKAGE_NAME} ${PACKAGE_VERSION}`)
  console.log('')
  console.log('Usage:')
  console.log('  tia-gateway start [options]')
  console.log('  tia-gateway agents')
  console.log('  tia-gateway --help')
  console.log('')
  console.log('Options:')
  console.log('  --config, -c <file>     Path to tia-gateway config JSON')
  console.log('  --agent <value>         ACP preset or raw ACP command override')
  console.log('  --cwd <dir>             Working directory for the ACP agent')
  console.log('  --show-thoughts         Forward ACP thinking messages to the channel')
  console.log('  --login                 Force WeChat re-login before startup')
  console.log('  --log-level <level>     debug | info | warn | error')
  console.log('  --version, -v           Show version')
  console.log('  --help, -h              Show help')
}

function printAgents(): void {
  console.log('Built-in ACP agents:')
  for (const { id, preset } of listBuiltInAgents()) {
    console.log(`- ${id}: ${preset.command} ${preset.args.join(' ')}${preset.description ? ` (${preset.description})` : ''}`)
  }
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: {
        type: 'string',
        short: 'c'
      },
      agent: {
        type: 'string'
      },
      cwd: {
        type: 'string'
      },
      'show-thoughts': {
        type: 'boolean'
      },
      login: {
        type: 'boolean'
      },
      'log-level': {
        type: 'string'
      },
      version: {
        type: 'boolean',
        short: 'v'
      },
      help: {
        type: 'boolean',
        short: 'h'
      }
    }
  })

  const command = positionals[0] ?? 'start'
  if (values.help) {
    printHelp()
    return
  }

  if (values.version) {
    console.log(PACKAGE_VERSION)
    return
  }

  if (command === 'agents') {
    printAgents()
    return
  }

  if (command !== 'start') {
    throw new Error(`Unknown command "${command}"`)
  }

  const config = await loadGatewayConfig({
    filePath: values.config,
    agentSelection: values.agent,
    cwd: values.cwd,
    showThoughts: values['show-thoughts'],
    forceLogin: values.login,
    logLevel: values['log-level'] as 'debug' | 'info' | 'warn' | 'error' | undefined
  })

  const logger = createLogger(config.gateway.logLevel, PACKAGE_NAME)
  for (const warning of config.warnings) {
    logger.warn(warning)
  }

  const protocol = createProtocolAdapter(config.protocol, logger.child('protocol'))
  const channels = createChannels(config.channels, {
    logger: logger.child('channels'),
    onWechatQrCode: ({ channelId, value }) => {
      console.log('')
      console.log(`[${channelId}] Scan this WeChat QR code:`)
      qrcodeTerminal.generate(value, { small: true })
    }
  })

  const app = new GatewayApp({
    channels,
    protocol,
    idleTimeoutMs: config.gateway.idleTimeoutMs,
    maxConcurrentSessions: config.gateway.maxConcurrentSessions,
    logger
  })

  await app.start()
  logger.info(`Started ${PACKAGE_NAME} with ${channels.length} channel(s)`)

  let stopping = false
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) {
      return
    }

    stopping = true
    logger.info(`Received ${signal}, shutting down`)
    await app.stop()
  }

  process.on('SIGINT', () => {
    void shutdown('SIGINT').then(() => {
      process.exit(0)
    })
  })
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM').then(() => {
      process.exit(0)
    })
  })

  await once(process, 'beforeExit')
}

main().catch((error) => {
  console.warn(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
