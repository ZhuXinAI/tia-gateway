#!/usr/bin/env node

import { once } from 'node:events'
import qrcodeTerminal from 'qrcode-terminal'
import { createChannels } from '../channels/index.js'
import { loadGatewayConfig } from '../config.js'
import {
  describeGatewayConfigSource,
  readGatewayConfigSource,
  rememberGatewayConfigPath
} from '../config-store.js'
import {
  hasConfiguredAcpAgent,
  hasConfiguredChannels
} from '../cli/config.js'
import { runOnboard } from '../cli/onboard.js'
import { createCliProgram, type StartCommandOptions } from '../cli/options.js'
import { GatewayApp } from '../core/gateway-app.js'
import { createLogger } from '../logging.js'
import { PACKAGE_NAME, PACKAGE_VERSION } from '../meta.js'
import { createProtocolAdapter, listBuiltInAgents } from '../protocols/index.js'

function printAgents(): void {
  console.log('Built-in ACP agents:')
  for (const { id, preset } of listBuiltInAgents()) {
    console.log(`- ${id}: ${preset.command} ${preset.args.join(' ')}${preset.description ? ` (${preset.description})` : ''}`)
  }
}

async function startGatewayCommand(options: StartCommandOptions): Promise<void> {
  const configSource = await readGatewayConfigSource({ filePath: options.config })
  const existingConfig = configSource.config
  const isMissingChannels = !hasConfiguredChannels(existingConfig)
  const isMissingAgent = !hasConfiguredAcpAgent(existingConfig)
  if (isMissingChannels || isMissingAgent) {
    const missingPieces: string[] = []
    if (isMissingChannels) {
      missingPieces.push('configured channels')
    }
    if (isMissingAgent) {
      missingPieces.push('ACP agent selection')
    }

    console.log(
      `Missing ${missingPieces.join(' and ')} at ${describeGatewayConfigSource(configSource)}. Starting interactive onboarding.`
    )
    await runOnboard(options.config)
  }

  const config = await loadGatewayConfig({
    filePath: options.config,
    agentSelection: options.agent,
    cwd: options.cwd,
    showThoughts: options.showThoughts,
    logLevel: options.logLevel
  })

  if (options.config) {
    await rememberGatewayConfigPath(options.config)
  }

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
    },
    onWhatsAppQrCode: ({ channelId, value }) => {
      console.log('')
      console.log(`[${channelId}] Scan this WhatsApp QR code:`)
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

async function main(): Promise<void> {
  const program = createCliProgram({
    version: PACKAGE_VERSION,
    onStart: (options) => startGatewayCommand(options),
    onAgents: () => {
      printAgents()
    },
    onOnboard: async (options) => {
      await runOnboard(options.config)
    }
  })

  await program.parseAsync(process.argv)
}

main().catch((error) => {
  console.warn(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
