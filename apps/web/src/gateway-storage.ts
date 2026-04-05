import type { StoredShellState } from './gateway-types.js'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function getTokenStorageKey(channelId: string): string {
  return `tia-gateway:${channelId}:token`
}

export function getShellStorageKey(channelId: string): string {
  return `tia-gateway:${channelId}:shell`
}

export function readStoredToken(tokenStorageKey: string): string {
  const url = new URL(window.location.href)
  const queryToken = url.searchParams.get('token')?.trim()

  if (queryToken) {
    try {
      window.localStorage.setItem(tokenStorageKey, queryToken)
    } catch {
      // Ignore storage failures and keep the token in memory.
    }

    url.searchParams.delete('token')
    const nextSearch = url.searchParams.toString()
    const nextUrl = `${url.pathname}${nextSearch ? `?${nextSearch}` : ''}${url.hash}`
    window.history.replaceState({}, '', nextUrl)
    return queryToken
  }

  try {
    return window.localStorage.getItem(tokenStorageKey)?.trim() ?? ''
  } catch {
    return ''
  }
}

export function persistToken(tokenStorageKey: string, token: string): void {
  try {
    if (token) {
      window.localStorage.setItem(tokenStorageKey, token)
    } else {
      window.localStorage.removeItem(tokenStorageKey)
    }
  } catch {
    // Ignore storage failures and continue with in-memory state.
  }
}

export function readStoredShellState(shellStateStorageKey: string): StoredShellState {
  try {
    const raw = window.localStorage.getItem(shellStateStorageKey)
    if (!raw) {
      return {
        sidebarCollapsed: false
      }
    }

    const parsed = JSON.parse(raw) as unknown
    if (!isRecord(parsed)) {
      return {
        sidebarCollapsed: false
      }
    }

    return {
      activeChatId:
        typeof parsed.activeChatId === 'string' && parsed.activeChatId.trim()
          ? parsed.activeChatId.trim()
          : undefined,
      sidebarCollapsed: parsed.sidebarCollapsed === true
    }
  } catch {
    return {
      sidebarCollapsed: false
    }
  }
}

export function persistShellState(
  shellStateStorageKey: string,
  state: StoredShellState
): void {
  try {
    window.localStorage.setItem(shellStateStorageKey, JSON.stringify(state))
  } catch {
    // Ignore storage failures and continue with in-memory state.
  }
}
