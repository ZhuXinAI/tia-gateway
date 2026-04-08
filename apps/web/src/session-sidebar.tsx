import { useEffect, useMemo, useState } from 'react'
import { ChevronRightIcon, FolderIcon, PlusIcon, RefreshCwIcon, TrashIcon } from 'lucide-react'
import type { HttpSessionSummary } from './gateway-types'
import { cn } from './lib/utils'
import { Button } from './components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './components/ui/collapsible'
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem
} from './components/ui/sidebar'

type SessionSidebarProps = {
  collapsed?: boolean
  sessions: HttpSessionSummary[]
  activeChatId: string
  locked: boolean
  isLoadingSessions: boolean
  isCreatingSession: boolean
  deletingChatId: string
  onSelectSession: (chatId: string) => void
  onRefreshSessions: () => void
  onCreateSession: () => void
  onDeleteSession: (chatId: string) => void
}

type SessionGroup = {
  key: string
  workspacePath?: string
  displayName: string
  sessions: HttpSessionSummary[]
}

function toWorkspaceGroupMeta(cwd: string | undefined): {
  key: string
  workspacePath?: string
  displayName: string
} {
  const trimmed = cwd?.trim() || ''
  if (!trimmed) {
    return {
      key: '__no-workspace__',
      displayName: 'No workspace'
    }
  }

  const normalized = trimmed.replace(/\\/g, '/')
  const withoutTrailingSlash = normalized.replace(/\/+$/, '') || '/'
  const pathSegments = withoutTrailingSlash.split('/').filter(Boolean)
  const displayName =
    withoutTrailingSlash === '/' ? '/' : pathSegments[pathSegments.length - 1] || withoutTrailingSlash

  return {
    key: trimmed,
    workspacePath: trimmed,
    displayName
  }
}

function groupSessionsByWorkspace(sessions: HttpSessionSummary[]): SessionGroup[] {
  const groups = new Map<string, SessionGroup>()

  for (const session of sessions) {
    const { key, workspacePath, displayName } = toWorkspaceGroupMeta(session.cwd)
    const existing = groups.get(key)

    if (existing) {
      existing.sessions.push(session)
      continue
    }

    groups.set(key, {
      key,
      workspacePath,
      displayName,
      sessions: [session]
    })
  }

  return [...groups.values()]
}

export function SessionSidebar({
  collapsed,
  sessions,
  activeChatId,
  locked,
  isLoadingSessions,
  isCreatingSession,
  deletingChatId,
  onSelectSession,
  onRefreshSessions,
  onCreateSession,
  onDeleteSession
}: SessionSidebarProps): JSX.Element {
  const groupedSessions = useMemo(() => groupSessionsByWorkspace(sessions), [sessions])
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({})

  useEffect(() => {
    setOpenGroups((previous) => {
      const next: Record<string, boolean> = {}
      for (const [index, group] of groupedSessions.entries()) {
        next[group.key] = previous[group.key] ?? index === 0
      }
      return next
    })
  }, [groupedSessions])

  return (
    <aside
      className={cn(
        'aui-root aui-thread-list-root flex h-full flex-col gap-2 transition-all duration-200',
        collapsed ? 'w-0 overflow-hidden opacity-0' : 'w-full opacity-100'
      )}
    >
      <div className="grid grid-cols-2 gap-2">
        <Button
          variant="outline"
          className="h-9 justify-start gap-2 rounded-lg px-3 text-sm"
          disabled={isLoadingSessions || locked}
          onClick={onRefreshSessions}
          type="button"
        >
          <RefreshCwIcon className={cn('size-4', isLoadingSessions && 'animate-spin')} />
          Refresh
        </Button>
        <Button
          variant="outline"
          className="h-9 justify-start gap-2 rounded-lg px-3 text-sm"
          disabled={isCreatingSession || locked}
          onClick={onCreateSession}
          type="button"
        >
          <PlusIcon className="size-4" />
          New Thread
        </Button>
      </div>

      {sessions.length === 0 && !isLoadingSessions ? (
        <div className="flex h-9 items-center px-3 text-sm text-muted-foreground">
          {locked ? 'Unlock gateway to load sessions.' : 'No threads yet.'}
        </div>
      ) : null}

      <div className="flex flex-col gap-2">
        {groupedSessions.map((group) => {
          const isOpen = openGroups[group.key] ?? false

          return (
            <Collapsible
              key={group.key}
              open={isOpen}
              onOpenChange={(nextOpen) => {
                setOpenGroups((previous) => ({
                  ...previous,
                  [group.key]: nextOpen
                }))
              }}
            >
              <SidebarGroup>
                <CollapsibleTrigger
                  className="w-full rounded-md hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
                  title={group.workspacePath || group.displayName}
                  type="button"
                >
                  <SidebarGroupLabel className="pointer-events-none min-w-0 px-2 py-1.5">
                    <ChevronRightIcon
                      className={cn('size-3.5 shrink-0 transition-transform', isOpen && 'rotate-90')}
                    />
                    <FolderIcon className="size-3.5 shrink-0" />
                    <span className="min-w-0 flex-1 truncate text-sm text-foreground/90">
                      {group.displayName}
                    </span>
                    <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      {group.sessions.length}
                    </span>
                  </SidebarGroupLabel>
                </CollapsibleTrigger>

                <CollapsibleContent>
                  <SidebarGroupContent>
                    <SidebarMenu className="ml-5 mt-0.5">
                      {group.sessions.map((session) => {
                        const isActive = session.chatId === activeChatId

                        return (
                          <SidebarMenuItem key={session.chatId}>
                            <SidebarMenuButton
                              className="pr-9"
                              isActive={isActive}
                              onClick={() => onSelectSession(session.chatId)}
                              type="button"
                            >
                              <span className="min-w-0 flex-1 truncate">
                                {session.label || 'New Chat'}
                              </span>
                            </SidebarMenuButton>

                            {session.canDelete ? (
                              <SidebarMenuAction
                                aria-label={`Remove ${session.label}`}
                                asChild
                                className="absolute top-1/2 right-0 -translate-y-1/2 bg-transparent hover:bg-muted"
                                disabled={deletingChatId === session.chatId}
                                onClick={() => onDeleteSession(session.chatId)}
                                type="button"
                              >
                                <Button
                                  disabled={deletingChatId === session.chatId}
                                  size="icon"
                                  type="button"
                                  variant="ghost"
                                >
                                  {deletingChatId === session.chatId ? (
                                    <RefreshCwIcon className="size-4 animate-spin" />
                                  ) : (
                                    <TrashIcon className="size-4" />
                                  )}
                                </Button>
                              </SidebarMenuAction>
                            ) : null}
                          </SidebarMenuItem>
                        )
                      })}
                    </SidebarMenu>
                  </SidebarGroupContent>
                </CollapsibleContent>
              </SidebarGroup>
            </Collapsible>
          )
        })}
      </div>
    </aside>
  )
}
