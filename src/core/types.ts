export type ChannelType =
  | 'wechat'
  | 'lark'
  | 'telegram'
  | 'whatsapp'
  | 'http'
  | 'websocket'
  | (string & {})
export type AgentProtocolType = 'acp' | (string & {})

export type TextContentBlock = {
  type: 'text'
  text: string
}

export type ImageContentBlock = {
  type: 'image'
  data: string
  mimeType: string
}

export type ResourceContentBlock = {
  type: 'resource'
  resource: {
    uri: string
    mimeType: string
    text?: string
    data?: string
  }
}

export type ProtocolContentBlock = TextContentBlock | ImageContentBlock | ResourceContentBlock

export interface ChannelMessage {
  id: string
  remoteChatId: string
  senderId: string
  text: string
  timestamp: Date
  metadata?: Record<string, unknown>
  contentBlocks?: ProtocolContentBlock[]
}

export type AgentProtocolEvent =
  | {
      source: 'acp'
      type: 'permission'
      title?: string
      optionId: string
    }
  | {
      source: 'acp'
      type: 'tool-call'
      toolCallId: string
      title: string
      status?: string
      rawInput?: unknown
    }
  | {
      source: 'acp'
      type: 'tool-call-update'
      toolCallId: string
      title?: string
      status?: string
      content?: unknown[]
      rawInput?: unknown
      rawOutput?: unknown
    }
  | {
      source: 'acp'
      type: 'plan'
      entries: Array<{
        status: string
        content: string
      }>
    }

export type ChannelEvent =
  | {
      type: 'typing'
    }
  | {
      type: 'text-delta'
      delta: string
    }
  | {
      type: 'reasoning-delta'
      delta: string
    }
  | {
      type: 'protocol-event'
      event: AgentProtocolEvent
    }
  | {
      type: 'error'
      message: string
    }

export interface ChannelAdapter {
  readonly id: string
  readonly type: ChannelType
  onMessage?: (message: ChannelMessage) => Promise<void> | void
  start(): Promise<void>
  stop(): Promise<void>
  send(remoteChatId: string, text: string): Promise<void>
  sendTyping?(remoteChatId: string, message?: ChannelMessage): Promise<void>
  sendEvent?(remoteChatId: string, event: ChannelEvent, message?: ChannelMessage): Promise<void>
  acknowledgeMessage?(messageId: string): Promise<void>
}

export type AgentProtocolTurnCallbacks = {
  onThought?: (text: string) => Promise<void>
  onToolCall?: (text: string) => Promise<void>
  onTyping?: () => Promise<void>
  onTextDelta?: (text: string) => Promise<void>
  onReasoningDelta?: (text: string) => Promise<void>
  onEvent?: (event: AgentProtocolEvent) => Promise<void>
}

export interface AgentProtocolTurnInput {
  sessionKey: string
  content: ProtocolContentBlock[]
  metadata?: Record<string, unknown>
  callbacks?: AgentProtocolTurnCallbacks
}

export interface AgentProtocolTurnResult {
  text: string
  stopReason?: string
}

export type AgentProtocolHistoryPart =
  | ProtocolContentBlock
  | {
      type: 'reasoning'
      text: string
    }
  | {
      type: 'tool-call'
      toolCallId: string
      toolName: string
      status?: string
      input?: unknown
      output?: unknown
      error?: unknown
    }

export type AgentProtocolHistoryMessage = {
  role: 'user' | 'assistant'
  parts: AgentProtocolHistoryPart[]
}

export type AgentProtocolSessionSummary = {
  sessionId: string
  cwd: string
  title?: string
  updatedAt?: string
}

export interface AgentProtocolAdapter {
  readonly type: AgentProtocolType
  runTurn(input: AgentProtocolTurnInput): Promise<AgentProtocolTurnResult>
  closeSession(sessionKey: string): Promise<void>
  listSessions?(input?: { cwd?: string }): Promise<AgentProtocolSessionSummary[]>
  attachSession?(sessionKey: string, sessionId: string): Promise<void>
  loadSessionHistory?(input: {
    sessionId: string
    cwd?: string
  }): Promise<AgentProtocolHistoryMessage[]>
  resetSession?(sessionKey: string): Promise<void>
  stop(): Promise<void>
}
