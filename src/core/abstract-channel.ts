import type { ChannelAdapter, ChannelMessage, ChannelType } from './types.js'

export abstract class AbstractChannel implements ChannelAdapter {
  onMessage?: (message: ChannelMessage) => Promise<void> | void
  acknowledgeMessage?(messageId: string): Promise<void>

  constructor(
    public readonly id: string,
    public readonly type: ChannelType
  ) {}

  protected async emitMessage(message: ChannelMessage): Promise<void> {
    this.acknowledgeMessage?.(message.id)?.catch(() => undefined)
    await this.onMessage?.(message)
  }

  abstract start(): Promise<void>
  abstract stop(): Promise<void>
  abstract send(remoteChatId: string, text: string): Promise<void>
  sendTyping?(_remoteChatId: string, _message?: ChannelMessage): Promise<void>
}
