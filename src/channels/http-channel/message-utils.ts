import { randomUUID } from 'node:crypto'
import type { UIMessage } from 'ai'
import type { ProtocolContentBlock } from '../../core/types.js'
import type {
  HttpChatRequestBody,
  HttpUiMessage,
  ParsedHttpUiMessage
} from './types.js'

export function extractLastUserMessage(
  messages: HttpUiMessage[] | undefined
): HttpUiMessage | undefined {
  if (!messages || messages.length === 0) {
    return undefined
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role === 'user') {
      return message
    }
  }

  return messages[messages.length - 1]
}

export function parseUiMessage(message: HttpUiMessage | undefined): ParsedHttpUiMessage {
  if (!message) {
    return { text: '' }
  }

  const contentBlocks: ProtocolContentBlock[] = []
  const parts = message.parts ?? []

  for (const part of parts) {
    if (part.type === 'text' && part.text) {
      contentBlocks.push({
        type: 'text',
        text: part.text
      })
    }

    if (part.type === 'file' && part.url && part.mediaType) {
      contentBlocks.push({
        type: 'resource',
        resource: {
          uri: part.url,
          mimeType: part.mediaType
        }
      })
    }
  }

  const fallbackText = message.text?.trim() || message.content?.trim() || ''
  if (contentBlocks.length === 0 && fallbackText) {
    contentBlocks.push({
      type: 'text',
      text: fallbackText
    })
  }

  const text = contentBlocks
    .filter((block): block is Extract<ProtocolContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim()

  return {
    text,
    contentBlocks: contentBlocks.length > 0 ? contentBlocks : undefined
  }
}

function normalizeUiMessage(
  message: HttpUiMessage | undefined,
  fallbackRole: UIMessage['role'] = 'user'
): UIMessage | undefined {
  if (!message) {
    return undefined
  }

  const parts: UIMessage['parts'] = []
  for (const part of message.parts ?? []) {
    if (part.type === 'text' && part.text) {
      parts.push({
        type: 'text',
        text: part.text
      })
      continue
    }

    if (part.type === 'file' && part.url && part.mediaType) {
      parts.push({
        type: 'file',
        url: part.url,
        mediaType: part.mediaType,
        ...(part.filename ? { filename: part.filename } : {})
      })
    }
  }

  if (parts.length === 0) {
    const fallbackText = message.text?.trim() || message.content?.trim() || ''
    if (fallbackText) {
      parts.push({
        type: 'text',
        text: fallbackText
      })
    }
  }

  if (parts.length === 0) {
    return undefined
  }

  const role =
    message.role === 'assistant' || message.role === 'system' || message.role === 'user'
      ? message.role
      : fallbackRole

  return {
    id: message.id?.trim() || randomUUID(),
    role,
    parts
  }
}

export function normalizeUiMessages(body: HttpChatRequestBody): UIMessage[] {
  const normalizedMessages = (body.messages ?? [])
    .map((message) => normalizeUiMessage(message))
    .filter((message): message is UIMessage => message != null)

  if (normalizedMessages.length > 0) {
    return normalizedMessages
  }

  const singleMessage = normalizeUiMessage(body.message)
  return singleMessage ? [singleMessage] : []
}
