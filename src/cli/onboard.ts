import { access } from 'node:fs/promises'
import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { join } from 'node:path'
import qrcodeTerminal from 'qrcode-terminal'
import { WhatsAppChannel } from '../channels/whatsapp-channel.js'
import { WechatChannel } from '../channels/wechat-channel/index.js'
import { createLogger } from '../logging.js'
import type { RawGatewayConfig } from '../config.js'
import {
  defaultStorageDir,
  describeGatewayConfigSource,
  readGatewayConfigSource,
  resolveConfigValuePath,
  type GatewayConfigSource,
  writeGatewayConfigSource
} from '../config-store.js'
import {
  createSeedGatewayConfig,
  listAvailableAgentPresets,
  upsertAcpAgentSelection,
  upsertHttpChannelConfig,
  upsertLarkChannelConfig,
  upsertTelegramChannelConfig,
  upsertWebSocketChannelConfig,
  upsertWhatsAppChannelConfig,
  upsertWechatChannelConfig
} from './config.js'
import {
  DEFAULT_ACP_AGENT_PRESET,
  parseAgentCommand
} from '../protocols/acp/config.js'

export type OnboardChannelType =
  | 'wechat'
  | 'whatsapp'
  | 'telegram'
  | 'lark'
  | 'http'
  | 'websocket'

export type OnboardChannelOption = {
  key: string
  type: OnboardChannelType
  label: string
}

export type RunOnboardOptions = {
  willStartGatewayAfterCompletion?: boolean
}

type QuestionInterface = Pick<ReturnType<typeof createInterface>, 'question' | 'close'>

type WechatLikeChannelState = {
  status: 'disconnected' | 'connecting' | 'qr_ready' | 'connected' | 'error'
  accountId?: string | null
  errorMessage?: string | null
}

type WhatsAppLikeChannelState = {
  status: 'disconnected' | 'connecting' | 'qr_ready' | 'connected' | 'error'
  phoneNumber?: string | null
  errorMessage?: string | null
}

const DEFAULT_CHANNEL_IDS: Record<OnboardChannelType, string> = {
  wechat: 'wechat-main',
  whatsapp: 'whatsapp-main',
  telegram: 'telegram-main',
  lark: 'lark-main',
  http: 'http-main',
  websocket: 'websocket-main'
}

const DEFAULT_HTTP_HOST = '127.0.0.1'
const DEFAULT_HTTP_PORT = 4311
const DEFAULT_HTTP_CHAT_PATH = '/chat'
const DEFAULT_HTTP_SSE_PATH = '/sse'
const DEFAULT_HTTP_TITLE = 'TIA Gateway'
const DEFAULT_WEBSOCKET_PORT = 4312
const DEFAULT_WEBSOCKET_PATH = '/ws'

function defaultChannelStoragePath(channelId: string): string {
  return `~/.tia-gateway/channels/${channelId}`
}

