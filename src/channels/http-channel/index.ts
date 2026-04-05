import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from 'node:http'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import { createResumableStreamContext } from 'resumable-stream/generic'
import { defaultStorageDir } from '../../config-store.js'
import type { Logger } from '../../logging.js'
import { AbstractChannel } from '../../core/abstract-channel.js'
import type {
  ChannelEvent,
  ChannelMessage
} from '../../core/types.js'
import { HttpAcpBridge } from '../http-acp-bridge.js'
import {
  CORS_HEADERS,
  HTTP_TOKEN_FILE_NAME,
  STATIC_ASSET_HEADERS,
  UI_MESSAGE_STREAM_HEADERS
} from './constants.js'
import {
  extractLastUserMessage,
  normalizeUiMessages,
  parseUiMessage
} from './message-utils.js'
import { InMemoryResumableStreamBus } from './resumable-bus.js'
import type {
  HttpChannelOptions,
  HttpChatRequestBody,
  PendingToolState,
  PendingTurn,
  PersistedHttpToken,
  ResolvedHttpToken
} from './types.js'
import {
  escapeRegExp,
  isEnoent,
  normalizePath,
  readJsonBody,
  toErrorMessage
} from './utils.js'

export type { HttpChannelOptions } from './types.js'

export class HttpChannel extends AbstractChannel {
  private readonly logger: Logger
  private readonly host: string
  private readonly port: number
  private readonly chatPath: string
  private readonly ssePath: string
  private readonly sessionsPath: string
  private readonly configuredToken?: string
  private readonly serveWebApp: boolean
  private readonly autoGenerateToken: boolean
  private readonly title: string
  private readonly acpBridge?: HttpAcpBridge
  private readonly bus = new InMemoryResumableStreamBus()
  private readonly streamContext = createResumableStreamContext({
    waitUntil: null,
    publisher: this.bus,
    subscriber: this.bus,
    keyPrefix: 'tia-gateway-http'
  })
  private readonly pendingTurns = new Map<string, PendingTurn[]>()
  private readonly activeStreamIds = new Map<string, string>()
  private readonly webAssetCache = new Map<string, string>()
  private accessToken?: string
  private server: Server | null = null

  constructor(options: HttpChannelOptions) {
    super(options.id, 'http')
    this.logger = options.logger.child(`http:${options.id}`)
    this.host = options.host
    this.port = options.port
    this.chatPath = normalizePath(options.chatPath ?? '/chat')
    this.ssePath = normalizePath(options.ssePath ?? '/sse')
    this.sessionsPath = normalizePath(
      this.chatPath === '/' ? '/sessions' : `${this.chatPath}/sessions`
    )
    this.configuredToken = options.token?.trim() || undefined
    this.serveWebApp = options.serveWebApp ?? false
    this.autoGenerateToken = options.autoGenerateToken ?? false
    this.title = options.title?.trim() || 'TIA Gateway'
    this.acpBridge = options.acpBridge
      ? new HttpAcpBridge({
          channelId: options.id,
          config: options.acpBridge.config,
          protocol: options.acpBridge.protocol,
          logger: options.logger
        })
      : undefined
  }

