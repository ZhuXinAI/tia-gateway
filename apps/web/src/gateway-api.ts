import type { GatewayBoot, HttpSessionDetail, HttpSessionSummary } from './gateway-types.js'

export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return typeof error === 'string' ? error : 'Unknown error'
}

export function summarizeDetail(detail: HttpSessionDetail): HttpSessionSummary {
  return {
    chatId: detail.chatId,
    label: detail.label,
    createdAt: detail.createdAt,
    updatedAt: detail.updatedAt,
    acpSessionId: detail.acpSessionId,
    cwd: detail.cwd,
    messageCount: detail.messageCount,
    status: detail.status,
    canDelete: detail.canDelete
  }
}

export function chooseActiveChatId(
  sessions: HttpSessionSummary[],
  preferredChatId: string | undefined,
  currentActiveChatId: string
): string {
  if (preferredChatId && sessions.some((session) => session.chatId === preferredChatId)) {
    return preferredChatId
  }

  if (sessions.some((session) => session.chatId === currentActiveChatId)) {
    return currentActiveChatId
  }

  return sessions[0]?.chatId ?? ''
}

function buildAuthHeaders(token: string | null | undefined): Headers {
  const headers = new Headers()
  if (token?.trim()) {
    headers.set('authorization', `Bearer ${token.trim()}`)
  }
  return headers
}

export async function validateToken(boot: GatewayBoot, token: string): Promise<boolean> {
  const probeUrl = `${boot.ssePath}/auth-probe?token=${encodeURIComponent(token)}`
  const response = await fetch(probeUrl, {
    method: 'GET',
    headers: buildAuthHeaders(token)
  })

  return response.status === 204 || response.ok
}

async function fetchGatewayJson<T>(
  path: string,
  input: {
    method?: string
    body?: unknown
    token: string
  }
): Promise<T> {
  const headers = new Headers()
  const authHeaders = buildAuthHeaders(input.token)
  authHeaders.forEach((value, key) => headers.set(key, value))

  if (input.body !== undefined) {
    headers.set('content-type', 'application/json')
  }

  const response = await fetch(path, {
    method: input.method ?? 'GET',
    headers,
    ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {})
  })

  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`
    try {
      const data = (await response.json()) as { error?: unknown }
      if (typeof data.error === 'string' && data.error.trim()) {
        message = data.error
      }
    } catch {
      // Ignore body parsing errors and return the HTTP status.
    }

    throw new Error(message)
  }

  if (response.status === 204) {
    return undefined as T
  }

  return (await response.json()) as T
}

export async function loadSessionSummaries(
  boot: GatewayBoot,
  token: string
): Promise<HttpSessionSummary[]> {
  const data = await fetchGatewayJson<{ sessions: HttpSessionSummary[] }>(boot.sessionsPath, {
    token
  })
  return data.sessions
}

export async function loadSessionDetail(
  boot: GatewayBoot,
  token: string,
  chatId: string
): Promise<HttpSessionDetail> {
  const data = await fetchGatewayJson<{ session: HttpSessionDetail }>(
    `${boot.sessionsPath}/${encodeURIComponent(chatId)}`,
    {
      token
    }
  )
  return data.session
}

export async function createGatewaySession(
  boot: GatewayBoot,
  token: string
): Promise<HttpSessionSummary> {
  const data = await fetchGatewayJson<{ session: HttpSessionSummary }>(boot.sessionsPath, {
    method: 'POST',
    token
  })
  return data.session
}

export async function deleteGatewaySession(
  boot: GatewayBoot,
  token: string,
  chatId: string
): Promise<void> {
  await fetchGatewayJson<void>(`${boot.sessionsPath}/${encodeURIComponent(chatId)}`, {
    method: 'DELETE',
    token
  })
}

export function buildChatHeaders(token: string | null | undefined): Headers {
  return buildAuthHeaders(token)
}
