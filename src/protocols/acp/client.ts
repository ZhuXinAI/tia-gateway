import fs from 'node:fs'
import type * as acp from '@agentclientprotocol/sdk'
import type { AgentProtocolEvent } from '../../core/types.js'

export interface AcpClientCallbacks {
  sendTyping: () => Promise<void>
  onThoughtFlush: (text: string) => Promise<void>
  onToolCall?: (text: string) => Promise<void>
  onTextDelta?: (text: string) => Promise<void>
  onReasoningDelta?: (text: string) => Promise<void>
  onEvent?: (event: AgentProtocolEvent) => Promise<void>
}

export interface GatewayAcpClientOptions extends AcpClientCallbacks {
  log: (message: string) => void
  showThoughts: boolean
  showTools: boolean
}

export class GatewayAcpClient implements acp.Client {
  private readonly chunks: string[] = []
  private readonly thoughtChunks: string[] = []
  private readonly toolCallTitles = new Map<string, string>()
  private readonly toolCallStatuses = new Map<string, string | undefined>()
  private callbacks: GatewayAcpClientOptions
  private lastTypingAt = 0

  private static readonly TYPING_INTERVAL_MS = 5_000

  constructor(options: GatewayAcpClientOptions) {
    this.callbacks = options
  }

  updateCallbacks(callbacks: AcpClientCallbacks): void {
    this.callbacks = {
      ...this.callbacks,
      ...callbacks
    }
  }

