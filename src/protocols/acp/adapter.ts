import { spawn, type ChildProcess } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'
import type { Logger } from '../../logging.js'
import { PACKAGE_NAME, PACKAGE_VERSION } from '../../meta.js'
import type {
  AgentProtocolAdapter,
  AgentProtocolHistoryMessage,
  AgentProtocolHistoryPart,
  AgentProtocolSessionSummary,
  AgentProtocolTurnInput,
  AgentProtocolTurnResult,
  ProtocolContentBlock
} from '../../core/types.js'
import type { ResolvedAcpProtocolConfig } from './config.js'
import { GatewayAcpClient } from './client.js'
import {
  AcpSessionBindingStore,
  buildAcpBindingScope,
  defaultAcpSessionBindingStorePath
} from './session-binding-store.js'

const NOOP_ASYNC = async (): Promise<void> => undefined

type AcpSessionState = {
  process: ChildProcess
  connection: acp.ClientSideConnection
  sessionId: string
  client: GatewayAcpClient
  capabilities?: acp.AgentCapabilities
  lastActivity: number
}

type AcpConnectionState<TClient extends acp.Client = GatewayAcpClient> = {
  process: ChildProcess
  connection: acp.ClientSideConnection
  client: TClient
  capabilities?: acp.AgentCapabilities
}

export class AcpAgentProtocolAdapter implements AgentProtocolAdapter {
  readonly type = 'acp' as const
  private readonly sessions = new Map<string, AcpSessionState>()
  private readonly sessionBindingStore: AcpSessionBindingStore

  constructor(
    private readonly config: ResolvedAcpProtocolConfig,
    private readonly logger: Logger
  ) {
    this.sessionBindingStore = new AcpSessionBindingStore(
      defaultAcpSessionBindingStorePath(),
      buildAcpBindingScope({
        command: config.agent.command,
        args: config.agent.args,
        cwd: config.agent.cwd
      })
    )
  }

  async runTurn(input: AgentProtocolTurnInput): Promise<AgentProtocolTurnResult> {
    const session = await this.getOrCreateSession(input.sessionKey)
    session.lastActivity = Date.now()

    session.client.updateCallbacks({
      sendTyping: input.callbacks?.onTyping ?? NOOP_ASYNC,
      onThoughtFlush: input.callbacks?.onThought ?? NOOP_ASYNC,
      onToolCall: input.callbacks?.onToolCall,
      onTextDelta: input.callbacks?.onTextDelta,
      onReasoningDelta: input.callbacks?.onReasoningDelta,
      onEvent: input.callbacks?.onEvent
    })

    await session.client.flush()
    void input.callbacks?.onTyping?.().catch(() => undefined)

    try {
      const result = await session.connection.prompt({
        sessionId: session.sessionId,
        prompt: input.content.map((block) => this.toAcpContent(block))
      })

      let text = await session.client.flush()
      if (result.stopReason === 'cancelled') {
        text += '\n[cancelled]'
      } else if (result.stopReason === 'refusal') {
        text += '\n[agent refused to continue]'
      }

      return {
        text,
        stopReason: result.stopReason
      }
    } catch (error) {
      if (session.process.exitCode !== null || session.process.killed) {
        this.sessions.delete(input.sessionKey)
      }
      throw error
    }
  }

  async closeSession(sessionKey: string): Promise<void> {
    const session = this.sessions.get(sessionKey)
    if (!session) {
      return
    }

    this.sessions.delete(sessionKey)
    await this.closeConnection(session.connection)
    killAgent(session.process)
  }

  async listSessions(input: { cwd?: string } = {}): Promise<AgentProtocolSessionSummary[]> {
    const connectionState = await this.createConnection(this.logger.child('session-list'))

    try {
      if (!connectionState.capabilities?.sessionCapabilities?.list) {
        throw new Error('ACP agent does not support session/list.')
      }

      const sessions = await this.collectSessions(
        connectionState.connection,
        input.cwd ?? this.config.agent.cwd
      )

      return sessions.map((session) => ({
        sessionId: session.sessionId,
        cwd: session.cwd,
        title: session.title ?? undefined,
        updatedAt: session.updatedAt ?? undefined
      }))
    } finally {
      await this.closeConnection(connectionState.connection)
      killAgent(connectionState.process)
    }
  }

