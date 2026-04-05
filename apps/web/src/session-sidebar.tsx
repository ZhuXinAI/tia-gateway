import { PlusIcon, RefreshCwIcon, TrashIcon } from 'lucide-react'
import type { HttpSessionSummary } from './gateway-types'
import { cn } from './lib/utils'
import { Button } from './components/ui/button'

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

      <div className="flex flex-col gap-1">
        {sessions.map((session) => {
          const isActive = session.chatId === activeChatId

          return (
            <div
              key={session.chatId}
              className={cn(
                'group flex h-9 items-center gap-2 rounded-lg transition-colors',
                isActive ? 'bg-muted' : 'hover:bg-muted focus-within:bg-muted'
              )}
            >
              <button
                className="flex h-full min-w-0 flex-1 items-center px-3 text-start text-sm"
                onClick={() => onSelectSession(session.chatId)}
                type="button"
              >
                <span className="min-w-0 flex-1 truncate">{session.label || 'New Chat'}</span>
              </button>

              {session.canDelete ? (
                <Button
                  aria-label={`Remove ${session.label}`}
                  className="mr-1 size-7 p-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
                  disabled={deletingChatId === session.chatId}
                  onClick={() => onDeleteSession(session.chatId)}
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
              ) : null}
            </div>
          )
        })}
      </div>
    </aside>
  )
}
