import { startTransition, type FormEvent, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MenuIcon, PanelLeftIcon, ShareIcon } from 'lucide-react'
import {
  chooseActiveChatId,
  createGatewaySession,
  deleteGatewaySession,
  loadSessionDetail,
  loadSessionSummaries,
  summarizeDetail,
  toErrorMessage,
  validateToken
} from './gateway-api'
import {
  getShellStorageKey,
  getTokenStorageKey,
  persistShellState,
  persistToken,
  readStoredShellState,
  readStoredToken
} from './gateway-storage'
import { GatewayThread } from './gateway-thread'
import { SessionSidebar } from './session-sidebar'
import { readBootConfig, type HttpSessionDetail, type HttpSessionSummary } from './gateway-types'
import { Button } from './components/ui/button'
import { Sheet, SheetContent, SheetTrigger } from './components/ui/sheet'
import { TooltipProvider } from './components/ui/tooltip'
import { TooltipIconButton } from './components/assistant-ui/tooltip-icon-button'
import { cn } from './lib/utils'

const boot = readBootConfig()
const tokenStorageKey = getTokenStorageKey(boot.channelId)
const shellStateStorageKey = getShellStorageKey(boot.channelId)
const initialToken = readStoredToken(tokenStorageKey)
const initialShellState = readStoredShellState(shellStateStorageKey)

function UnlockPanel(props: {
  draftToken: string
  isUnlocking: boolean
  unlockError: string
  onChangeToken: (token: string) => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
}): JSX.Element {
  return (
    <div className="mx-auto flex h-full w-full max-w-xl items-center px-4">
      <form className="w-full rounded-2xl border bg-background p-4" onSubmit={props.onSubmit}>
        <p className="text-base font-medium text-foreground">Unlock gateway</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Enter the startup token to access chat and sessions.
        </p>

        <label className="mt-3 block space-y-2">
          <span className="text-xs text-muted-foreground">Token</span>
          <input
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-ring"
            name="token"
            onChange={(event) => props.onChangeToken(event.target.value)}
            placeholder="paste token"
            spellCheck={false}
            type="password"
            value={props.draftToken}
          />
        </label>

        <Button className="mt-3" disabled={props.isUnlocking} type="submit">
          {props.isUnlocking ? 'Checking...' : 'Unlock'}
        </Button>

        {props.unlockError ? <p className="mt-2 text-sm text-destructive">{props.unlockError}</p> : null}
      </form>
    </div>
  )
}

function Logo(): JSX.Element {
  return (
    <div className="flex items-center gap-2 px-2 text-sm font-medium">
      <span className="inline-flex size-5 items-center justify-center rounded-sm border bg-muted text-[10px] font-bold">
        TIA
      </span>
      <span className="text-foreground/90">{boot.title}</span>
    </div>
  )
}