  async attachSession(sessionKey: string, sessionId: string): Promise<void> {
    await this.closeSession(sessionKey)

    const log = this.logger.child(sessionKey)
    const connectionState = await this.createConnection(log)

    try {
      if (!connectionState.capabilities?.loadSession) {
        throw new Error('ACP agent does not support session/load, cannot attach existing sessions.')
      }

      await connectionState.connection.loadSession({
        sessionId,
        cwd: this.config.agent.cwd,
        mcpServers: []
      })

      // Loading a session can replay prior messages; discard them for channel UX.
      await connectionState.client.flush()

      const session: AcpSessionState = {
        ...connectionState,
        sessionId,
        lastActivity: Date.now()
      }
      this.registerSession(sessionKey, session)
      await this.sessionBindingStore.set(sessionKey, sessionId)
    } catch (error) {
      await this.closeConnection(connectionState.connection)
      killAgent(connectionState.process)
      throw error
    }
  }

  async loadSessionHistory(input: {
    sessionId: string
    cwd?: string
  }): Promise<AgentProtocolHistoryMessage[]> {
    const connectionState = await this.createReplayConnection(
      this.logger.child(`session-history:${input.sessionId}`)
    )

    try {
      if (!connectionState.capabilities?.loadSession) {
        throw new Error('ACP agent does not support session/load, cannot replay session history.')
      }

      await connectionState.connection.loadSession({
        sessionId: input.sessionId,
        cwd: input.cwd ?? this.config.agent.cwd,
        mcpServers: []
      })

      return connectionState.client.getHistory()
    } finally {
      await this.closeConnection(connectionState.connection)
      killAgent(connectionState.process)
    }
  }

  async resetSession(sessionKey: string): Promise<void> {
    await this.closeSession(sessionKey)
    await this.sessionBindingStore.delete(sessionKey)
  }

  async stop(): Promise<void> {
    const sessionKeys = [...this.sessions.keys()]
    await Promise.all(sessionKeys.map((sessionKey) => this.closeSession(sessionKey)))
  }

  private async getOrCreateSession(
    sessionKey: string
  ): Promise<AcpSessionState> {
    const existing = this.sessions.get(sessionKey)
    if (existing) {
      return existing
    }

    const log = this.logger.child(sessionKey)
    const connectionState = await this.createConnection(log)

    try {
      const boundSessionId = await this.sessionBindingStore.get(sessionKey)
      const loadedSessionId = await this.tryLoadSession(
        connectionState,
        log,
        boundSessionId
      )

      const sessionId =
        loadedSessionId ??
        (
          await connectionState.connection.newSession({
            cwd: this.config.agent.cwd,
            mcpServers: []
          })
        ).sessionId

      const session: AcpSessionState = {
        ...connectionState,
        sessionId,
        lastActivity: Date.now()
      }

      this.registerSession(sessionKey, session)
      await this.sessionBindingStore.set(sessionKey, sessionId)
      return session
    } catch (error) {
      await this.closeConnection(connectionState.connection)
      killAgent(connectionState.process)
      throw error
    }
  }

  private toAcpContent(block: ProtocolContentBlock): acp.ContentBlock {
    switch (block.type) {
      case 'text':
        return {
          type: 'text',
          text: block.text
        }

      case 'image':
        return {
          type: 'image',
          data: block.data,
          mimeType: block.mimeType
        } as acp.ContentBlock

      case 'resource':
        return {
          type: 'resource',
          resource: {
            uri: block.resource.uri,
            mimeType: block.resource.mimeType,
            ...(block.resource.text ? { text: block.resource.text } : {}),
            ...(block.resource.data ? { data: block.resource.data } : {})
          }
        } as acp.ContentBlock
    }
  }

  private async createConnection(
    log: Logger
  ): Promise<AcpConnectionState> {
    const client = new GatewayAcpClient({
      log: (message) => log.info(message),
      onThoughtFlush: NOOP_ASYNC,
      sendTyping: NOOP_ASYNC,
      showThoughts: this.config.agent.showThoughts,
      showTools: this.config.agent.showTools
    })

    return this.createConnectionWithClient(log, client)
  }

