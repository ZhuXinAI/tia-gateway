import { access } from 'node:fs/promises'
import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { join } from 'node:path'
import qrcodeTerminal from 'qrcode-terminal'
import { WhatsAppChannel } from '../channels/whatsapp-channel.js'
import { WechatChannel } from '../channels/wechat-channel.js'
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
  upsertLarkChannelConfig,
  upsertTelegramChannelConfig,
  upsertWhatsAppChannelConfig,
  upsertWechatChannelConfig
} from './config.js'
import {
  DEFAULT_ACP_AGENT_PRESET,
  parseAgentCommand
} from '../protocols/acp/config.js'

type OnboardChannelType = 'wechat' | 'whatsapp' | 'telegram' | 'lark'

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
  lark: 'lark-main'
}

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
  const existingType = existingConfig?.channels?.[0]?.type
  const defaultSelection =
    existingType === 'wechat' ||
    existingType === 'whatsapp' ||
    existingType === 'telegram' ||
    existingType === 'lark'
      ? existingType
      : 'wechat'

  const options: Array<{ key: string; type: OnboardChannelType; label: string }> = [
    { key: '1', type: 'wechat', label: 'WeChat' },
    { key: '2', type: 'whatsapp', label: 'WhatsApp' },
    { key: '3', type: 'telegram', label: 'Telegram' },
    { key: '4', type: 'lark', label: 'Lark' }
  ]

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

    console.log('Please choose 1, 2, 3, or 4.')
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

export async function runOnboard(configPath?: string): Promise<void> {
  ensureInteractiveTerminal()

  const configSource = await readGatewayConfigSource({ filePath: configPath })
  const existingConfig = configSource.config
  const rl = createInterface({ input, output })

  try {
    console.log(`Interactive onboarding for ${describeGatewayConfigSource(configSource)}`)
    console.log(`Default channel data lives under ${join(defaultStorageDir(), 'channels')}`)

    const configWithSelectedAgent = await selectAgentConfig(rl, existingConfig)
    const channelType = await selectChannelType(rl, configWithSelectedAgent)
    switch (channelType) {
      case 'wechat':
        await configureWechatChannel(rl, configSource, configWithSelectedAgent)
        break
      case 'whatsapp':
        await configureWhatsAppChannel(rl, configSource, configWithSelectedAgent)
        break
      case 'telegram':
        await configureTelegramChannel(rl, configSource, configWithSelectedAgent)
        break
      case 'lark':
        await configureLarkChannel(rl, configSource, configWithSelectedAgent)
        break
    }

    console.log('Onboarding complete.')
  } finally {
    rl.close()
  }
}
