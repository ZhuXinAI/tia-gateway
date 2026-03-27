export type ChannelType = 'wechat' | 'lark' | (string & {})
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

export interface ChannelAdapter {
  readonly id: string
  readonly type: ChannelType
  onMessage?: (message: ChannelMessage) => Promise<void> | void
  start(): Promise<void>
  stop(): Promise<void>
  send(remoteChatId: string, text: string): Promise<void>
  sendTyping?(remoteChatId: string, message?: ChannelMessage): Promise<void>
  acknowledgeMessage?(messageId: string): Promise<void>
}

export type AgentProtocolTurnCallbacks = {
  onThought?: (text: string) => Promise<void>
  onTyping?: () => Promise<void>
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

export interface AgentProtocolAdapter {
  readonly type: AgentProtocolType
  runTurn(input: AgentProtocolTurnInput): Promise<AgentProtocolTurnResult>
  closeSession(sessionKey: string): Promise<void>
  stop(): Promise<void>
}
