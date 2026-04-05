import { randomUUID } from 'node:crypto'
import type { ServerResponse } from 'node:http'
import { join } from 'node:path'
import { convertToModelMessages, streamText, type ToolSet, type UIMessage } from 'ai'
import {
  createACPProvider,
  type ACPProvider
} from '@mcpc-tech/acp-ai-provider'
import { defaultStorageDir } from '../config-store.js'
import type {
  AgentProtocolAdapter,
  AgentProtocolSessionSummary
} from '../core/types.js'
import type { Logger } from '../logging.js'
import type { ResolvedAcpProtocolConfig } from '../protocols/acp/config.js'
import {
  AcpSessionBindingStore,
  buildAcpBindingScope,
  defaultAcpSessionBindingStorePath
} from '../protocols/acp/session-binding-store.js'
import {
  HttpSessionStore,
  type StoredHttpSessionRecord
} from './http-session-store.js'

export type HttpSessionSummary = {
  chatId: string
  label: string
  createdAt: string
  updatedAt: string
  acpSessionId?: string
  cwd?: string
  messageCount: number
  status: 'draft' | 'attached'
  canDelete: boolean
}

export type HttpSessionDetail = HttpSessionSummary & {
  messages: UIMessage[]
}

type HttpAcpBridgeOptions = {
  channelId: string
  config: ResolvedAcpProtocolConfig
  protocol: AgentProtocolAdapter
  logger: Logger
}

type ProviderEntry = {
  provider: ACPProvider
  sessionId?: string
}

