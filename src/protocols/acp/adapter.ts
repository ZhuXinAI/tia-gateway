import { spawn, type ChildProcess } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'
import type { Logger } from '../../logging.js'
import { PACKAGE_NAME, PACKAGE_VERSION } from '../../meta.js'
import type {
  AgentProtocolAdapter,
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

type AcpConnectionState = {
  process: ChildProcess
  connection: acp.ClientSideConnection
  client: GatewayAcpClient
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
    const session = await this.getOrCreateSession(input.sessionKey, input.callbacks)
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

  async resetSession(sessionKey: string): Promise<void> {
    await this.closeSession(sessionKey)
    await this.sessionBindingStore.delete(sessionKey)
  }

  async stop(): Promise<void> {
    const sessionKeys = [...this.sessions.keys()]
    await Promise.all(sessionKeys.map((sessionKey) => this.closeSession(sessionKey)))
  }

  private async getOrCreateSession(
    sessionKey: string,
    callbacks?: AgentProtocolTurnInput['callbacks']
  ): Promise<AcpSessionState> {
    const existing = this.sessions.get(sessionKey)
    if (existing) {
      return existing
    }

    const log = this.logger.child(sessionKey)
    const connectionState = await this.createConnection(log, callbacks)

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
    log: Logger,
    callbacks?: AgentProtocolTurnInput['callbacks']
  ): Promise<AcpConnectionState> {
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

    const client = new GatewayAcpClient({
      log: (message) => log.info(message),
      onThoughtFlush: callbacks?.onThought ?? NOOP_ASYNC,
      onToolCall: callbacks?.onToolCall,
      sendTyping: callbacks?.onTyping ?? NOOP_ASYNC,
      onTextDelta: callbacks?.onTextDelta,
      onReasoningDelta: callbacks?.onReasoningDelta,
      onEvent: callbacks?.onEvent,
      showThoughts: this.config.agent.showThoughts,
      showTools: this.config.agent.showTools
    })

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
    connectionState: AcpConnectionState,
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
