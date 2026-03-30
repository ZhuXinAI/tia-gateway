import type {
  RawChannelConfig,
  RawGatewayConfig,
  RawLarkChannelConfig,
  RawTelegramChannelConfig,
  RawWhatsAppChannelConfig,
  RawWechatChannelConfig
} from '../config.js'

const DEFAULT_LOG_LEVEL = 'info'

export function hasConfiguredChannels(config: RawGatewayConfig | null): boolean {
  return Array.isArray(config?.channels) && config.channels.length > 0
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