const SESSION_LIST_TIMEOUT_MS = 8_000
const SESSION_INIT_TIMEOUT_MS = 15_000

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return typeof error === 'string' ? error : 'Unknown error'
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms.`))
        }, timeoutMs)
        timeoutHandle.unref?.()
      })
    ])
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle)
    }
  }
}

function defaultSessionStorePath(channelId: string): string {
  return join(
    defaultStorageDir(),
    'channels',
    channelId,
    'http-sessions.json'
  )
}

function summarizeSession(session: StoredHttpSessionRecord): HttpSessionSummary {
  return {
    chatId: session.chatId,
    label: session.label,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    acpSessionId: session.acpSessionId,
    cwd: session.cwd,
    messageCount: session.messages.length,
    status: session.acpSessionId ? 'attached' : 'draft',
    canDelete: !session.acpSessionId
  }
}

function deriveSessionLabel(
  messages: UIMessage[],
  fallbackLabel: string,
  acpSessionId?: string
): string {
  const trimmedFallback = fallbackLabel.trim()
  if (trimmedFallback && trimmedFallback !== 'New session' && trimmedFallback !== acpSessionId) {
    return trimmedFallback
  }

  for (const message of messages) {
    if (message.role !== 'user') {
      continue
    }

    for (const part of message.parts) {
      if (part.type !== 'text') {
        continue
      }

      const text = part.text.trim().replace(/\s+/g, ' ')
      if (text) {
        return text.length > 48 ? `${text.slice(0, 47)}...` : text
      }
    }
  }

  return acpSessionId || trimmedFallback || 'New session'
}

export class HttpAcpBridge {
  private readonly logger: Logger
  private readonly sessionStore: HttpSessionStore
  private readonly bindingStore: AcpSessionBindingStore
  private readonly providers = new Map<string, ProviderEntry>()

  constructor(private readonly options: HttpAcpBridgeOptions) {
    this.logger = options.logger.child(`http-acp:${options.channelId}`)
    this.sessionStore = new HttpSessionStore(
      defaultSessionStorePath(options.channelId)
    )
    this.bindingStore = new AcpSessionBindingStore(
      defaultAcpSessionBindingStorePath(),
      buildAcpBindingScope({
        command: options.config.agent.command,
        args: options.config.agent.args,
        cwd: options.config.agent.cwd
      })
    )
  }

  async stop(): Promise<void> {
    for (const entry of this.providers.values()) {
      entry.provider.cleanup()
    }

    this.providers.clear()
  }

  async listSessions(): Promise<HttpSessionSummary[]> {
    const sessions = await this.syncSessionsFromProtocol()
    return sessions.map((session) => summarizeSession(session))
  }

  async createSession(input: { label?: string } = {}): Promise<HttpSessionSummary> {
    const session = await this.sessionStore.create({
      label: input.label
    })
    return summarizeSession(session)
  }

  async getSession(chatId: string): Promise<HttpSessionDetail | undefined> {
    const session = await this.sessionStore.get(chatId)
    if (!session) {
      return undefined
    }

    return {
      ...summarizeSession(session),
      messages: session.messages
    }
  }

  async deleteSession(chatId: string): Promise<boolean> {
    const session = await this.sessionStore.get(chatId)
    if (!session || session.acpSessionId) {
      return false
    }

    const provider = this.providers.get(chatId)
    provider?.provider.cleanup()
    this.providers.delete(chatId)
    await this.bindingStore.delete(chatId)
    return this.sessionStore.delete(chatId)
  }

  async handleChatRequest(input: {
    chatId: string
    messages: UIMessage[]
    response: ServerResponse
    headers: Record<string, string>
    onRegisterStream: (
      chatId: string,
      streamId: string,
      stream: ReadableStream<string>
    ) => Promise<void>
    onStreamFinished: (chatId: string, streamId: string) => void
  }): Promise<void> {
    const session = await this.ensureSession(input.chatId, input.messages)
    const providerEntry = await this.getOrCreateProvider(input.chatId, session)
    const streamId = `http:${this.options.channelId}:${input.chatId}:${randomUUID()}`

    const result = streamText({
      model: providerEntry.provider.languageModel(),
      // pnpm keeps transitive type trees isolated; normalize tool typing across ai/zod variants.
      tools: providerEntry.provider.tools as unknown as ToolSet,
      messages: await convertToModelMessages(input.messages as Array<Omit<UIMessage, 'id'>>)
    })

    result.pipeUIMessageStreamToResponse(input.response, {
      headers: input.headers,
      originalMessages: input.messages,
      onError: (error) => {
        const message = toErrorMessage(error)
        this.logger.error(`HTTP ACP stream failed for ${input.chatId}`, error)
        input.onStreamFinished(input.chatId, streamId)
        return message
      },
      onFinish: async ({ messages }) => {
        input.onStreamFinished(input.chatId, streamId)

        const sessionId =
          providerEntry.provider.getSessionId() ??
          providerEntry.sessionId ??
          session.acpSessionId

        if (sessionId) {
          providerEntry.sessionId = sessionId
          await this.bindingStore.set(input.chatId, sessionId)
        }

        await this.sessionStore.upsert({
          ...session,
          label: deriveSessionLabel(messages, session.label, sessionId),
          updatedAt: new Date().toISOString(),
          acpSessionId: sessionId,
          cwd: session.cwd ?? this.options.config.agent.cwd,
          messages
        })
      },
      consumeSseStream: async ({ stream }) => {
        await input.onRegisterStream(input.chatId, streamId, stream)
      }
    })
  }

  private async ensureSession(
    chatId: string,
    messages: UIMessage[]
  ): Promise<StoredHttpSessionRecord> {
    const existing = await this.sessionStore.get(chatId)
    if (existing) {
      return existing
    }

    return this.sessionStore.create({
      chatId,
      label: deriveSessionLabel(messages, 'New session')
    })
  }

  private async syncSessionsFromProtocol(): Promise<StoredHttpSessionRecord[]> {
    const storedSessions = await this.sessionStore.list()
    if (!this.options.protocol.listSessions) {
      return storedSessions
    }

    let protocolSessions: AgentProtocolSessionSummary[]
    try {
      protocolSessions = await withTimeout(
        this.options.protocol.listSessions({
          cwd: this.options.config.agent.cwd
        }),
        SESSION_LIST_TIMEOUT_MS,
        'ACP session listing'
      )
    } catch (error) {
      this.logger.warn('Failed to refresh ACP session list for the HTTP web shell.', {
        errorMessage: toErrorMessage(error)
      })
      return storedSessions
    }

    const byAcpSessionId = new Map<string, StoredHttpSessionRecord>()
    for (const session of storedSessions) {
      if (session.acpSessionId) {
        byAcpSessionId.set(session.acpSessionId, session)
      }
    }

    for (const session of protocolSessions) {
      const existing = byAcpSessionId.get(session.sessionId)

      if (!existing) {
        const created = await this.sessionStore.create({
          label: session.title?.trim() || session.sessionId,
          acpSessionId: session.sessionId,
          cwd: session.cwd,
          messages: []
        })
        await this.bindingStore.set(created.chatId, session.sessionId)
        byAcpSessionId.set(session.sessionId, created)
        continue
      }

      const nextLabel = session.title?.trim() || existing.label
      const nextUpdatedAt = session.updatedAt?.trim() || existing.updatedAt
      const needsUpdate =
        nextLabel !== existing.label ||
        nextUpdatedAt !== existing.updatedAt ||
        session.cwd !== existing.cwd

      if (needsUpdate) {
        const updated = await this.sessionStore.update(existing.chatId, {
          label: nextLabel,
          updatedAt: nextUpdatedAt,
          cwd: session.cwd
        })
        if (updated) {
          byAcpSessionId.set(session.sessionId, updated)
        }
      }
    }

    return this.sessionStore.list()
  }

  private async getOrCreateProvider(
    chatId: string,
    session: StoredHttpSessionRecord
  ): Promise<ProviderEntry> {
    const existing = this.providers.get(chatId)
    if (existing) {
      return existing
    }

    const boundSessionId =
      session.acpSessionId ??
      (await this.bindingStore.get(chatId))

    const provider = createACPProvider({
      command: this.options.config.agent.command,
      args: this.options.config.agent.args,
      env: this.options.config.agent.env,
      session: {
        cwd: session.cwd ?? this.options.config.agent.cwd,
        mcpServers: []
      },
      ...(boundSessionId ? { existingSessionId: boundSessionId } : {}),
      persistSession: true
    })

    try {
      const initialized = await withTimeout(
        provider.initSession(provider.tools),
        SESSION_INIT_TIMEOUT_MS,
        'ACP session initialization'
      )
      const entry: ProviderEntry = {
        provider,
        sessionId: provider.getSessionId() ?? initialized.sessionId ?? boundSessionId
      }

      if (entry.sessionId) {
        await this.bindingStore.set(chatId, entry.sessionId)
      }

      this.providers.set(chatId, entry)
      return entry
    } catch (error) {
      provider.cleanup()
      throw error
    }
  }
}