  private async createReplayConnection(
    log: Logger
  ): Promise<AcpConnectionState<AcpReplayClient>> {
    const client = new AcpReplayClient()
    return this.createConnectionWithClient(log, client)
  }

  private async createConnectionWithClient<TClient extends acp.Client>(
    log: Logger,
    client: TClient
  ): Promise<AcpConnectionState<TClient>> {
    const useShell = process.platform === 'win32'
    log.info(
      `Spawning ACP agent: ${this.config.agent.command} ${this.config.agent.args.join(
        ' '
      )} (cwd: ${this.config.agent.cwd}, shell=${useShell})`
    )

    const processHandle = spawn(this.config.agent.command, this.config.agent.args, {
      cwd: this.config.agent.cwd,
      env: {
        ...process.env,
        ...(this.config.agent.env ?? {})
      },
      shell: useShell,
      stdio: ['pipe', 'pipe', 'inherit']
    })

    processHandle.on('error', (error) => {
      log.error('Agent process error', error)
    })

    processHandle.on('exit', (code, signal) => {
      log.info(`Agent process exited: code=${code} signal=${signal}`)
    })

    if (!processHandle.stdin || !processHandle.stdout) {
      processHandle.kill()
      throw new Error('ACP agent stdio streams are unavailable.')
    }

    const stream = acp.ndJsonStream(
      Writable.toWeb(processHandle.stdin),
      Readable.toWeb(processHandle.stdout) as ReadableStream<Uint8Array>
    )

    const connection = new acp.ClientSideConnection(() => client, stream)
    const initialized = await connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientInfo: {
        name: PACKAGE_NAME,
        title: PACKAGE_NAME,
        version: PACKAGE_VERSION
      },
      clientCapabilities: {
        fs: {
          readTextFile: true,
          writeTextFile: true
        }
      }
    })

    return {
      process: processHandle,
      connection,
      client,
      capabilities: initialized.agentCapabilities
    }
  }

  private async tryLoadSession(
    connectionState: AcpConnectionState<GatewayAcpClient>,
    log: Logger,
    boundSessionId: string | undefined
  ): Promise<string | undefined> {
    if (!boundSessionId) {
      return undefined
    }

    if (!connectionState.capabilities?.loadSession) {
      log.warn(
        `Bound ACP session ${boundSessionId} cannot be restored because the agent does not support session/load.`
      )
      return undefined
    }

    try {
      await connectionState.connection.loadSession({
        sessionId: boundSessionId,
        cwd: this.config.agent.cwd,
        mcpServers: []
      })
      // Loading a session can replay prior messages; discard them for channel UX.
      await connectionState.client.flush()
      return boundSessionId
    } catch (error) {
      log.warn(`Failed to restore bound ACP session ${boundSessionId}. Falling back to a new session.`, error)
      return undefined
    }
  }

  private async collectSessions(
    connection: acp.ClientSideConnection,
    cwd?: string
  ): Promise<acp.SessionInfo[]> {
    const sessions: acp.SessionInfo[] = []
    let cursor: string | undefined

    for (let page = 0; page < 100; page += 1) {
      const response = await connection.listSessions({
        ...(cwd ? { cwd } : {}),
        ...(cursor ? { cursor } : {})
      })
      sessions.push(...response.sessions)

      cursor = response.nextCursor ?? undefined
      if (!cursor) {
        break
      }
    }

    return sessions
  }

  private registerSession(sessionKey: string, session: AcpSessionState): void {
    this.sessions.set(sessionKey, session)
    session.process.on('exit', () => {
      const current = this.sessions.get(sessionKey)
      if (current?.process === session.process) {
        this.sessions.delete(sessionKey)
      }
    })
  }

  private async closeConnection(connection: acp.ClientSideConnection): Promise<void> {
    const candidate = connection as unknown as {
      close?: () => Promise<void> | void
    }
    if (typeof candidate.close === 'function') {
      await candidate.close.call(connection)
    }
  }
}