  async start(): Promise<void> {
    if (this.server) {
      return
    }

    const tokenState = await this.resolveAccessToken()
    this.accessToken = tokenState.token

    const server = createServer((request, response) => {
      void this.handleRequest(request, response).catch((error) => {
        this.logger.error('HTTP channel request failed', error)
        if (!response.headersSent) {
          response.writeHead(500, {
            ...CORS_HEADERS,
            'content-type': 'application/json'
          })
        }
        response.end(JSON.stringify({ error: 'Internal Server Error' }))
      })
    })

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.port, this.host, () => {
        server.off('error', reject)
        resolve()
      })
    })

    this.server = server
    this.logger.info(
      `Listening on ${this.getDisplayUrl(this.chatPath)} (resume aliases ${this.chatPath}/:id/stream and ${this.ssePath}/:id)`
    )

    if (this.serveWebApp) {
      this.logger.info(`Web UI: ${this.getDisplayUrl('/')}`)
    }

    if (tokenState.created && tokenState.token) {
      this.logger.info(`Generated HTTP access token for ${this.id}: ${tokenState.token}`)
      if (this.serveWebApp) {
        this.logger.info(
          `One-time access URL: ${this.getDisplayUrl(`/?token=${encodeURIComponent(tokenState.token)}`)}`
        )
      }
    }
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null

    for (const queue of this.pendingTurns.values()) {
      for (const pending of queue) {
        this.closePendingTurn(pending)
      }
    }
    this.pendingTurns.clear()
    this.activeStreamIds.clear()
    await this.acpBridge?.stop()

    if (!server) {
      return
    }

    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }

        resolve()
      })
    })
  }

  async send(remoteChatId: string, text: string): Promise<void> {
    const pending = this.getCurrentPendingTurn(remoteChatId)
    if (!pending) {
      this.logger.warn(`Dropping outbound HTTP reply for ${remoteChatId}; no open stream.`)
      return
    }

    this.finishPendingTurn(remoteChatId, pending, text)
  }

  async sendTyping(remoteChatId: string): Promise<void> {
    const pending = this.getCurrentPendingTurn(remoteChatId)
    if (!pending) {
      return
    }

    this.writePendingChunk(pending, {
      type: 'data-typing',
      data: {
        chatId: remoteChatId
      },
      transient: true
    })
  }

  async sendEvent(
    remoteChatId: string,
    event: ChannelEvent,
    message?: ChannelMessage
  ): Promise<void> {
    const pending = this.resolvePendingTurn(remoteChatId, message)
    if (!pending) {
      return
    }

    switch (event.type) {
      case 'typing':
        this.writePendingChunk(pending, {
          type: 'data-typing',
          data: {
            chatId: remoteChatId
          },
          transient: true
        })
        return

      case 'text-delta':
        if (!event.delta) {
          return
        }

        this.ensureMessageStarted(pending)
        this.ensureTextStarted(pending)
        this.writePendingChunk(pending, {
          type: 'text-delta',
          id: pending.textPartId,
          delta: event.delta
        })
        return

      case 'reasoning-delta':
        if (!event.delta) {
          return
        }

        this.ensureMessageStarted(pending)
        this.ensureReasoningStarted(pending)
        this.writePendingChunk(pending, {
          type: 'reasoning-delta',
          id: pending.reasoningPartId,
          delta: event.delta
        })
        return

      case 'protocol-event':
        this.ensureMessageStarted(pending)
        this.emitAcpToolChunks(pending, event.event)
        this.writePendingChunk(pending, {
          type: 'data-acp-event',
          data: event.event,
          transient: true
        })
        return

      case 'error':
        this.failPendingTurn(remoteChatId, pending, event.message)
        return
    }
  }

  private async handleRequest(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? `${this.host}:${this.port}`}`)

    if (request.method === 'OPTIONS') {
      response.writeHead(204, CORS_HEADERS)
      response.end()
      return
    }

    if (request.method === 'GET' && this.serveWebApp) {
      if (url.pathname === '/' || url.pathname === '/app.js' || url.pathname === '/app.css') {
        await this.handleStaticWebRequest(url, response)
        return
      }
    }

    if (!this.isAuthorized(request, url)) {
      response.writeHead(401, {
        ...CORS_HEADERS,
        'content-type': 'application/json'
      })
      response.end(JSON.stringify({ error: 'Unauthorized' }))
      return
    }

    if (url.pathname === this.sessionsPath || url.pathname.startsWith(`${this.sessionsPath}/`)) {
      await this.handleSessionRequest(request, response, url)
      return
    }

    if (request.method === 'POST' && url.pathname === this.chatPath) {
      await this.handlePost(request, response)
      return
    }

    if (request.method === 'GET') {
      const chatId =
        this.matchResumePath(url.pathname, this.chatPath, '/stream') ??
        this.matchResumePath(url.pathname, this.ssePath, '') ??
        url.searchParams.get('id') ??
        undefined

      if (chatId && (url.pathname.startsWith(this.chatPath) || url.pathname.startsWith(this.ssePath) || url.pathname === this.ssePath)) {
        await this.handleResume(response, chatId)
        return
      }
    }

    response.writeHead(404, {
      ...CORS_HEADERS,
      'content-type': 'application/json'
    })
    response.end(JSON.stringify({ error: 'Not Found' }))
  }

  private async handlePost(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    let body: HttpChatRequestBody
    try {
      body = (await readJsonBody(request)) as HttpChatRequestBody
    } catch (error) {
      response.writeHead(400, {
        ...CORS_HEADERS,
        'content-type': 'application/json'
      })
      response.end(JSON.stringify({ error: `Invalid JSON body: ${toErrorMessage(error)}` }))
      return
    }

    const chatId = body.id?.trim() || body.chatId?.trim()
    if (!chatId) {
      response.writeHead(400, {
        ...CORS_HEADERS,
        'content-type': 'application/json'
      })
      response.end(JSON.stringify({ error: 'Missing chat id. Provide "id" or "chatId".' }))
      return
    }

    const normalizedMessages = normalizeUiMessages(body)
    if (this.acpBridge && normalizedMessages.length > 0) {
      await this.acpBridge.handleChatRequest({
        chatId,
        messages: normalizedMessages,
        response,
        headers: CORS_HEADERS,
        onRegisterStream: (registeredChatId, streamId, stream) =>
          this.registerActiveStream(registeredChatId, streamId, stream),
        onStreamFinished: (finishedChatId, streamId) =>
          this.clearActiveStream(finishedChatId, streamId)
      })
      return
    }

    if (!this.onMessage) {
      response.writeHead(503, {
        ...CORS_HEADERS,
        'content-type': 'application/json'
      })
      response.end(JSON.stringify({ error: 'Gateway is not ready to accept messages yet.' }))
      return
    }

    const inboundMessage = body.message ?? extractLastUserMessage(body.messages)
    const parsedMessage = parseUiMessage(inboundMessage)
    if (!parsedMessage.text && !parsedMessage.contentBlocks?.length) {
      response.writeHead(400, {
        ...CORS_HEADERS,
        'content-type': 'application/json'
      })
      response.end(JSON.stringify({ error: 'The last user message did not contain any supported content.' }))
      return
    }

    const requestMessageId = inboundMessage?.id?.trim() || randomUUID()
    const pending = this.createPendingTurn(chatId, requestMessageId)
    this.enqueuePendingTurn(chatId, pending)

    const stream = await this.streamContext.createNewResumableStream(pending.streamId, () => pending.responseStream)
    if (stream == null) {
      this.failPendingTurn(chatId, pending, 'A stream is already active for this request.')
      response.writeHead(409, {
        ...CORS_HEADERS,
        'content-type': 'application/json'
      })
      response.end(JSON.stringify({ error: 'A stream is already active for this request.' }))
      return
    }

    await this.writeSseResponse(response, stream)

    const message: ChannelMessage = {
      id: requestMessageId,
      remoteChatId: chatId,
      senderId: body.senderId?.trim() || 'http-client',
      text: parsedMessage.text,
      timestamp: new Date(),
      metadata: {
        httpChannelId: this.id,
        httpUserAgent: request.headers['user-agent'],
        httpRemoteAddress: request.socket.remoteAddress,
        ...(body.metadata ?? {})
      },
      contentBlocks: parsedMessage.contentBlocks
    }

    void this.emitMessage(message).catch((error) => {
      const errorMessage = `Agent error: ${toErrorMessage(error)}`
      this.logger.error(`Failed to enqueue HTTP message ${requestMessageId}`, error)
      this.failPendingTurn(chatId, pending, errorMessage)
    })
  }

  private async handleSessionRequest(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL
  ): Promise<void> {
    if (!this.acpBridge) {
      this.writeJsonResponse(response, 404, {
        error: 'Session management is not available for this HTTP channel.'
      })
      return
    }

    if (request.method === 'GET' && url.pathname === this.sessionsPath) {
      const sessions = await this.acpBridge.listSessions()
      this.writeJsonResponse(response, 200, {
        sessions
      })
      return
    }

    if (request.method === 'POST' && url.pathname === this.sessionsPath) {
      const body = (await readJsonBody(request).catch(() => ({}))) as {
        label?: unknown
      }
      const session = await this.acpBridge.createSession({
        label: typeof body.label === 'string' ? body.label : undefined
      })
      this.writeJsonResponse(response, 201, {
        session
      })
      return
    }

    const chatId = this.matchResumePath(url.pathname, this.sessionsPath, '')
    if (!chatId) {
      this.writeJsonResponse(response, 404, {
        error: 'Session not found.'
      })
      return
    }

    if (request.method === 'GET') {
      const session = await this.acpBridge.getSession(chatId)
      if (!session) {
        this.writeJsonResponse(response, 404, {
          error: 'Session not found.'
        })
        return
      }

      this.writeJsonResponse(response, 200, {
        session
      })
      return
    }

    if (request.method === 'DELETE') {
      const deleted = await this.acpBridge.deleteSession(chatId)
      if (!deleted) {
        this.writeJsonResponse(response, 409, {
          error: 'Only draft sessions can be removed from the web shell.'
        })
        return
      }

      this.writeJsonResponse(response, 204, null)
      return
    }

    this.writeJsonResponse(response, 405, {
      error: 'Method not allowed.'
    })
  }

  private async handleResume(response: ServerResponse, chatId: string): Promise<void> {
    const streamId = this.activeStreamIds.get(chatId)
    if (!streamId) {
      response.writeHead(204, CORS_HEADERS)
      response.end()
      return
    }

    const stream = await this.streamContext.resumeExistingStream(streamId)
    if (!stream) {
      this.activeStreamIds.delete(chatId)
      response.writeHead(204, CORS_HEADERS)
      response.end()
      return
    }

    await this.writeSseResponse(response, stream)
  }

  private async registerActiveStream(
    chatId: string,
    streamId: string,
    stream: ReadableStream<string>
  ): Promise<void> {
    this.activeStreamIds.set(chatId, streamId)
    const registeredStream = await this.streamContext.createNewResumableStream(streamId, () => stream)
    if (registeredStream == null) {
      this.activeStreamIds.delete(chatId)
      this.logger.warn(`Failed to register resumable stream ${streamId} for ${chatId}`)
    }
  }

  private clearActiveStream(chatId: string, streamId: string): void {
    if (this.activeStreamIds.get(chatId) === streamId) {
      this.activeStreamIds.delete(chatId)
    }
  }

  private enqueuePendingTurn(chatId: string, pending: PendingTurn): void {
    const queue = this.pendingTurns.get(chatId) ?? []
    queue.push(pending)
    this.pendingTurns.set(chatId, queue)
    if (queue.length === 1) {
      this.activeStreamIds.set(chatId, pending.streamId)
    }
  }

  private resolvePendingTurn(
    chatId: string,
    message?: ChannelMessage
  ): PendingTurn | undefined {
    const queue = this.pendingTurns.get(chatId)
    if (!queue || queue.length === 0) {
      return undefined
    }

    if (!message) {
      return queue[0]
    }

    return (
      queue.find((pending) => pending.requestMessageId === message.id) ??
      queue[0]
    )
  }

  private getCurrentPendingTurn(chatId: string): PendingTurn | undefined {
    return this.pendingTurns.get(chatId)?.[0]
  }

  private createPendingTurn(chatId: string, requestMessageId: string): PendingTurn {
    const pending = {
      chatId,
      requestMessageId,
      streamId: `http:${this.id}:${chatId}:${requestMessageId}`,
      assistantMessageId: `assistant-${requestMessageId}`,
      textPartId: `text-${requestMessageId}`,
      reasoningPartId: `reasoning-${requestMessageId}`,
      controller: null,
      messageStarted: false,
      textStarted: false,
      reasoningStarted: false,
      toolStates: new Map(),
      closed: false
    } as PendingTurn

    pending.responseStream = new ReadableStream<string>({
      start: (controller) => {
        pending.controller = controller
      }
    })

    return pending
  }

  private ensureMessageStarted(pending: PendingTurn): void {
    if (pending.messageStarted) {
      return
    }

    this.writePendingChunk(pending, {
      type: 'start',
      messageId: pending.assistantMessageId
    })
    pending.messageStarted = true
  }

  private ensureTextStarted(pending: PendingTurn): void {
    if (pending.textStarted) {
      return
    }

    this.writePendingChunk(pending, {
      type: 'text-start',
      id: pending.textPartId
    })
    pending.textStarted = true
  }

  private ensureReasoningStarted(pending: PendingTurn): void {
    if (pending.reasoningStarted) {
      return
    }

    this.writePendingChunk(pending, {
      type: 'reasoning-start',
      id: pending.reasoningPartId
    })
    pending.reasoningStarted = true
  }

  private emitAcpToolChunks(
    pending: PendingTurn,
    event: Extract<ChannelEvent, { type: 'protocol-event' }>['event']
  ): void {
    if (event.source !== 'acp') {
      return
    }

    if (event.type === 'tool-call') {
      const toolState = this.ensureToolInputStarted(
        pending,
        event.toolCallId,
        this.resolveToolName(event.title, event.toolCallId)
      )

      if (event.rawInput !== undefined && !toolState.inputAvailable) {
        this.emitToolInputAvailable(pending, event.toolCallId, event.rawInput)
      }
      return
    }

    if (event.type !== 'tool-call-update') {
      return
    }

    const toolState = this.ensureToolInputStarted(
      pending,
      event.toolCallId,
      this.resolveToolName(event.title, event.toolCallId)
    )

    if (event.rawInput !== undefined && !toolState.inputAvailable) {
      this.emitToolInputAvailable(pending, event.toolCallId, event.rawInput)
    }

    if (toolState.outputSettled) {
      return
    }

    if (event.status === 'completed') {
      this.emitToolOutputAvailable(
        pending,
        event.toolCallId,
        this.resolveToolOutput(event)
      )
      return
    }

    if (event.status === 'failed') {
      this.emitToolOutputError(
        pending,
        event.toolCallId,
        this.resolveToolError(event)
      )
    }
  }

  private ensureToolInputStarted(
    pending: PendingTurn,
    toolCallId: string,
    toolName: string
  ): PendingToolState {
    let toolState = pending.toolStates.get(toolCallId)
    if (!toolState) {
      toolState = {
        toolName,
        inputStarted: false,
        inputAvailable: false,
        outputSettled: false
      }
      pending.toolStates.set(toolCallId, toolState)
    } else if (toolName) {
      toolState.toolName = toolName
    }

    if (toolState.inputStarted) {
      return toolState
    }

    this.writePendingChunk(pending, {
      type: 'tool-input-start',
      toolCallId,
      toolName: toolState.toolName,
      dynamic: true,
      title: toolState.toolName
    })
    toolState.inputStarted = true
    return toolState
  }

  private emitToolInputAvailable(
    pending: PendingTurn,
    toolCallId: string,
    input: unknown
  ): void {
    const toolState = this.ensureToolInputStarted(
      pending,
      toolCallId,
      pending.toolStates.get(toolCallId)?.toolName ?? toolCallId
    )

    if (toolState.inputAvailable) {
      return
    }

    this.writePendingChunk(pending, {
      type: 'tool-input-available',
      toolCallId,
      toolName: toolState.toolName,
      input,
      dynamic: true,
      title: toolState.toolName
    })
    toolState.inputAvailable = true
  }

  private emitToolOutputAvailable(
    pending: PendingTurn,
    toolCallId: string,
    output: unknown
  ): void {
    const toolState = this.ensureToolInputStarted(
      pending,
      toolCallId,
      pending.toolStates.get(toolCallId)?.toolName ?? toolCallId
    )

    if (toolState.outputSettled) {
      return
    }

    this.writePendingChunk(pending, {
      type: 'tool-output-available',
      toolCallId,
      output,
      dynamic: true
    })
    toolState.outputSettled = true
  }

  private emitToolOutputError(
    pending: PendingTurn,
    toolCallId: string,
    errorText: string
  ): void {
    const toolState = this.ensureToolInputStarted(
      pending,
      toolCallId,
      pending.toolStates.get(toolCallId)?.toolName ?? toolCallId
    )

    if (toolState.outputSettled) {
      return
    }

    this.writePendingChunk(pending, {
      type: 'tool-output-error',
      toolCallId,
      errorText,
      dynamic: true
    })
    toolState.outputSettled = true
  }

  private resolveToolName(title: string | undefined, toolCallId: string): string {
    const normalizedTitle = title?.trim()
    return normalizedTitle && normalizedTitle.length > 0 ? normalizedTitle : toolCallId
  }

  private resolveToolOutput(
    event: Extract<
      Extract<ChannelEvent, { type: 'protocol-event' }>['event'],
      { source: 'acp'; type: 'tool-call-update' }
    >
  ): unknown {
    if (event.rawOutput !== undefined) {
      return event.rawOutput
    }

    if (event.content && event.content.length === 1) {
      return event.content[0]
    }

    if (event.content && event.content.length > 1) {
      return event.content
    }

    return {
      status: event.status ?? 'completed'
    }
  }

  private resolveToolError(
    event: Extract<
      Extract<ChannelEvent, { type: 'protocol-event' }>['event'],
      { source: 'acp'; type: 'tool-call-update' }
    >
  ): string {
    const candidates = [event.rawOutput, event.content]
    for (const candidate of candidates) {
      const message = this.stringifyToolPayload(candidate)
      if (message) {
        return message
      }
    }

    return `${this.resolveToolName(event.title, event.toolCallId)} failed.`
  }

  private stringifyToolPayload(value: unknown): string | undefined {
    if (typeof value === 'string') {
      const trimmed = value.trim()
      return trimmed || undefined
    }

    if (Array.isArray(value)) {
      const textParts = value
        .map((entry) => {
          if (
            entry &&
            typeof entry === 'object' &&
            'type' in entry &&
            entry.type === 'text' &&
            'text' in entry &&
            typeof entry.text === 'string'
          ) {
            return entry.text.trim()
          }

          return undefined
        })
        .filter((entry): entry is string => Boolean(entry))

      if (textParts.length > 0) {
        return textParts.join('\n')
      }
    }

    if (value == null) {
      return undefined
    }

    try {
      return JSON.stringify(value, null, 2)
    } catch {
      return String(value)
    }
  }

  private finishPendingTurn(chatId: string, pending: PendingTurn, text: string): void {
    if (pending.closed) {
      return
    }

    this.ensureMessageStarted(pending)

    if (text) {
      this.ensureTextStarted(pending)
      this.writePendingChunk(pending, {
        type: 'text-delta',
        id: pending.textPartId,
        delta: text
      })
    }

    if (pending.reasoningStarted) {
      this.writePendingChunk(pending, {
        type: 'reasoning-end',
        id: pending.reasoningPartId
      })
    }

    if (pending.textStarted) {
      this.writePendingChunk(pending, {
        type: 'text-end',
        id: pending.textPartId
      })
    }

    this.writePendingChunk(pending, {
      type: 'finish'
    })
    this.closePendingTurn(pending)
    this.dequeuePendingTurn(chatId, pending)
  }

  private failPendingTurn(chatId: string, pending: PendingTurn, message: string): void {
    if (pending.closed) {
      return
    }

    this.ensureMessageStarted(pending)
    this.writePendingChunk(pending, {
      type: 'error',
      errorText: message
    })
    this.closePendingTurn(pending)
    this.dequeuePendingTurn(chatId, pending)
  }

  private dequeuePendingTurn(chatId: string, pending: PendingTurn): void {
    const queue = this.pendingTurns.get(chatId)
    if (!queue) {
      this.activeStreamIds.delete(chatId)
      return
    }

    const nextQueue = queue.filter((entry) => entry !== pending)
    if (nextQueue.length === 0) {
      this.pendingTurns.delete(chatId)
      this.activeStreamIds.delete(chatId)
      return
    }

    this.pendingTurns.set(chatId, nextQueue)
    this.activeStreamIds.set(chatId, nextQueue[0]!.streamId)
  }

  private closePendingTurn(pending: PendingTurn): void {
    if (pending.closed) {
      return
    }

    pending.closed = true
    pending.controller?.close()
    pending.controller = null
  }

  private writePendingChunk(pending: PendingTurn, chunk: Record<string, unknown>): void {
    if (pending.closed) {
      return
    }

    pending.controller?.enqueue(`data: ${JSON.stringify(chunk)}\n\n`)
  }

  private writeJsonResponse(
    response: ServerResponse,
    statusCode: number,
    payload: unknown
  ): void {
    if (payload == null && statusCode === 204) {
      response.writeHead(204, CORS_HEADERS)
      response.end()
      return
    }

    response.writeHead(statusCode, {
      ...CORS_HEADERS,
      'content-type': 'application/json'
    })
    response.end(JSON.stringify(payload))
  }

  private async handleStaticWebRequest(
    url: URL,
    response: ServerResponse
  ): Promise<void> {
    switch (url.pathname) {
      case '/':
        response.writeHead(200, {
          ...STATIC_ASSET_HEADERS,
          'content-type': 'text/html; charset=utf-8'
        })
        response.end(this.renderWebAppHtml())
        return

      case '/app.js':
        response.writeHead(200, {
          ...STATIC_ASSET_HEADERS,
          'content-type': 'application/javascript; charset=utf-8'
        })
        response.end(await this.readWebAsset('app.js'))
        return

      case '/app.css':
        response.writeHead(200, {
          ...STATIC_ASSET_HEADERS,
          'content-type': 'text/css; charset=utf-8'
        })
        response.end(await this.readWebAsset('app.css'))
        return
    }
  }

  private isAuthorized(request: IncomingMessage, url: URL): boolean {
    if (!this.accessToken) {
      return true
    }

    const authorization = request.headers.authorization?.trim()
    const bearerToken =
      authorization?.toLowerCase().startsWith('bearer ')
        ? authorization.slice('bearer '.length).trim()
        : undefined
    const queryToken = url.searchParams.get('token')?.trim()

    return bearerToken === this.accessToken || queryToken === this.accessToken
  }

  private matchResumePath(pathname: string, basePath: string, suffix: string): string | undefined {
    const base = basePath === '/' ? '' : basePath
    const pattern = new RegExp(
      `^${escapeRegExp(base)}/([^/]+)${suffix ? `${escapeRegExp(suffix)}` : ''}$`
    )
    return pathname.match(pattern)?.[1]
  }

  private async writeSseResponse(
    response: ServerResponse,
    stream: ReadableStream<string>
  ): Promise<void> {
    response.writeHead(200, {
      ...CORS_HEADERS,
      ...UI_MESSAGE_STREAM_HEADERS
    })

    const encodedStream = stream.pipeThrough(new TextEncoderStream())
    const nodeStream = Readable.fromWeb(encodedStream as unknown as NodeReadableStream)
    nodeStream.pipe(response)
  }

  private async readWebAsset(filename: 'app.js' | 'app.css'): Promise<string> {
    const cachedAsset = this.webAssetCache.get(filename)
    if (cachedAsset != null) {
      return cachedAsset
    }

    const candidatePaths = [
      new URL(`../../web/${filename}`, import.meta.url),
      new URL(`../../../apps/web/dist/${filename}`, import.meta.url)
    ]

    for (const filePath of candidatePaths) {
      try {
        const asset = await readFile(filePath, 'utf-8')
        this.webAssetCache.set(filename, asset)
        return asset
      } catch (error) {
        if (!isEnoent(error)) {
          throw error
        }
      }
    }

    throw new Error(
      `Missing web asset ${filename}. Run \"pnpm run build:web\" before starting the HTTP web shell.`
    )
  }

  private renderWebAppHtml(): string {
    const bootConfig = JSON.stringify({
      channelId: this.id,
      title: this.title,
      chatPath: this.chatPath,
      ssePath: this.ssePath,
      sessionsPath: this.sessionsPath,
      requiresToken: Boolean(this.accessToken)
    }).replace(/</g, '\\u003c')

    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${this.escapeHtml(this.title)}</title>
    <link rel="stylesheet" href="/app.css" />
  </head>
  <body>
    <div id="app"></div>
    <script>window.__TIA_GATEWAY_BOOT__ = ${bootConfig};</script>
    <script type="module" src="/app.js"></script>
  </body>
</html>`
  }

  private escapeHtml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
  }

  private async resolveAccessToken(): Promise<ResolvedHttpToken> {
    if (this.configuredToken) {
      return {
        token: this.configuredToken,
        created: false
      }
    }

    if (!this.autoGenerateToken) {
      return {
        created: false
      }
    }

    const tokenFilePath = this.getTokenFilePath()

    try {
      const persistedToken = JSON.parse(
        await readFile(tokenFilePath, 'utf-8')
      ) as PersistedHttpToken
      const token = persistedToken.token?.trim()
      if (token) {
        return {
          token,
          created: false
        }
      }
    } catch (error) {
      if (!isEnoent(error)) {
        this.logger.warn(
          `Failed to read persisted HTTP token for ${this.id}; generating a new one.`,
          { errorMessage: toErrorMessage(error) }
        )
      }
    }

    const token = randomBytes(24).toString('base64url')
    const tokenDirectory = join(defaultStorageDir(), 'channels', this.id)

    await mkdir(tokenDirectory, { recursive: true })
    await writeFile(
      tokenFilePath,
      JSON.stringify(
        {
          token,
          createdAt: new Date().toISOString()
        } satisfies PersistedHttpToken,
        null,
        2
      ),
      'utf-8'
    )

    return {
      token,
      created: true
    }
  }

  private getTokenFilePath(): string {
    return join(defaultStorageDir(), 'channels', this.id, HTTP_TOKEN_FILE_NAME)
  }

  private getDisplayUrl(pathname: string): string {
    const rawHost =
      this.host === '0.0.0.0'
        ? '127.0.0.1'
        : this.host === '::'
          ? '::1'
          : this.host
    const displayHost =
      rawHost.includes(':') && !rawHost.startsWith('[') ? `[${rawHost}]` : rawHost

    return `http://${displayHost}:${this.getListeningPort()}${pathname}`
  }

  private getListeningPort(): number {
    const address = this.server?.address()
    if (address && typeof address === 'object' && 'port' in address) {
      return address.port
    }

    return this.port
  }
}
