import type { Logger } from '../logging.js'
import type {
  ResolvedChannelConfig,
  ResolvedLarkChannelConfig,
  ResolvedTelegramChannelConfig,
  ResolvedWhatsAppChannelConfig,
  ResolvedWechatChannelConfig
} from '../config.js'
import type { ChannelAdapter } from '../core/types.js'
import { LarkChannel } from './lark-channel.js'
import type { WhatsAppChannelState } from './whatsapp-channel.js'
import { TelegramChannel } from './telegram-channel.js'
import { WhatsAppChannel } from './whatsapp-channel.js'
import { WechatChannel } from './wechat-channel.js'

export interface ChannelFactoryOptions {
  logger: Logger
  onWechatQrCode?: (input: { channelId: string; value: string }) => Promise<void> | void
  onWhatsAppQrCode?: (input: { channelId: string; value: string }) => Promise<void> | void
  onWhatsAppStateChange?: (input: {
    channelId: string
    state: WhatsAppChannelState
  }) => Promise<void> | void
}

export function createChannel(
  config: ResolvedChannelConfig,
  options: ChannelFactoryOptions
): ChannelAdapter {
  switch (config.type) {
    case 'wechat':
      return createWechatChannel(config, options)
    case 'lark':
      return createLarkChannel(config, options)
    case 'telegram':
      return createTelegramChannel(config, options)
    case 'whatsapp':
      return createWhatsAppChannel(config, options)
  }
}

export function createChannels(
  configs: ResolvedChannelConfig[],
  options: ChannelFactoryOptions
): ChannelAdapter[] {
  return configs.map((config) => createChannel(config, options))
}

function createWechatChannel(
  config: ResolvedWechatChannelConfig,
  options: ChannelFactoryOptions
): ChannelAdapter {
  return new WechatChannel({
    id: config.id,
    dataDirectoryPath: config.dataDirectoryPath,
    apiBaseUrl: config.apiBaseUrl,
    forceLogin: config.forceLogin,
    longPollTimeoutMs: config.longPollTimeoutMs,
    qrTtlMs: config.qrTtlMs,
    reconnectDelayMs: config.reconnectDelayMs,
    logger: options.logger,
    onQrCode: (value) => options.onWechatQrCode?.({ channelId: config.id, value }),
    onStateChange: (state) => {
      options.logger.info(
        `Wechat channel ${config.id} state changed to ${state.status}`,
        state.errorMessage ? { errorMessage: state.errorMessage } : undefined
      )
    }
  })
}

function createLarkChannel(
  config: ResolvedLarkChannelConfig,
  options: ChannelFactoryOptions
): ChannelAdapter {
  return new LarkChannel({
    id: config.id,
    appId: config.appId,
    appSecret: config.appSecret,
    groupRequireMention: config.groupRequireMention,
    logger: options.logger
  })
}

function createTelegramChannel(
  config: ResolvedTelegramChannelConfig,
  options: ChannelFactoryOptions
): ChannelAdapter {
  return new TelegramChannel({
    id: config.id,
    botToken: config.botToken,
    logger: options.logger
  })
}

function createWhatsAppChannel(
  config: ResolvedWhatsAppChannelConfig,
  options: ChannelFactoryOptions
): ChannelAdapter {
  return new WhatsAppChannel({
    id: config.id,
    authDirectoryPath: config.authDirectoryPath,
    forceLogin: config.forceLogin,
    groupRequireMention: config.groupRequireMention,
    reconnectDelayMs: config.reconnectDelayMs,
    logger: options.logger,
    onQrCode: (value) => options.onWhatsAppQrCode?.({ channelId: config.id, value }),
    onStateChange: (state) => {
      options.logger.info(
        `WhatsApp channel ${config.id} state changed to ${state.status}`,
        state.phoneNumber
          ? { phoneNumber: state.phoneNumber }
          : state.errorMessage
            ? { errorMessage: state.errorMessage }
            : undefined
      )
      return options.onWhatsAppStateChange?.({ channelId: config.id, state })
    }
  })
}