function killAgent(processHandle: ChildProcess): void {
  if (processHandle.killed) {
    return
  }

  processHandle.kill('SIGTERM')
  setTimeout(() => {
    if (!processHandle.killed) {
      processHandle.kill('SIGKILL')
    }
  }, 5_000).unref()
}

class AcpReplayClient implements acp.Client {
  private readonly history: AgentProtocolHistoryMessage[] = []
  private readonly toolCalls = new Map<
    string,
    {
      messageIndex: number
      partIndex: number
    }
  >()
  private thoughtBuffer = ''

  getHistory(): AgentProtocolHistoryMessage[] {
    this.flushThoughtBuffer()

    return this.history.map((message) => ({
      role: message.role,
      parts: message.parts.map((part) => cloneHistoryPart(part))
    }))
  }

  async requestPermission(
    params: acp.RequestPermissionRequest
  ): Promise<acp.RequestPermissionResponse> {
    const optionId = params.options[0]?.optionId ?? 'allow'
    return {
      outcome: {
        outcome: 'selected',
        optionId
      }
    }
  }

  async sessionUpdate(params: acp.SessionNotification): Promise<void> {
    const update = params.update
    switch (update.sessionUpdate) {
      case 'user_message_chunk':
      case 'agent_message_chunk': {
        this.flushThoughtBuffer()
        const role = update.sessionUpdate === 'user_message_chunk' ? 'user' : 'assistant'
        const block = toProtocolContentBlock(update.content)
        if (!block) {
          return
        }

        this.appendPart(role, block)
        return
      }

      case 'agent_thought_chunk': {
        if (update.content.type !== 'text') {
          return
        }

        this.thoughtBuffer += update.content.text
        return
      }

      case 'tool_call': {
        this.flushThoughtBuffer()
        this.upsertToolCall({
          toolCallId: update.toolCallId,
          toolName: update.title?.trim() || update.toolCallId,
          status: normalizeToolStatus(update.status),
          input: update.rawInput
        })
        return
      }

      case 'tool_call_update': {
        this.flushThoughtBuffer()
        const output = update.rawOutput ?? update.content
        const normalizedStatus = normalizeToolStatus(update.status)
        const isErrorStatus = normalizedStatus === 'failed' || normalizedStatus === 'error'

        this.upsertToolCall({
          toolCallId: update.toolCallId,
          toolName: update.title?.trim() || undefined,
          status: normalizedStatus,
          input: update.rawInput,
          output: isErrorStatus ? undefined : output,
          error: isErrorStatus ? output : undefined
        })
        return
      }

      default:
        return
    }
  }

  async readTextFile(): Promise<acp.ReadTextFileResponse> {
    throw new Error('readTextFile is not supported for replay capture.')
  }

  async writeTextFile(): Promise<acp.WriteTextFileResponse> {
    throw new Error('writeTextFile is not supported for replay capture.')
  }

  private appendPart(
    role: AgentProtocolHistoryMessage['role'],
    part: Exclude<AgentProtocolHistoryPart, { type: 'tool-call' }>
  ): void {
    const message = this.ensureMessage(role)
    const previousPart = message.parts[message.parts.length - 1]
    if (part.type === 'text' && previousPart?.type === 'text') {
      previousPart.text += part.text
      return
    }

    if (part.type === 'reasoning' && previousPart?.type === 'reasoning') {
      previousPart.text += part.text
      return
    }

    message.parts.push(part)
  }

  private appendAssistantReasoning(text: string): void {
    if (!text.trim()) {
      return
    }

    this.appendPart('assistant', {
      type: 'reasoning',
      text
    })
  }

  private flushThoughtBuffer(): void {
    const thoughtText = this.thoughtBuffer
    this.thoughtBuffer = ''
    if (!thoughtText.trim()) {
      return
    }

    this.appendAssistantReasoning(thoughtText)
  }

  private ensureMessage(role: AgentProtocolHistoryMessage['role']): AgentProtocolHistoryMessage {
    const last = this.history[this.history.length - 1]
    if (last && last.role === role) {
      return last
    }

    const next: AgentProtocolHistoryMessage = {
      role,
      parts: []
    }
    this.history.push(next)
    return next
  }

