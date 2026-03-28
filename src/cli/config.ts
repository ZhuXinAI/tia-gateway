import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import os from 'node:os'
import type {
  RawChannelConfig,
  RawGatewayConfig,
  RawLarkChannelConfig,
  RawTelegramChannelConfig,
  RawWhatsAppChannelConfig,
  RawWechatChannelConfig
} from '../config.js'

export const DEFAULT_GATEWAY_CONFIG_FILE = 'tia-gateway.config.json'

const DEFAULT_LOG_LEVEL = 'info'

function resolveHomePath(value: string): string {
  return value.startsWith('~/') ? join(os.homedir(), value.slice(2)) : value
}

export function resolveGatewayConfigPath(inputFilePath?: string): string {
  const value = inputFilePath?.trim()
  if (!value) {
    return join(process.cwd(), DEFAULT_GATEWAY_CONFIG_FILE)
  }

  const expanded = resolveHomePath(value)
  return isAbsolute(expanded) ? expanded : join(process.cwd(), expanded)
}

export async function readGatewayConfigFile(filePath: string): Promise<RawGatewayConfig | null> {
  try {
    const raw = await readFile(filePath, 'utf-8')
    return JSON.parse(raw) as RawGatewayConfig
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null
    }

    throw error
  }
}

export async function writeGatewayConfigFile(
  filePath: string,
  config: RawGatewayConfig
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, JSON.stringify(config, null, 2), 'utf-8')
}

export function hasConfiguredChannels(config: RawGatewayConfig | null): boolean {
  return Array.isArray(config?.channels) && config.channels.length > 0
}

export function resolveConfigRelativePath(configPath: string, value: string): string {
  const expanded = resolveHomePath(value)
  return isAbsolute(expanded) ? expanded : join(dirname(configPath), expanded)
}

export function createSeedGatewayConfig(existingConfig: RawGatewayConfig | null): RawGatewayConfig {
  return {
    gateway: existingConfig?.gateway ?? {
      logLevel: DEFAULT_LOG_LEVEL
    },
    protocol: existingConfig?.protocol ?? {
      type: 'acp',
      agent: {
        preset: 'codex',
        showThoughts: false
      }
    },
    channels: [...(existingConfig?.channels ?? [])]
  }
}

function replaceChannelAtIndex(
  channels: RawChannelConfig[],
  index: number,
  channel: RawChannelConfig
): RawChannelConfig[] {
  return channels.map((entry, entryIndex) => (entryIndex === index ? channel : entry))
}

export function upsertWechatChannelConfig(
  config: RawGatewayConfig,
  channel: RawWechatChannelConfig
): RawGatewayConfig {
  return upsertChannelConfig(config, channel)
}

export function upsertWhatsAppChannelConfig(
  config: RawGatewayConfig,
  channel: RawWhatsAppChannelConfig
): RawGatewayConfig {
  return upsertChannelConfig(config, channel)
}

export function upsertTelegramChannelConfig(
  config: RawGatewayConfig,
  channel: RawTelegramChannelConfig
): RawGatewayConfig {
  return upsertChannelConfig(config, channel)
}

export function upsertLarkChannelConfig(
  config: RawGatewayConfig,
  channel: RawLarkChannelConfig
): RawGatewayConfig {
  return upsertChannelConfig(config, channel)
}

function upsertChannelConfig(config: RawGatewayConfig, channel: RawChannelConfig): RawGatewayConfig {
  const channels = [...(config.channels ?? [])]
  const index = channels.findIndex((entry) => entry.type === channel.type)

  return {
    ...config,
    channels:
      index >= 0
        ? replaceChannelAtIndex(channels, index, {
            ...channels[index],
            ...channel,
            id: channels[index]?.id ?? channel.id
          } as RawChannelConfig)
        : [...channels, channel]
  }
}
