import type { ChannelMessage } from '../../core/types.js'
import { createWechatClientId } from './utils.js'
import type { WechatInboundMessage } from './types.js'

function formatWechatMessageText(message: WechatInboundMessage): string | null {
  const textParts: string[] = []

  for (const item of message.item_list ?? []) {
    switch (item.type) {
      case 1:
        textParts.push(item.text_item?.text ?? '')
        break
      case 2:
        textParts.push('[Image]')
        break
      case 3:
        textParts.push(item.voice_item?.text ? `[Voice: ${item.voice_item.text}]` : '[Voice]')
        break
      case 4:
        textParts.push(item.file_item?.file_name ? `[File: ${item.file_item.file_name}]` : '[File]')
        break
      case 5:
        textParts.push('[Video]')
        break
      default:
        break
    }
  }

  let text = textParts.join('\n').trim()
  if (message.ref_msg) {
    const replyText =
      message.ref_msg.message_item?.text_item?.text?.trim() ?? message.ref_msg.title?.trim() ?? ''
    if (replyText.length > 0) {
      text = `[Reply to: ${replyText}]\n${text}`.trim()
    }
  }

  return text.length > 0 ? text : null
}

function toTimestamp(value: number | undefined): Date {
  if (!Number.isFinite(value)) {
    return new Date()
  }

  const timestamp = new Date(Number(value))
  return Number.isNaN(timestamp.getTime()) ? new Date() : timestamp
}

export function toChannelMessage(message: WechatInboundMessage): ChannelMessage | null {
  const remoteChatId = typeof message.from_user_id === 'string' ? message.from_user_id.trim() : ''
  const text = formatWechatMessageText(message)

  if (remoteChatId.length === 0 || !text) {
    return null
  }

  return {
    id: String(message.message_id ?? createWechatClientId()),
    remoteChatId,
    senderId: remoteChatId,
    text,
    timestamp: toTimestamp(message.create_time_ms),
    metadata: {
      wechatMessageId: message.message_id ?? null,
      wechatFromUserId: message.from_user_id ?? null,
      wechatToUserId: message.to_user_id ?? null,
      wechatClientId: message.client_id ?? null,
      wechatContextToken: message.context_token ?? null,
      wechatItemTypes: (message.item_list ?? []).map((item) => item.type ?? 0)
    }
  }
}
