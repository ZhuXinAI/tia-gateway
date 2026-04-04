export const UI_MESSAGE_STREAM_HEADERS = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache',
  connection: 'keep-alive',
  'x-vercel-ai-ui-message-stream': 'v1',
  'x-accel-buffering': 'no'
} as const

export const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'authorization,content-type,last-event-id'
} as const

export const HTTP_TOKEN_FILE_NAME = 'http-token.json'

export const STATIC_ASSET_HEADERS = {
  ...CORS_HEADERS,
  'cache-control': 'no-cache'
} as const