function ensureInteractiveTerminal(): void {
  if (!input.isTTY || !output.isTTY) {
    throw new Error('Interactive onboarding requires a TTY. Run this command in a terminal.')
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function askRequired(
  rl: QuestionInterface,
  prompt: string,
  defaultValue = ''
): Promise<string> {
  const suffix = defaultValue ? ` [${defaultValue}]` : ''

  while (true) {
    const answer = (await rl.question(`${prompt}${suffix}: `)).trim()
    if (answer) {
      return answer
    }

    if (defaultValue) {
      return defaultValue
    }

    console.log('This value is required.')
  }
}

async function askYesNo(
  rl: QuestionInterface,
  prompt: string,
  defaultValue: boolean
): Promise<boolean> {
  const suffix = defaultValue ? ' [Y/n]' : ' [y/N]'

  while (true) {
    const answer = (await rl.question(`${prompt}${suffix}: `)).trim().toLowerCase()
    if (!answer) {
      return defaultValue
    }

    if (answer === 'y' || answer === 'yes') {
      return true
    }

    if (answer === 'n' || answer === 'no') {
      return false
    }

    console.log('Please answer y or n.')
  }
}

async function askPort(
  rl: QuestionInterface,
  prompt: string,
  defaultValue: number
): Promise<number> {
  while (true) {
    const answer = await askRequired(rl, prompt, String(defaultValue))
    const port = Number.parseInt(answer, 10)
    if (Number.isInteger(port) && port >= 1 && port <= 65_535) {
      return port
    }

    console.log('Please enter a valid TCP port between 1 and 65535.')
  }
}

function normalizeHttpPath(value: string): string {
  const trimmed = value.trim()
  if (!trimmed || trimmed === '/') {
    return '/'
  }

  const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`
  return withLeadingSlash.length > 1 && withLeadingSlash.endsWith('/')
    ? withLeadingSlash.slice(0, -1)
    : withLeadingSlash
}

function formatDisplayUrl(
  protocol: 'http' | 'ws',
  host: string,
  port: number,
  pathname: string
): string {
  const rawHost =
    host === '0.0.0.0'
      ? '127.0.0.1'
      : host === '::'
        ? '::1'
        : host
  const displayHost =
    rawHost.includes(':') && !rawHost.startsWith('[') ? `[${rawHost}]` : rawHost

  return `${protocol}://${displayHost}:${port}${pathname}`
}

export function listOnboardChannelOptions(existingConfig: RawGatewayConfig | null): {
  defaultSelection: OnboardChannelType
  options: OnboardChannelOption[]
} {
  const existingType = existingConfig?.channels?.[0]?.type
  const defaultSelection: OnboardChannelType =
    existingType === 'wechat' ||
    existingType === 'whatsapp' ||
    existingType === 'telegram' ||
    existingType === 'lark' ||
    existingType === 'http' ||
    existingType === 'websocket'
      ? existingType
      : 'wechat'

  return {
    defaultSelection,
    options: [
      { key: '1', type: 'wechat', label: 'WeChat' },
      { key: '2', type: 'whatsapp', label: 'WhatsApp' },
      { key: '3', type: 'telegram', label: 'Telegram' },
      { key: '4', type: 'lark', label: 'Lark' },
      { key: '5', type: 'http', label: 'HTTP' },
      { key: '6', type: 'websocket', label: 'WebSocket' }
    ]
  }
}

export function buildOnboardCompletionMessages(input: {
  config: RawGatewayConfig | null
  channelType: OnboardChannelType
  willStartGatewayAfterCompletion?: boolean
}): string[] {
  if (input.willStartGatewayAfterCompletion) {
    return ['Onboarding complete. Starting gateway...']
  }

  const messages = [
    'Onboarding complete.',
    'Start the gateway with "npx tia-gateway" to make this channel reachable.'
  ]

  if (input.channelType === 'http') {
    const channel = findChannelByType(input.config, 'http')
    if (channel?.port) {
      messages.push(
        `After it starts, open ${formatDisplayUrl(
          'http',
          channel.host?.trim() || DEFAULT_HTTP_HOST,
          channel.port,
          '/'
        )}.`
      )
    }
  }

  if (input.channelType === 'websocket') {
    const channel = findChannelByType(input.config, 'websocket')
    if (channel?.port) {
      messages.push(
        `After it starts, connect to ${formatDisplayUrl(
          'ws',
          channel.host?.trim() || DEFAULT_HTTP_HOST,
          channel.port,
          normalizeHttpPath(channel.path ?? DEFAULT_WEBSOCKET_PATH)
        )}.`
      )
    }
  }

  return messages
}

function findChannelByType<TType extends OnboardChannelType>(
  config: RawGatewayConfig | null,
  type: TType
): Extract<NonNullable<RawGatewayConfig['channels']>[number], { type: TType }> | null {
  const entry = config?.channels?.find((channel) => channel.type === type)
  return (entry as Extract<NonNullable<RawGatewayConfig['channels']>[number], { type: TType }>) ?? null
}

async function selectChannelType(
  rl: QuestionInterface,
  existingConfig: RawGatewayConfig | null
): Promise<OnboardChannelType> {
  const { defaultSelection, options } = listOnboardChannelOptions(existingConfig)

  console.log('\nChannel setup')
  for (const option of options) {
    console.log(`${option.key}) ${option.label}`)
  }

  while (true) {
    const answer = (
      await rl.question(`Select channel [${options.find((entry) => entry.type === defaultSelection)?.key ?? '1'}]: `)
    )
      .trim()
      .toLowerCase()

    if (!answer) {
      return defaultSelection
    }

    const selectedByKey = options.find((option) => option.key === answer)
    if (selectedByKey) {
      return selectedByKey.type
    }

    const selectedByType = options.find((option) => option.type === answer)
    if (selectedByType) {
      return selectedByType.type
    }

    console.log('Please choose 1, 2, 3, 4, 5, or 6.')
  }
}

async function selectAgentConfig(
  rl: QuestionInterface,
  existingConfig: RawGatewayConfig | null
): Promise<RawGatewayConfig> {
  const presetOptions = listAvailableAgentPresets(existingConfig).map((option, index) => ({
    ...option,
    key: String(index + 1)
  }))
  const customOptionKey = String(presetOptions.length + 1)
  const existingPreset = existingConfig?.protocol?.agent?.preset
  const existingRawCommand = existingConfig?.protocol?.agent?.command
  const existingRawArgs = existingConfig?.protocol?.agent?.args ?? []
  const defaultSelectionKey = existingRawCommand
    ? customOptionKey
    : presetOptions.find((option) => option.id === existingPreset)?.key ??
      presetOptions.find((option) => option.id === DEFAULT_ACP_AGENT_PRESET)?.key ??
      presetOptions[0]?.key ??
      '1'

  console.log('\nAgent setup')
  for (const option of presetOptions) {
    const sourceLabel = option.source === 'custom' ? ' [custom preset]' : ''
    const description = option.preset.description ? ` - ${option.preset.description}` : ''
    console.log(`${option.key}) ${option.id} (${option.preset.label})${sourceLabel}${description}`)
  }
  console.log(`${customOptionKey}) Custom ACP command`)

  while (true) {
    const answer = (await rl.question(`Select agent [${defaultSelectionKey}]: `))
      .trim()
      .toLowerCase()
    const normalizedSelection = answer || defaultSelectionKey

    const selectedPreset =
      presetOptions.find((option) => option.key === normalizedSelection) ??
      presetOptions.find((option) => option.id === normalizedSelection)

    if (selectedPreset) {
      return upsertAcpAgentSelection(createSeedGatewayConfig(existingConfig), {
        mode: 'preset',
        preset: selectedPreset.id
      })
    }

    if (normalizedSelection === customOptionKey || normalizedSelection === 'custom') {
      const defaultCommand = [existingRawCommand, ...existingRawArgs].filter(Boolean).join(' ')

      while (true) {
        if (!defaultCommand) {
          console.log('Enter a full ACP command, for example: npx my-agent --acp')
        }

        const commandInput = await askRequired(
          rl,
          'Custom ACP agent command',
          defaultCommand
        )

        try {
          const parsed = parseAgentCommand(commandInput)
          return upsertAcpAgentSelection(createSeedGatewayConfig(existingConfig), {
            mode: 'raw',
            command: parsed.command,
            args: parsed.args
          })
        } catch (error) {
          console.log(error instanceof Error ? error.message : String(error))
        }
      }
    }

    console.log(`Please choose 1-${customOptionKey}, or enter a preset name.`)
  }
}

async function printSavedConfigMessage(source: GatewayConfigSource): Promise<void> {
  console.log(`\nSaved config to ${describeGatewayConfigSource(source)}`)
}

async function waitForWechatConnection(input: {
  id: string
  dataDirectoryPath: string
  forceLogin: boolean
}): Promise<void> {
  const logger = createLogger('error', 'onboard')
  let channel: WechatChannel | null = null
  let lastQrValue: string | null = null

  try {
    await new Promise<void>((resolve, reject) => {
      let timeoutId: ReturnType<typeof setTimeout> | null = null

      const finish = (callback: () => void) => {
        if (timeoutId) {
          clearTimeout(timeoutId)
          timeoutId = null
        }
        callback()
      }

      channel = new WechatChannel({
        id: input.id,
        dataDirectoryPath: input.dataDirectoryPath,
        forceLogin: input.forceLogin,
        logger,
        onQrCode: (value) => {
          if (value === lastQrValue) {
            return
          }

          lastQrValue = value
          console.log('')
          console.log(`[${input.id}] Scan this WeChat QR code:`)
          qrcodeTerminal.generate(value, { small: true })
          console.log('Waiting for WeChat login confirmation...')
        },
        onStateChange: (state: WechatLikeChannelState) => {
          if (state.status === 'connected') {
            finish(() => resolve())
            return
          }

          if (state.status === 'error') {
            finish(() => reject(new Error(state.errorMessage ?? 'Wechat login failed.')))
          }
        }
      })

      timeoutId = setTimeout(() => {
        finish(() => reject(new Error('Timed out waiting for WeChat login confirmation.')))
      }, 10 * 60_000)

      void channel.start().catch((error) => {
        finish(() => reject(error))
      })
    })
  } finally {
    const activeChannel = channel as WechatChannel | null
    if (activeChannel) {
      await activeChannel.stop().catch(() => undefined)
    }
  }
}

async function waitForWhatsAppConnection(input: {
  id: string
  authDirectoryPath: string
  forceLogin: boolean
}): Promise<void> {
  const logger = createLogger('error', 'onboard')
  let channel: WhatsAppChannel | null = null
  let lastQrValue: string | null = null

  try {
    await new Promise<void>((resolve, reject) => {
      let timeoutId: ReturnType<typeof setTimeout> | null = null

      const finish = (callback: () => void) => {
        if (timeoutId) {
          clearTimeout(timeoutId)
          timeoutId = null
        }
        callback()
      }

      channel = new WhatsAppChannel({
        id: input.id,
        authDirectoryPath: input.authDirectoryPath,
        forceLogin: input.forceLogin,
        logger,
        onQrCode: (value) => {
          if (value === lastQrValue) {
            return
          }

          lastQrValue = value
          console.log('')
          console.log(`[${input.id}] Scan this WhatsApp QR code:`)
          qrcodeTerminal.generate(value, { small: true })
          console.log('Open WhatsApp on your phone, then go to Linked Devices -> Link a Device.')
        },
        onStateChange: (state: WhatsAppLikeChannelState) => {
          if (state.status === 'connected') {
            finish(() => resolve())
            return
          }

          if (state.status === 'error') {
            finish(() => reject(new Error(state.errorMessage ?? 'WhatsApp login failed.')))
          }
        }
      })

      timeoutId = setTimeout(() => {
        finish(() => reject(new Error('Timed out waiting for WhatsApp login confirmation.')))
      }, 10 * 60_000)

      void channel.start().catch((error) => {
        finish(() => reject(error))
      })
    })
  } finally {
    const activeChannel = channel as WhatsAppChannel | null
    if (activeChannel) {
      await activeChannel.stop().catch(() => undefined)
    }
  }
}

async function configureWechatChannel(
  rl: QuestionInterface,
  configSource: GatewayConfigSource,
  existingConfig: RawGatewayConfig | null
): Promise<RawGatewayConfig> {
  const existingChannel = findChannelByType(existingConfig, 'wechat')
  const channelId = existingChannel?.id ?? DEFAULT_CHANNEL_IDS.wechat
  const dataDirectoryPath =
    existingChannel?.dataDirectoryPath ?? defaultChannelStoragePath(channelId)

  const nextConfig = upsertWechatChannelConfig(createSeedGatewayConfig(existingConfig), {
    id: channelId,
    type: 'wechat',
    dataDirectoryPath,
    apiBaseUrl: existingChannel?.apiBaseUrl,
    forceLogin: false,
    longPollTimeoutMs: existingChannel?.longPollTimeoutMs,
    qrTtlMs: existingChannel?.qrTtlMs,
    reconnectDelayMs: existingChannel?.reconnectDelayMs
  })

  const savedConfigSource = await writeGatewayConfigSource(configSource, nextConfig)
  await printSavedConfigMessage(savedConfigSource)

  const absoluteDataDirectoryPath = resolveConfigValuePath(
    savedConfigSource.configBaseDir,
    dataDirectoryPath
  )
  const hasSession = await pathExists(join(absoluteDataDirectoryPath, 'account.json'))

  if (hasSession) {
    console.log('\nWeChat setup')
    console.log(`Existing WeChat session found for channel "${channelId}".`)
    const relogin = await askYesNo(rl, 'Re-login now', false)
    if (!relogin) {
      return nextConfig
    }
  } else {
    console.log('\nWeChat setup')
    console.log('No saved WeChat session found. Starting QR login now.')
  }

  await waitForWechatConnection({
    id: channelId,
    dataDirectoryPath: absoluteDataDirectoryPath,
    forceLogin: hasSession
  })
  console.log('WeChat is connected and ready.')
  return nextConfig
}

async function configureWhatsAppChannel(
  rl: QuestionInterface,
  configSource: GatewayConfigSource,
  existingConfig: RawGatewayConfig | null
): Promise<RawGatewayConfig> {
  const existingChannel = findChannelByType(existingConfig, 'whatsapp')
  const channelId = existingChannel?.id ?? DEFAULT_CHANNEL_IDS.whatsapp
  const authDirectoryPath =
    existingChannel?.authDirectoryPath ?? defaultChannelStoragePath(channelId)
  const groupRequireMention = await askYesNo(
    rl,
    'Require mentioning the bot in WhatsApp group chats',
    existingChannel?.groupRequireMention ?? true
  )

  const nextConfig = upsertWhatsAppChannelConfig(createSeedGatewayConfig(existingConfig), {
    id: channelId,
    type: 'whatsapp',
    authDirectoryPath,
    forceLogin: false,
    groupRequireMention,
    reconnectDelayMs: existingChannel?.reconnectDelayMs
  })

  const savedConfigSource = await writeGatewayConfigSource(configSource, nextConfig)
  await printSavedConfigMessage(savedConfigSource)

  const absoluteAuthDirectoryPath = resolveConfigValuePath(
    savedConfigSource.configBaseDir,
    authDirectoryPath
  )
  const hasSession = await pathExists(join(absoluteAuthDirectoryPath, 'creds.json'))

  if (hasSession) {
    console.log('\nWhatsApp setup')
    console.log(`Existing WhatsApp session found for channel "${channelId}".`)
    const relogin = await askYesNo(rl, 'Re-link now', false)
    if (!relogin) {
      return nextConfig
    }
  } else {
    console.log('\nWhatsApp setup')
    console.log('No saved WhatsApp session found. Starting QR login now.')
  }

  await waitForWhatsAppConnection({
    id: channelId,
    authDirectoryPath: absoluteAuthDirectoryPath,
    forceLogin: hasSession
  })
  console.log('WhatsApp is connected and ready.')
  return nextConfig
}

async function configureTelegramChannel(
  rl: QuestionInterface,
  configSource: GatewayConfigSource,
  existingConfig: RawGatewayConfig | null
): Promise<RawGatewayConfig> {
  const existingChannel = findChannelByType(existingConfig, 'telegram')
  const channelId = existingChannel?.id ?? DEFAULT_CHANNEL_IDS.telegram
  console.log('\nTelegram setup')
  const botToken = await askRequired(
    rl,
    'Telegram bot token',
    existingChannel?.botToken ?? process.env.TELEGRAM_BOT_TOKEN ?? ''
  )

  const nextConfig = upsertTelegramChannelConfig(createSeedGatewayConfig(existingConfig), {
    id: channelId,
    type: 'telegram',
    botToken
  })

  const savedConfigSource = await writeGatewayConfigSource(configSource, nextConfig)
  await printSavedConfigMessage(savedConfigSource)
  return nextConfig
}

async function configureLarkChannel(
  rl: QuestionInterface,
  configSource: GatewayConfigSource,
  existingConfig: RawGatewayConfig | null
): Promise<RawGatewayConfig> {
  const existingChannel = findChannelByType(existingConfig, 'lark')
  const channelId = existingChannel?.id ?? DEFAULT_CHANNEL_IDS.lark
  console.log('\nLark setup')
  const appId = await askRequired(
    rl,
    'Lark app ID',
    existingChannel?.appId ?? process.env.LARK_APP_ID ?? ''
  )
  const appSecret = await askRequired(
    rl,
    'Lark app secret',
    existingChannel?.appSecret ?? process.env.LARK_APP_SECRET ?? ''
  )
  const groupRequireMention = await askYesNo(
    rl,
    'Require mentioning the bot in Lark group chats',
    existingChannel?.groupRequireMention ?? true
  )

  const nextConfig = upsertLarkChannelConfig(createSeedGatewayConfig(existingConfig), {
    id: channelId,
    type: 'lark',
    appId,
    appSecret,
    groupRequireMention
  })

  const savedConfigSource = await writeGatewayConfigSource(configSource, nextConfig)
  await printSavedConfigMessage(savedConfigSource)
  return nextConfig
}

async function configureHttpChannel(
  rl: QuestionInterface,
  configSource: GatewayConfigSource,
  existingConfig: RawGatewayConfig | null
): Promise<RawGatewayConfig> {
  const existingChannel = findChannelByType(existingConfig, 'http')
  const channelId = existingChannel?.id ?? DEFAULT_CHANNEL_IDS.http

  console.log('\nHTTP setup')
  const host = await askRequired(rl, 'Bind host', existingChannel?.host ?? DEFAULT_HTTP_HOST)
  const port = await askPort(rl, 'Bind port', existingChannel?.port ?? DEFAULT_HTTP_PORT)
  const chatPath = normalizeHttpPath(
    await askRequired(rl, 'Chat path', existingChannel?.chatPath ?? DEFAULT_HTTP_CHAT_PATH)
  )
  const ssePath = normalizeHttpPath(
    await askRequired(rl, 'SSE path', existingChannel?.ssePath ?? DEFAULT_HTTP_SSE_PATH)
  )
  const serveWebApp = await askYesNo(
    rl,
    'Serve the built-in browser chat UI',
    existingChannel?.serveWebApp ?? true
  )
  const protectWithToken = await askYesNo(
    rl,
    'Protect HTTP routes with a token',
    Boolean(existingChannel?.token || existingChannel?.autoGenerateToken)
  )

  let autoGenerateToken = false
  let token: string | undefined
  if (protectWithToken) {
    autoGenerateToken = await askYesNo(
      rl,
      'Auto-generate the token on first start',
      existingChannel?.autoGenerateToken ?? true
    )

    if (!autoGenerateToken) {
      token = await askRequired(rl, 'Static access token', existingChannel?.token ?? '')
    }
  }

  const title = serveWebApp
    ? await askRequired(rl, 'Web UI title', existingChannel?.title ?? DEFAULT_HTTP_TITLE)
    : existingChannel?.title ?? DEFAULT_HTTP_TITLE

  const nextConfig = upsertHttpChannelConfig(createSeedGatewayConfig(existingConfig), {
    id: channelId,
    type: 'http',
    host,
    port,
    chatPath,
    ssePath,
    token,
    serveWebApp,
    autoGenerateToken,
    title
  })

  const savedConfigSource = await writeGatewayConfigSource(configSource, nextConfig)
  await printSavedConfigMessage(savedConfigSource)
  console.log(`HTTP API will listen on ${formatDisplayUrl('http', host, port, chatPath)}.`)
  if (serveWebApp) {
    console.log(`Web UI will be available at ${formatDisplayUrl('http', host, port, '/')}.`)
  }
  if (protectWithToken && autoGenerateToken) {
    console.log('A token will be generated automatically on first start.')
  }

  return nextConfig
}

async function configureWebSocketChannel(
  rl: QuestionInterface,
  configSource: GatewayConfigSource,
  existingConfig: RawGatewayConfig | null
): Promise<RawGatewayConfig> {
  const existingChannel = findChannelByType(existingConfig, 'websocket')
  const channelId = existingChannel?.id ?? DEFAULT_CHANNEL_IDS.websocket

  console.log('\nWebSocket setup')
  const host = await askRequired(rl, 'Bind host', existingChannel?.host ?? DEFAULT_HTTP_HOST)
  const port = await askPort(rl, 'Bind port', existingChannel?.port ?? DEFAULT_WEBSOCKET_PORT)
  const path = normalizeHttpPath(
    await askRequired(rl, 'WebSocket path', existingChannel?.path ?? DEFAULT_WEBSOCKET_PATH)
  )
  const protectWithToken = await askYesNo(
    rl,
    'Protect WebSocket connections with a token',
    Boolean(existingChannel?.token)
  )
  const token = protectWithToken
    ? await askRequired(rl, 'Static access token', existingChannel?.token ?? '')
    : undefined

  const nextConfig = upsertWebSocketChannelConfig(createSeedGatewayConfig(existingConfig), {
    id: channelId,
    type: 'websocket',
    host,
    port,
    path,
    token
  })

  const savedConfigSource = await writeGatewayConfigSource(configSource, nextConfig)
  await printSavedConfigMessage(savedConfigSource)
  console.log(`WebSocket endpoint will listen on ${formatDisplayUrl('ws', host, port, path)}.`)

  return nextConfig
}

export async function runOnboard(
  configPath?: string,
  options: RunOnboardOptions = {}
): Promise<void> {
  ensureInteractiveTerminal()

  const configSource = await readGatewayConfigSource({ filePath: configPath })
  const existingConfig = configSource.config
  const rl = createInterface({ input, output })

  try {
    console.log(`Interactive onboarding for ${describeGatewayConfigSource(configSource)}`)
    console.log(`Default channel data lives under ${join(defaultStorageDir(), 'channels')}`)

    const configWithSelectedAgent = await selectAgentConfig(rl, existingConfig)
    const channelType = await selectChannelType(rl, configWithSelectedAgent)
    let nextConfig: RawGatewayConfig
    switch (channelType) {
      case 'wechat':
        nextConfig = await configureWechatChannel(rl, configSource, configWithSelectedAgent)
        break
      case 'whatsapp':
        nextConfig = await configureWhatsAppChannel(rl, configSource, configWithSelectedAgent)
        break
      case 'telegram':
        nextConfig = await configureTelegramChannel(rl, configSource, configWithSelectedAgent)
        break
      case 'lark':
        nextConfig = await configureLarkChannel(rl, configSource, configWithSelectedAgent)
        break
      case 'http':
        nextConfig = await configureHttpChannel(rl, configSource, configWithSelectedAgent)
        break
      case 'websocket':
        nextConfig = await configureWebSocketChannel(rl, configSource, configWithSelectedAgent)
        break
    }

    for (const message of buildOnboardCompletionMessages({
      config: nextConfig,
      channelType,
      willStartGatewayAfterCompletion: options.willStartGatewayAfterCompletion
    })) {
      console.log(message)
    }
  } finally {
    rl.close()
  }
}
