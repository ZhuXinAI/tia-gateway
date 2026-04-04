import type { Logger } from '../../logging.js'
import type {
  AgentProtocolAdapter,
  ProtocolContentBlock
} from '../../core/types.js'
import type { ResolvedAcpProtocolConfig } from '../../protocols/acp/config.js'

export type PendingToolState = {
  toolName: string
  inputStarted: boolean
  inputAvailable: boolean
  outputSettled: boolean
}

export type PendingTurn = {
  chatId: string
  requestMessageId: string
  streamId: string
  assistantMessageId: string
  textPartId: string
  reasoningPartId: string
  responseStream: ReadableStream<string>
  controller: ReadableStreamDefaultController<string> | null
  messageStarted: boolean
  textStarted: boolean
  reasoningStarted: boolean
  toolStates: Map<string, PendingToolState>
  closed: boolean
}

export type HttpUiMessagePart = {
  type?: string
  text?: string
  url?: string
  mediaType?: string
  filename?: string
}

export type HttpUiMessage = {
  id?: string
  role?: string
  text?: string
  content?: string
  parts?: HttpUiMessagePart[]
}

export type HttpChatRequestBody = {
  id?: string
  chatId?: string
  senderId?: string
  message?: HttpUiMessage
  messages?: HttpUiMessage[]
  metadata?: Record<string, unknown>
}

export type PersistedHttpToken = {
  token?: string
  createdAt?: string
}

export type ResolvedHttpToken = {
  token?: string
  created: boolean
}

export type ParsedHttpUiMessage = {
  text: string
  contentBlocks?: ProtocolContentBlock[]
}

export interface HttpChannelOptions {
  id: string
  host: string
  port: number
  chatPath?: string
  ssePath?: string
  token?: string
  serveWebApp?: boolean
  autoGenerateToken?: boolean
  title?: string
  acpBridge?: {
    config: ResolvedAcpProtocolConfig
    protocol: AgentProtocolAdapter
  }
  logger: Logger
}
