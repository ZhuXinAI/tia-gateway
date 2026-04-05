import type { UIMessage } from 'ai'

export type GatewayBoot = {
  channelId: string
  title: string
  chatPath: string
  ssePath: string
  sessionsPath: string
  requiresToken: boolean
}

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

export type StoredShellState = {
  activeChatId?: string
  sidebarCollapsed: boolean
}

declare global {
  interface Window {
    __TIA_GATEWAY_BOOT__?: GatewayBoot
  }
}

export function readBootConfig(): GatewayBoot {
  const boot = window.__TIA_GATEWAY_BOOT__

  if (!boot) {
    throw new Error('Missing tia-gateway boot config.')
  }

  return boot
}
