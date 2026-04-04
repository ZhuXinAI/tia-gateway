import type { Logger } from '../logging.js'
import type {
  ResolvedChannelConfig,
  ResolvedGatewayConfig,
  ResolvedHttpChannelConfig,
  ResolvedLarkChannelConfig,
  ResolvedTelegramChannelConfig,
  ResolvedWebSocketChannelConfig,
  ResolvedWhatsAppChannelConfig,
  ResolvedWechatChannelConfig
} from '../config.js'
import type { AgentProtocolAdapter, ChannelAdapter } from '../core/types.js'
import { HttpChannel } from './http-channel/index.js'
import { LarkChannel } from './lark-channel.js'
import type { WhatsAppChannelState } from './whatsapp-channel.js'
import { TelegramChannel } from './telegram-channel.js'
import { WebSocketChannel } from './websocket-channel.js'
import { WhatsAppChannel } from './whatsapp-channel.js'
import { WechatChannel } from './wechat-channel/index.js'

export interface ChannelFactoryOptions {
  logger: Logger
  protocol?: AgentProtocolAdapter
  protocolConfig?: ResolvedGatewayConfig['protocol']
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
    case 'http':
      return createHttpChannel(config, options)
    case 'websocket':
      return createWebSocketChannel(config, options)
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

function createHttpChannel(
  config: ResolvedHttpChannelConfig,
  options: ChannelFactoryOptions
): ChannelAdapter {
  return new HttpChannel({
    id: config.id,
    host: config.host,
    port: config.port,
    chatPath: config.chatPath,
    ssePath: config.ssePath,
    token: config.token,
    serveWebApp: config.serveWebApp,
    autoGenerateToken: config.autoGenerateToken,
    title: config.title,
    acpBridge:
      options.protocol && options.protocolConfig
        ? {
            config: options.protocolConfig,
            protocol: options.protocol
          }
        : undefined,
    logger: options.logger
  })
}

function createWebSocketChannel(
  config: ResolvedWebSocketChannelConfig,
  options: ChannelFactoryOptions
): ChannelAdapter {
  return new WebSocketChannel({
    id: config.id,
    host: config.host,
    port: config.port,
    path: config.path,
    token: config.token,
    logger: options.logger
  })
}
