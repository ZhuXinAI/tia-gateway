import { randomUUID } from 'node:crypto'
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'
import type { Logger } from '../logging.js'
import { AbstractChannel } from '../core/abstract-channel.js'
import type { ChannelEvent, ChannelMessage } from '../core/types.js'

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,OPTIONS',
  'access-control-allow-headers': 'authorization,content-type'
} as const

type WebSocketInboundMessage = {
  type?: string
  id?: string
  text?: string
  senderId?: string
  metadata?: Record<string, unknown>
}

export interface WebSocketChannelOptions {
  id: string
  host: string
  port: number
  path?: string
  token?: string
  logger: Logger
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return typeof error === 'string' ? error : 'Unknown error'
}

function normalizePath(value: string): string {
  const trimmed = value.trim()
  if (!trimmed || trimmed === '/') {
    return '/'
  }

  const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`
  return withLeadingSlash.length > 1 && withLeadingSlash.endsWith('/')
    ? withLeadingSlash.slice(0, -1)
    : withLeadingSlash
}

export class WebSocketChannel extends AbstractChannel {
  private readonly logger: Logger
  private readonly host: string
  private readonly port: number
  private readonly path: string
  private readonly token?: string
  private readonly socketsByChatId = new Map<string, Set<WebSocket>>()
  private readonly chatIdBySocket = new Map<WebSocket, string>()
  private readonly errorChats = new Set<string>()
  private server: Server | null = null
  private wsServer: WebSocketServer | null = null

  constructor(options: WebSocketChannelOptions) {
    super(options.id, 'websocket')
    this.logger = options.logger.child(`websocket:${options.id}`)
    this.host = options.host
    this.port = options.port
    this.path = normalizePath(options.path ?? '/ws')
    this.token = options.token?.trim() || undefined
  }

  async start(): Promise<void> {
    if (this.server || this.wsServer) {
      return
    }

    const server = createServer((request, response) => {
      this.handleHttpRequest(request, response)
    })
    const wsServer = new WebSocketServer({ noServer: true })

    server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? `${this.host}:${this.port}`}`)

      if (url.pathname !== this.path) {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
        socket.destroy()
        return
      }

      if (!this.isAuthorized(request, url)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        socket.destroy()
        return
      }

      const chatId = url.searchParams.get('chatId')?.trim() || randomUUID()
      wsServer.handleUpgrade(request, socket, head, (webSocket) => {
        this.registerSocket(chatId, webSocket)
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
    this.wsServer = wsServer
    this.logger.info(`Listening on ws://${this.host}:${this.port}${this.path}`)
  }

  async stop(): Promise<void> {
    const server = this.server
    const wsServer = this.wsServer
    this.server = null
    this.wsServer = null

    for (const socket of this.chatIdBySocket.keys()) {
      socket.close()
    }
    this.socketsByChatId.clear()
    this.chatIdBySocket.clear()
    this.errorChats.clear()

    if (wsServer) {
      await new Promise<void>((resolve) => {
        wsServer.close(() => resolve())
      })
    }

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
    if (this.errorChats.delete(remoteChatId)) {
      return
    }

    this.broadcast(remoteChatId, {
      type: 'message',
      text
    })
  }

  async sendTyping(remoteChatId: string): Promise<void> {
    this.broadcast(remoteChatId, {
      type: 'typing'
    })
  }

  async sendEvent(remoteChatId: string, event: ChannelEvent): Promise<void> {
    if (event.type === 'error') {
      this.errorChats.add(remoteChatId)
    }

    this.broadcast(remoteChatId, event)
  }

  private handleHttpRequest(request: IncomingMessage, response: ServerResponse): void {
    if (request.method === 'OPTIONS') {
      response.writeHead(204, CORS_HEADERS)
      response.end()
      return
    }

    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? `${this.host}:${this.port}`}`)
    if (url.pathname !== this.path) {
      response.writeHead(404, {
        ...CORS_HEADERS,
        'content-type': 'application/json'
      })
      response.end(JSON.stringify({ error: 'Not Found' }))
      return
    }

    response.writeHead(200, {
      ...CORS_HEADERS,
      'content-type': 'application/json'
    })
    response.end(
      JSON.stringify({
        channelId: this.id,
        type: this.type,
        path: this.path
      })
    )
  }

  private registerSocket(chatId: string, socket: WebSocket): void {
    const sockets = this.socketsByChatId.get(chatId) ?? new Set<WebSocket>()
    sockets.add(socket)
    this.socketsByChatId.set(chatId, sockets)
    this.chatIdBySocket.set(socket, chatId)

    this.sendSocketMessage(socket, {
      type: 'ready',
      channelId: this.id,
      chatId
    })

    socket.on('message', (data) => {
      void this.handleSocketMessage(socket, data).catch((error) => {
        this.logger.error(`Failed to process WebSocket frame for ${chatId}`, error)
        this.sendSocketMessage(socket, {
          type: 'error',
          message: `Invalid WebSocket message: ${toErrorMessage(error)}`
        })
      })
    })

    socket.on('close', () => {
      this.unregisterSocket(socket)
    })

    socket.on('error', (error) => {
      this.logger.error(`WebSocket connection error for ${chatId}`, error)
    })
  }

  private unregisterSocket(socket: WebSocket): void {
    const chatId = this.chatIdBySocket.get(socket)
    if (!chatId) {
      return
    }

    this.chatIdBySocket.delete(socket)
    const sockets = this.socketsByChatId.get(chatId)
    if (!sockets) {
      return
    }

    sockets.delete(socket)
    if (sockets.size === 0) {
      this.socketsByChatId.delete(chatId)
      this.errorChats.delete(chatId)
    }
  }

  private async handleSocketMessage(socket: WebSocket, rawData: WebSocket.RawData): Promise<void> {
    const chatId = this.chatIdBySocket.get(socket)
    if (!chatId) {
      return
    }

    const payload = JSON.parse(rawData.toString()) as WebSocketInboundMessage
    switch (payload.type) {
      case 'ping':
        this.sendSocketMessage(socket, {
          type: 'pong'
        })
        return

      case 'message': {
        const text = payload.text?.trim()
        if (!text) {
          this.sendSocketMessage(socket, {
            type: 'error',
            message: 'Message text is required.'
          })
          return
        }

        await this.emitMessage({
          id: payload.id?.trim() || randomUUID(),
          remoteChatId: chatId,
          senderId: payload.senderId?.trim() || 'websocket-client',
          text,
          timestamp: new Date(),
          metadata: {
            websocketChannelId: this.id,
            ...(payload.metadata ?? {})
          }
        } satisfies ChannelMessage)
        return
      }

      default:
        this.sendSocketMessage(socket, {
          type: 'error',
          message: 'Unsupported WebSocket message type.'
        })
    }
  }

  private isAuthorized(request: IncomingMessage, url: URL): boolean {
    if (!this.token) {
      return true
    }

    const authorization = request.headers.authorization?.trim()
    const bearerToken =
      authorization?.toLowerCase().startsWith('bearer ')
        ? authorization.slice('bearer '.length).trim()
        : undefined
    const queryToken = url.searchParams.get('token')?.trim()

    return bearerToken === this.token || queryToken === this.token
  }

  private broadcast(chatId: string, payload: Record<string, unknown>): void {
    const sockets = this.socketsByChatId.get(chatId)
    if (!sockets || sockets.size === 0) {
      return
    }

    const message = JSON.stringify(payload)
    for (const socket of sockets) {
      this.sendRaw(socket, message)
    }
  }

  private sendSocketMessage(socket: WebSocket, payload: Record<string, unknown>): void {
    this.sendRaw(socket, JSON.stringify(payload))
  }

  private sendRaw(socket: WebSocket, payload: string): void {
    if (socket.readyState !== WebSocket.OPEN) {
      return
    }

    socket.send(payload)
  }
}