  private upsertToolCall(input: {
    toolCallId: string
    toolName?: string
    status?: string
    input?: unknown
    output?: unknown
    error?: unknown
  }): void {
    const existing = this.toolCalls.get(input.toolCallId)
    if (existing) {
      const message = this.history[existing.messageIndex]
      const current = message?.parts[existing.partIndex]
      if (!message || !current || current.type !== 'tool-call') {
        this.toolCalls.delete(input.toolCallId)
      } else {
        message.parts[existing.partIndex] = {
          ...current,
          ...(input.toolName ? { toolName: input.toolName } : {}),
          ...(input.status ? { status: input.status } : {}),
          ...(input.input !== undefined ? { input: input.input } : {}),
          ...(input.output !== undefined ? { output: input.output } : {}),
          ...(input.error !== undefined ? { error: input.error } : {})
        }
        return
      }
    }

    const message = this.ensureMessage('assistant')
    const part: AgentProtocolHistoryPart = {
      type: 'tool-call',
      toolCallId: input.toolCallId,
      toolName: input.toolName ?? input.toolCallId,
      ...(input.status ? { status: input.status } : {}),
      ...(input.input !== undefined ? { input: input.input } : {}),
      ...(input.output !== undefined ? { output: input.output } : {}),
      ...(input.error !== undefined ? { error: input.error } : {})
    }
    const partIndex = message.parts.push(part) - 1
    this.toolCalls.set(input.toolCallId, {
      messageIndex: this.history.length - 1,
      partIndex
    })
  }
}

function toProtocolContentBlock(content: unknown): ProtocolContentBlock | undefined {
  const block = content as Record<string, unknown>
  const type = typeof block.type === 'string' ? block.type : ''

  if (type === 'text') {
    const text = typeof block.text === 'string' ? block.text : ''
    if (!text) {
      return undefined
    }

    return {
      type: 'text',
      text
    }
  }

  if (type === 'image') {
    const data = typeof block.data === 'string' ? block.data : ''
    const mimeType = typeof block.mimeType === 'string' ? block.mimeType : ''
    if (!data || !mimeType) {
      return undefined
    }

    return {
      type: 'image',
      data,
      mimeType
    }
  }

  if (type === 'resource') {
    const resource = block.resource as Record<string, unknown> | undefined
    const uri = typeof resource?.uri === 'string' ? resource.uri : ''
    const mimeType = typeof resource?.mimeType === 'string' ? resource.mimeType : ''
    if (!uri || !mimeType) {
      return undefined
    }

    const text = typeof resource?.text === 'string' ? resource.text : undefined
    const data = typeof resource?.data === 'string' ? resource.data : undefined

    return {
      type: 'resource',
      resource: {
        uri,
        mimeType,
        ...(text ? { text } : {}),
        ...(data ? { data } : {})
      }
    }
  }

  return undefined
}

function normalizeToolStatus(status: string | null | undefined): string | undefined {
  const normalized = status?.trim().toLowerCase()
  return normalized || undefined
}

function cloneHistoryPart(part: AgentProtocolHistoryPart): AgentProtocolHistoryPart {
  if (part.type === 'resource') {
    return {
      type: 'resource',
      resource: {
        uri: part.resource.uri,
        mimeType: part.resource.mimeType,
        ...(part.resource.text ? { text: part.resource.text } : {}),
        ...(part.resource.data ? { data: part.resource.data } : {})
      }
    }
  }

  if (part.type === 'tool-call') {
    return {
      type: 'tool-call',
      toolCallId: part.toolCallId,
      toolName: part.toolName,
      ...(part.status ? { status: part.status } : {}),
      ...(part.input !== undefined ? { input: part.input } : {}),
      ...(part.output !== undefined ? { output: part.output } : {}),
      ...(part.error !== undefined ? { error: part.error } : {})
    }
  }

  if (part.type === 'image') {
    return {
      type: 'image',
      data: part.data,
      mimeType: part.mimeType
    }
  }

  return {
    type: part.type,
    text: part.text
  } as AgentProtocolHistoryPart
}
