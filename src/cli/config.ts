import type {
  RawChannelConfig,
  RawGatewayConfig,
  RawLarkChannelConfig,
  RawTelegramChannelConfig,
  RawWhatsAppChannelConfig,
  RawWechatChannelConfig
} from '../config.js'
import { BUILT_IN_AGENTS, type AgentPreset } from '../protocols/acp/config.js'

const DEFAULT_LOG_LEVEL = 'info'

export type OnboardAgentSelection =
  | {
      mode: 'preset'
      preset: string
    }
  | {
      mode: 'raw'
      command: string
      args: string[]
    }

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

export function listAvailableAgentPresets(
  config: RawGatewayConfig | null
): Array<{ id: string; preset: AgentPreset; source: 'built-in' | 'custom' }> {
  const registry = {
    ...BUILT_IN_AGENTS,
    ...(config?.protocol?.agents ?? {})
  }
  const builtInIds = new Set(Object.keys(BUILT_IN_AGENTS))

  return Object.entries(registry)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, preset]) => ({
      id,
      preset,
      source: builtInIds.has(id) ? 'built-in' : 'custom'
    }))
}

export function upsertAcpAgentSelection(
  config: RawGatewayConfig,
  selection: OnboardAgentSelection
): RawGatewayConfig {
  const protocol = config.protocol ?? { type: 'acp' as const }
  const commonAgentSettings = {
    ...(protocol.agent?.cwd ? { cwd: protocol.agent.cwd } : {}),
    ...(protocol.agent?.env ? { env: { ...protocol.agent.env } } : {}),
    ...(protocol.agent?.showThoughts !== undefined
      ? { showThoughts: protocol.agent.showThoughts }
      : {})
  }

  return {
    ...config,
    protocol: {
      ...protocol,
      type: 'acp',
      agent:
        selection.mode === 'preset'
          ? {
              ...commonAgentSettings,
              preset: selection.preset
            }
          : {
              ...commonAgentSettings,
              command: selection.command,
              args: [...selection.args]
            }
    }
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
