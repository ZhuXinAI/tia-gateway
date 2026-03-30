import { isAbsolute, join } from 'node:path'
import os from 'node:os'
import type { LogLevel } from './logging.js'
import { defaultStorageDir, readGatewayConfigSource } from './config-store.js'
import {
  DEFAULT_ACP_AGENT_PRESET,
  resolveAcpProtocolConfig,
  type RawAcpProtocolConfig,
  type ResolvedAcpProtocolConfig
} from './protocols/acp/config.js'

export interface RawWechatChannelConfig {
  id?: string
  type: 'wechat'
  dataDirectoryPath?: string
  apiBaseUrl?: string
  forceLogin?: boolean
  longPollTimeoutMs?: number
  qrTtlMs?: number
  reconnectDelayMs?: number
}

export interface RawLarkChannelConfig {
  id?: string
  type: 'lark'
  appId: string
  appSecret: string
  groupRequireMention?: boolean
}

export interface RawTelegramChannelConfig {
  id?: string
  type: 'telegram'
  botToken: string
}

export interface RawWhatsAppChannelConfig {
  id?: string
  type: 'whatsapp'
  authDirectoryPath?: string
  forceLogin?: boolean
  groupRequireMention?: boolean
  reconnectDelayMs?: number
}

export type RawChannelConfig =
  | RawWechatChannelConfig
  | RawLarkChannelConfig
  | RawTelegramChannelConfig
  | RawWhatsAppChannelConfig

export interface RawGatewayConfig {
  gateway?: {
    idleTimeoutMs?: number
    maxConcurrentSessions?: number
    logLevel?: LogLevel
  }
  protocol?: RawAcpProtocolConfig & {
    type?: string
  }
  channels?: RawChannelConfig[]
}

export interface ResolvedWechatChannelConfig {
  id: string
  type: 'wechat'
  dataDirectoryPath: string
  apiBaseUrl?: string
  forceLogin: boolean
  longPollTimeoutMs?: number
  qrTtlMs?: number
  reconnectDelayMs?: number
}

export interface ResolvedLarkChannelConfig {
  id: string
  type: 'lark'
  appId: string
  appSecret: string
  groupRequireMention: boolean
}

export interface ResolvedTelegramChannelConfig {
  id: string
  type: 'telegram'
  botToken: string
}

export interface ResolvedWhatsAppChannelConfig {
  id: string
  type: 'whatsapp'
  authDirectoryPath: string
  forceLogin: boolean
  groupRequireMention: boolean
  reconnectDelayMs?: number
}

export type ResolvedChannelConfig =
  | ResolvedWechatChannelConfig
  | ResolvedLarkChannelConfig
  | ResolvedTelegramChannelConfig
  | ResolvedWhatsAppChannelConfig

export interface ResolvedGatewayConfig {
  gateway: {
    idleTimeoutMs: number
    maxConcurrentSessions: number
    logLevel: LogLevel
  }
  protocol: ResolvedAcpProtocolConfig
  channels: ResolvedChannelConfig[]
  warnings: string[]
}

export interface LoadGatewayConfigOptions {
  filePath?: string
  agentSelection?: string
  cwd?: string
  showThoughts?: boolean
  forceLogin?: boolean
  logLevel?: LogLevel
}

const DEFAULT_IDLE_TIMEOUT_MS = 24 * 60 * 60_000
const DEFAULT_MAX_CONCURRENT_SESSIONS = 10
const DEFAULT_WECHAT_CHANNEL_ID = 'wechat-main'

function expandEnvString(value: string): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}/gi, (_, name: string) => process.env[name] ?? '')
}

function expandEnvValues<T>(value: T): T {
  if (typeof value === 'string') {
    return expandEnvString(value) as T
  }

  if (Array.isArray(value)) {
    return value.map((item) => expandEnvValues(item)) as T
  }

  if (value && typeof value === 'object') {
    const expandedEntries = Object.entries(value).map(([key, entry]) => [
      key,
      expandEnvValues(entry)
    ])
    return Object.fromEntries(expandedEntries) as T
  }

  return value
}

function resolvePath(baseDir: string, value: string): string {
  if (value.startsWith('~/')) {
    return join(os.homedir(), value.slice(2))
  }

  return isAbsolute(value) ? value : join(baseDir, value)
}

