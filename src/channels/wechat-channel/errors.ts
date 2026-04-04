export class WechatChannelAbortedError extends Error {
  constructor() {
    super('Wechat channel request aborted')
    this.name = 'WechatChannelAbortedError'
  }
}

export function isWechatChannelAbortedError(error: unknown): boolean {
  return error instanceof WechatChannelAbortedError
}