  async requestPermission(
    params: acp.RequestPermissionRequest
  ): Promise<acp.RequestPermissionResponse> {
    const allowOption = params.options.find(
      (option) => option.kind === 'allow_once' || option.kind === 'allow_always'
    )
    const optionId = allowOption?.optionId ?? params.options[0]?.optionId ?? 'allow'

    this.callbacks.log(
      `[permission] auto-allowed: ${params.toolCall?.title ?? 'unknown'} -> ${optionId}`
    )
    await this.emitEvent({
      source: 'acp',
      type: 'permission',
      title: params.toolCall?.title ?? undefined,
      optionId
    })

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
      case 'agent_message_chunk':
        await this.flushThoughtsIfNeeded()
        if (update.content.type === 'text') {
          this.chunks.push(update.content.text)
          await this.callbacks.onTextDelta?.(update.content.text)
        }
        await this.maybeSendTyping()
        break

      case 'tool_call':
        await this.flushThoughtsIfNeeded()
        this.toolCallTitles.set(update.toolCallId, update.title)
        this.toolCallStatuses.set(update.toolCallId, update.status ?? undefined)
        this.callbacks.log(`[tool] ${update.title} (${update.status})`)
        await this.emitEvent({
          source: 'acp',
          type: 'tool-call',
          toolCallId: update.toolCallId,
          title: update.title,
          status: update.status ?? undefined,
          rawInput: update.rawInput
        })
        await this.emitToolCallIfNeeded(
          this.formatToolCallText(update.title, update.status ?? undefined)
        )
        await this.maybeSendTyping()
        break

      case 'agent_thought_chunk':
        if (update.content.type === 'text') {
          this.callbacks.log(
            `[thought] ${
              update.content.text.length > 80
                ? `${update.content.text.slice(0, 80)}...`
                : update.content.text
            }`
          )

          if (this.callbacks.showThoughts) {
            this.thoughtChunks.push(update.content.text)
            await this.callbacks.onReasoningDelta?.(update.content.text)
          }
        }
        await this.maybeSendTyping()
        break

      case 'tool_call_update':
        {
          const previousTitle = this.toolCallTitles.get(update.toolCallId)
          const previousStatus = this.toolCallStatuses.get(update.toolCallId)
          const nextTitle = update.title?.trim() || previousTitle || update.toolCallId
          if (update.title?.trim()) {
            this.toolCallTitles.set(update.toolCallId, update.title.trim())
          }
          if (update.status !== undefined) {
            this.toolCallStatuses.set(update.toolCallId, update.status ?? undefined)
          }

          if (update.status === 'completed' && update.content) {
            for (const content of update.content) {
              if (content.type !== 'diff') {
                continue
              }

              const diff = content as acp.Diff
              const lines = [`--- ${diff.path}`]
              if (diff.oldText != null) {
                for (const line of diff.oldText.split('\n')) {
                  lines.push(`- ${line}`)
                }
              }

              if (diff.newText != null) {
                for (const line of diff.newText.split('\n')) {
                  lines.push(`+ ${line}`)
                }
              }

              this.chunks.push(`\n\`\`\`diff\n${lines.join('\n')}\n\`\`\`\n`)
            }
          }

          if (update.status) {
            this.callbacks.log(`[tool] ${update.toolCallId} -> ${update.status}`)
          }
          await this.emitEvent({
            source: 'acp',
            type: 'tool-call-update',
            toolCallId: update.toolCallId,
            title: update.title?.trim() || undefined,
            status: update.status ?? undefined,
            content: update.content as unknown[] | undefined,
            rawInput: update.rawInput,
            rawOutput: update.rawOutput
          })
          if (
            update.status !== undefined ||
            (update.title?.trim() && update.title.trim() !== previousTitle)
          ) {
            await this.emitToolCallIfNeeded(
              this.formatToolCallText(
                nextTitle,
                update.status ?? previousStatus ?? undefined
              )
            )
          }
        }
        break

      case 'plan':
        if (update.entries) {
          const lines = update.entries
            .map((entry, index) => `  ${index + 1}. [${entry.status}] ${entry.content}`)
            .join('\n')
          this.callbacks.log(`[plan]\n${lines}`)
          await this.emitEvent({
            source: 'acp',
            type: 'plan',
            entries: update.entries.map((entry) => ({
              status: entry.status,
              content: entry.content
            }))
          })
        }
        break
    }
  }

  async readTextFile(params: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse> {
    const content = await fs.promises.readFile(params.path, 'utf-8')
    return { content }
  }

  async writeTextFile(params: acp.WriteTextFileRequest): Promise<acp.WriteTextFileResponse> {
    await fs.promises.writeFile(params.path, params.content, 'utf-8')
    return {}
  }

  async flush(): Promise<string> {
    await this.flushThoughtsIfNeeded()
    const text = this.chunks.join('')
    this.chunks.length = 0
    this.lastTypingAt = 0
    return text
  }

  private async flushThoughtsIfNeeded(): Promise<void> {
    if (this.thoughtChunks.length === 0) {
      return
    }

    const thoughtText = this.thoughtChunks.join('')
    this.thoughtChunks.length = 0
    if (!thoughtText.trim()) {
      return
    }

    try {
      await this.callbacks.onThoughtFlush(`[Thinking]\n${thoughtText}`)
    } catch {
      // Best effort only.
    }
  }

  private async maybeSendTyping(): Promise<void> {
    const now = Date.now()
    if (now - this.lastTypingAt < GatewayAcpClient.TYPING_INTERVAL_MS) {
      return
    }

    this.lastTypingAt = now
    try {
      await this.callbacks.sendTyping()
    } catch {
      // Best effort only.
    }
  }

  private async emitEvent(event: AgentProtocolEvent): Promise<void> {
    try {
      await this.callbacks.onEvent?.(event)
    } catch {
      // Best effort only.
    }
  }

  private formatToolCallText(title: string, status?: string): string {
    return status ? `[Tool] ${title} (${status})` : `[Tool] ${title}`
  }

  private async emitToolCallIfNeeded(text: string): Promise<void> {
    if (!this.callbacks.showTools || !text.trim()) {
      return
    }

    try {
      await this.callbacks.onToolCall?.(text)
    } catch {
      // Best effort only.
    }
  }
}