function App(): JSX.Element {
  const [token, setToken] = useState(initialToken)
  const [draftToken, setDraftToken] = useState(initialToken)
  const [unlockError, setUnlockError] = useState('')
  const [isUnlocking, setIsUnlocking] = useState(false)

  const [sessions, setSessions] = useState<HttpSessionSummary[]>([])
  const [activeChatId, setActiveChatId] = useState(initialShellState.activeChatId ?? '')
  const [activeSessionDetail, setActiveSessionDetail] = useState<HttpSessionDetail | null>(null)

  const [sidebarCollapsed, setSidebarCollapsed] = useState(initialShellState.sidebarCollapsed)
  const [isLoadingSessions, setIsLoadingSessions] = useState(false)
  const [isLoadingSessionDetail, setIsLoadingSessionDetail] = useState(false)
  const [isCreatingSession, setIsCreatingSession] = useState(false)
  const [deletingChatId, setDeletingChatId] = useState('')
  const [sessionError, setSessionError] = useState('')

  const locked = boot.requiresToken && !token.trim()
  const activeSession = sessions.find((session) => session.chatId === activeChatId) ?? null

  useEffect(() => {
    persistShellState(shellStateStorageKey, {
      activeChatId: activeSession?.chatId,
      sidebarCollapsed
    })
  }, [activeSession, sidebarCollapsed])

  useEffect(() => {
    if (locked) {
      setSessions([])
      setActiveSessionDetail(null)
      setSessionError('')
      return
    }

    let cancelled = false

    const run = async () => {
      setIsLoadingSessions(true)
      setSessionError('')

      try {
        let nextSessions = await loadSessionSummaries(boot, token)
        if (nextSessions.length === 0) {
          nextSessions = [await createGatewaySession(boot, token)]
        }

        if (cancelled) return

        setSessions(nextSessions)
        setActiveChatId((current) =>
          chooseActiveChatId(nextSessions, initialShellState.activeChatId, current)
        )
      } catch (error) {
        if (!cancelled) {
          setSessionError(toErrorMessage(error))
        }
      } finally {
        if (!cancelled) {
          setIsLoadingSessions(false)
        }
      }
    }

    void run()

    return () => {
      cancelled = true
    }
  }, [locked, token])

  useEffect(() => {
    if (locked || !activeChatId) {
      setActiveSessionDetail(null)
      return
    }

    let cancelled = false

    const run = async () => {
      setIsLoadingSessionDetail(true)
      setActiveSessionDetail(null)
      setSessionError('')

      try {
        const detail = await loadSessionDetail(boot, token, activeChatId)
        if (cancelled) return

        setActiveSessionDetail(detail)
        setSessions((previous) =>
          previous.map((session) =>
            session.chatId === detail.chatId ? summarizeDetail(detail) : session
          )
        )
      } catch (error) {
        if (!cancelled) {
          setSessionError(toErrorMessage(error))
        }
      } finally {
        if (!cancelled) {
          setIsLoadingSessionDetail(false)
        }
      }
    }

    void run()

    return () => {
      cancelled = true
    }
  }, [activeChatId, locked, token])

  const handleRefreshSessions = async () => {
    if (locked) {
      setSessionError('Unlock the gateway first to load sessions.')
      return
    }

    setIsLoadingSessions(true)
    setSessionError('')

    try {
      let nextSessions = await loadSessionSummaries(boot, token)
      if (nextSessions.length === 0) {
        nextSessions = [await createGatewaySession(boot, token)]
      }

      setSessions(nextSessions)
      setActiveChatId((current) => chooseActiveChatId(nextSessions, current, current))
    } catch (error) {
      setSessionError(toErrorMessage(error))
    } finally {
      setIsLoadingSessions(false)
    }
  }

  const handleCreateSession = async () => {
    if (locked) {
      setSessionError('Unlock the gateway first to create a session.')
      return
    }

    setIsCreatingSession(true)
    setSessionError('')

    try {
      const created = await createGatewaySession(boot, token)
      setSessions((previous) => [created, ...previous])
      setActiveChatId(created.chatId)
      setActiveSessionDetail({
        ...created,
        messages: []
      })
    } catch (error) {
      setSessionError(toErrorMessage(error))
    } finally {
      setIsCreatingSession(false)
    }
  }

  const handleDeleteSession = async (chatId: string) => {
    if (locked) {
      setSessionError('Unlock the gateway first to remove a draft session.')
      return
    }

    setDeletingChatId(chatId)
    setSessionError('')

    try {
      await deleteGatewaySession(boot, token, chatId)
      const remainingSessions = sessions.filter((session) => session.chatId !== chatId)

      if (remainingSessions.length === 0) {
        const created = await createGatewaySession(boot, token)
        setSessions([created])
        setActiveChatId(created.chatId)
        setActiveSessionDetail({
          ...created,
          messages: []
        })
      } else {
        setSessions(remainingSessions)
        if (activeChatId === chatId) {
          setActiveSessionDetail(null)
          setActiveChatId(remainingSessions[0]!.chatId)
        }
      }
    } catch (error) {
      setSessionError(toErrorMessage(error))
    } finally {
      setDeletingChatId('')
    }
  }

  const handleUnlock = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    const candidate = draftToken.trim()
    if (!candidate) {
      setUnlockError('Enter the access token printed by the gateway startup log.')
      return
    }

    setIsUnlocking(true)
    setUnlockError('')

    try {
      const isValid = await validateToken(boot, candidate)
      if (!isValid) {
        setUnlockError('That token was rejected by the gateway.')
        return
      }

      persistToken(tokenStorageKey, candidate)
      startTransition(() => {
        setToken(candidate)
      })
    } catch {
      setUnlockError('The gateway could not be reached. Check that it is still running.')
    } finally {
      setIsUnlocking(false)
    }
  }

  const handleForgetToken = () => {
    persistToken(tokenStorageKey, '')
    setToken('')
    setDraftToken('')
    setUnlockError('')
    setSessions([])
    setActiveChatId('')
    setActiveSessionDetail(null)
  }

  return (
    <div className="flex h-screen w-full bg-background">
      <div className="hidden md:block">
        <aside
          className={cn(
            'flex h-full flex-col bg-muted/30 transition-all duration-200',
            sidebarCollapsed ? 'w-0 overflow-hidden opacity-0' : 'w-65 opacity-100'
          )}
        >
          <div className="flex h-14 shrink-0 items-center px-4">
            <Logo />
          </div>
          <div className="flex-1 overflow-y-auto p-3">
            <SessionSidebar
              activeChatId={activeSession?.chatId ?? ''}
              collapsed={sidebarCollapsed}
              deletingChatId={deletingChatId}
              isCreatingSession={isCreatingSession}
              isLoadingSessions={isLoadingSessions}
              locked={locked}
              onCreateSession={() => {
                void handleCreateSession()
              }}
              onDeleteSession={(chatId) => {
                void handleDeleteSession(chatId)
              }}
              onRefreshSessions={() => {
                void handleRefreshSessions()
              }}
              onSelectSession={(chatId) => {
                setActiveChatId(chatId)
                setSessionError('')
              }}
              sessions={sessions}
            />
          </div>
        </aside>
      </div>

      <div className="flex flex-1 flex-col overflow-hidden">
        <header className="flex h-14 shrink-0 items-center gap-2 px-4">
          <Sheet>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="size-9 shrink-0 md:hidden">
                <MenuIcon className="size-4" />
                <span className="sr-only">Toggle menu</span>
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-70 p-0">
              <div className="flex h-14 items-center px-4">
                <Logo />
              </div>
              <div className="p-3">
                <SessionSidebar
                  activeChatId={activeSession?.chatId ?? ''}
                  deletingChatId={deletingChatId}
                  isCreatingSession={isCreatingSession}
                  isLoadingSessions={isLoadingSessions}
                  locked={locked}
                  onCreateSession={() => {
                    void handleCreateSession()
                  }}
                  onDeleteSession={(chatId) => {
                    void handleDeleteSession(chatId)
                  }}
                  onRefreshSessions={() => {
                    void handleRefreshSessions()
                  }}
                  onSelectSession={(chatId) => {
                    setActiveChatId(chatId)
                    setSessionError('')
                  }}
                  sessions={sessions}
                />
              </div>
            </SheetContent>
          </Sheet>

          <TooltipIconButton
            variant="ghost"
            size="icon"
            tooltip={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
            side="bottom"
            onClick={() => setSidebarCollapsed((previous) => !previous)}
            className="hidden size-9 md:flex"
          >
            <PanelLeftIcon className="size-4" />
          </TooltipIconButton>

          <Button variant="outline" size="sm" className="h-9">
            tia-gateway
          </Button>

          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-foreground">{activeSession?.label || boot.title}</p>
            <p className="truncate text-xs text-muted-foreground">
              {activeSession
                ? activeSession.status === 'attached'
                  ? 'Attached session'
                  : 'Draft session'
                : 'No active session'}
            </p>
          </div>

          {boot.requiresToken && token ? (
            <Button className="ml-auto" variant="outline" size="sm" onClick={handleForgetToken} type="button">
              Forget token
            </Button>
          ) : (
            <TooltipIconButton variant="ghost" size="icon" tooltip="Share" side="bottom" className="ml-auto size-9">
              <ShareIcon className="size-4" />
            </TooltipIconButton>
          )}
        </header>

        <main className="flex-1 overflow-hidden">
          {sessionError ? (
            <div className="border-b border-destructive/20 bg-destructive/10 px-4 py-2 text-sm text-destructive">
              {sessionError}
            </div>
          ) : null}

          <div className="h-full min-h-0">
            {locked ? (
              <UnlockPanel
                draftToken={draftToken}
                isUnlocking={isUnlocking}
                onChangeToken={setDraftToken}
                onSubmit={handleUnlock}
                unlockError={unlockError}
              />
            ) : !activeSession ? (
              <div className="flex h-full items-center justify-center px-4 text-sm text-muted-foreground">
                Create or select a session to start chatting.
              </div>
            ) : isLoadingSessionDetail || !activeSessionDetail ? (
              <div className="flex h-full items-center justify-center px-4 text-sm text-muted-foreground">
                Loading session history...
              </div>
            ) : (
              <GatewayThread
                boot={boot}
                chatId={activeSession.chatId}
                initialMessages={activeSessionDetail.messages}
                key={`${activeSession.chatId}:${activeSessionDetail.updatedAt}`}
                locked={locked}
                token={token}
              />
            )}
          </div>
        </main>
      </div>
    </div>
  )
}

const rootElement = document.getElementById('app')

if (!rootElement) {
  throw new Error('Missing #app mount point.')
}

createRoot(rootElement).render(
  <TooltipProvider>
    <App />
  </TooltipProvider>
)
