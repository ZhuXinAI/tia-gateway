import type { UIMessage } from 'ai'
import { useMemo } from 'react'
import { AssistantRuntimeProvider } from '@assistant-ui/react'
import { AssistantChatTransport, useChatRuntime } from '@assistant-ui/react-ai-sdk'
import { buildChatHeaders } from './gateway-api'
import type { GatewayBoot } from './gateway-types'
import { Thread } from './components/assistant-ui/thread'

type GatewayThreadProps = {
  boot: GatewayBoot
  token: string
  locked: boolean
  chatId: string
  initialMessages: UIMessage[]
}

export function GatewayThread({
  boot,
  token,
  locked,
  chatId,
  initialMessages
}: GatewayThreadProps): JSX.Element {
  const transport = useMemo(() => {
    return new AssistantChatTransport({
      api: boot.chatPath,
      prepareSendMessagesRequest: async (options) => {
        const headers = new Headers(options.headers)
        const authHeaders = buildChatHeaders(token)
        authHeaders.forEach((value, key) => headers.set(key, value))

        const nextBody =
          options.body && typeof options.body === 'object'
            ? {
                ...(options.body as Record<string, unknown>),
                id: chatId,
                chatId
              }
            : {
                id: chatId,
                chatId
              }

        return {
          headers,
          body: nextBody
        }
      },
      prepareReconnectToStreamRequest: async (options) => {
        const headers = new Headers(options.headers)
        const authHeaders = buildChatHeaders(token)
        authHeaders.forEach((value, key) => headers.set(key, value))

        const api = token
          ? `${boot.ssePath}/${encodeURIComponent(chatId)}?token=${encodeURIComponent(token)}`
          : `${boot.ssePath}/${encodeURIComponent(chatId)}`

        return {
          api,
          headers
        }
      }
    })
  }, [boot.chatPath, boot.ssePath, chatId, token])

  const runtime = useChatRuntime({
    resume: !locked,
    messages: initialMessages,
    transport
  })

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Thread />
    </AssistantRuntimeProvider>
  )
}