export async function loadGatewayConfig(
  options: LoadGatewayConfigOptions = {}
): Promise<ResolvedGatewayConfig> {
  const warnings: string[] = []
  const configSource = await readGatewayConfigSource({ filePath: options.filePath })
  const configBaseDir = configSource.configBaseDir
  const rawConfig = expandEnvValues(configSource.config ?? ({} as RawGatewayConfig))

  const protocolType = rawConfig.protocol?.type ?? 'acp'
  if (protocolType !== 'acp') {
    throw new Error(`Unsupported protocol "${protocolType}". ACP is the only implemented protocol today.`)
  }

  const normalizedRawProtocol =
    rawConfig.protocol?.agent?.cwd != null
      ? {
          ...rawConfig.protocol,
          agent: {
            ...rawConfig.protocol.agent,
            cwd: resolvePath(configBaseDir, rawConfig.protocol.agent.cwd)
          }
        }
      : rawConfig.protocol

  if (
    !options.agentSelection &&
    !rawConfig.protocol?.agent?.preset &&
    !rawConfig.protocol?.agent?.command
  ) {
    warnings.push(
      `No ACP agent configured. Defaulting to "${DEFAULT_ACP_AGENT_PRESET}" via npx and it will be installed automatically if needed.`
    )
  }

  const protocol = resolveAcpProtocolConfig({
    raw: normalizedRawProtocol,
    agentSelection: options.agentSelection,
    cwd: options.cwd ? resolvePath(configBaseDir, options.cwd) : undefined,
    showThoughts: options.showThoughts
  })

  if ((rawConfig.channels?.length ?? 0) === 0) {
    warnings.push(
      'No channels configured. Defaulting to a single "wechat" channel and QR login will be shown in the terminal.'
    )
  }

  const channels = resolveChannels(rawConfig.channels ?? [], {
    baseDir: configBaseDir,
    forceLogin: options.forceLogin ?? false
  })

  return {
    gateway: {
      idleTimeoutMs: rawConfig.gateway?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
      maxConcurrentSessions:
        rawConfig.gateway?.maxConcurrentSessions ?? DEFAULT_MAX_CONCURRENT_SESSIONS,
      logLevel: options.logLevel ?? rawConfig.gateway?.logLevel ?? 'info'
    },
    protocol,
    channels,
    warnings
  }
}

function resolveChannels(
  channels: RawChannelConfig[],
  input: {
    baseDir: string
    forceLogin: boolean
  }
): ResolvedChannelConfig[] {
  const normalizedChannels: RawChannelConfig[] =
    channels.length > 0
      ? channels
      : [
          {
            type: 'wechat',
            id: DEFAULT_WECHAT_CHANNEL_ID,
            dataDirectoryPath: join(
              defaultStorageDir(),
              'channels',
              DEFAULT_WECHAT_CHANNEL_ID
            )
          }
        ]

  return normalizedChannels.map((channel, index) => {
    switch (channel.type) {
      case 'wechat':
        return {
          id: channel.id ?? `wechat-${index + 1}`,
          type: 'wechat',
          dataDirectoryPath: resolvePath(
            input.baseDir,
            channel.dataDirectoryPath ??
              join(defaultStorageDir(), 'channels', channel.id ?? `wechat-${index + 1}`)
          ),
          apiBaseUrl: channel.apiBaseUrl,
          forceLogin: input.forceLogin || channel.forceLogin || false,
          longPollTimeoutMs: channel.longPollTimeoutMs,
          qrTtlMs: channel.qrTtlMs,
          reconnectDelayMs: channel.reconnectDelayMs
        }

      case 'lark':
        return {
          id: channel.id ?? `lark-${index + 1}`,
          type: 'lark',
          appId: channel.appId,
          appSecret: channel.appSecret,
          groupRequireMention: channel.groupRequireMention ?? true
        }

      case 'telegram':
        return {
          id: channel.id ?? `telegram-${index + 1}`,
          type: 'telegram',
          botToken: channel.botToken
        }

      case 'whatsapp':
        return {
          id: channel.id ?? `whatsapp-${index + 1}`,
          type: 'whatsapp',
          authDirectoryPath: resolvePath(
            input.baseDir,
            channel.authDirectoryPath ??
              join(defaultStorageDir(), 'channels', channel.id ?? `whatsapp-${index + 1}`)
          ),
          forceLogin: input.forceLogin || channel.forceLogin || false,
          groupRequireMention: channel.groupRequireMention ?? true,
          reconnectDelayMs: channel.reconnectDelayMs
        }
    }
  })
}
