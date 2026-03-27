import { spawn, type ChildProcess } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'
import type { Logger } from '../../logging.js'
import { PACKAGE_NAME, PACKAGE_VERSION } from '../../meta.js'
import type {
  AgentProtocolAdapter,
  AgentProtocolTurnInput,
  AgentProtocolTurnResult,
  ProtocolContentBlock
} from '../../core/types.js'
import type { ResolvedAcpProtocolConfig } from './config.js'
import { GatewayAcpClient } from './client.js'

type AcpSessionState = {
  process: ChildProcess
  connection: acp.ClientSideConnection
  sessionId: string
  client: GatewayAcpClient
  lastActivity: number
}

export class AcpAgentProtocolAdapter implements AgentProtocolAdapter {
  readonly type = 'acp' as const
  private readonly sessions = new Map<string, AcpSessionState>()

  constructor(
    private readonly config: ResolvedAcpProtocolConfig,
    private readonly logger: Logger
  ) {}

  async runTurn(input: AgentProtocolTurnInput): Promise<AgentProtocolTurnResult> {
    const session = await this.getOrCreateSession(input.sessionKey, input.callbacks)
    session.lastActivity = Date.now()

    session.client.updateCallbacks({
      sendTyping: input.callbacks?.onTyping ?? (async () => undefined),
      onThoughtFlush: input.callbacks?.onThought ?? (async () => undefined)
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
    await this.closeConnection(session)
    killAgent(session.process)
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
      onThoughtFlush: callbacks?.onThought ?? (async () => undefined),
      sendTyping: callbacks?.onTyping ?? (async () => undefined),
      showThoughts: this.config.agent.showThoughts
    })

    const stream = acp.ndJsonStream(
      Writable.toWeb(processHandle.stdin),
      Readable.toWeb(processHandle.stdout) as ReadableStream<Uint8Array>
    )

    const connection = new acp.ClientSideConnection(() => client, stream)

    await connection.initialize({
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

    const sessionResult = await connection.newSession({
      cwd: this.config.agent.cwd,
      mcpServers: []
    })

    const session: AcpSessionState = {
      process: processHandle,
      connection,
      sessionId: sessionResult.sessionId,
      client,
      lastActivity: Date.now()
    }

    this.sessions.set(sessionKey, session)

    processHandle.on('exit', () => {
      const current = this.sessions.get(sessionKey)
      if (current?.process === processHandle) {
        this.sessions.delete(sessionKey)
      }
    })

    return session
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

  private async closeConnection(session: AcpSessionState): Promise<void> {
    const candidate = session.connection as unknown as {
      close?: () => Promise<void> | void
    }
    if (typeof candidate.close === 'function') {
      await candidate.close.call(session.connection)
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
