import type { UIMessage } from 'ai'
import { startTransition, type FormEvent, useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  type ToolCallMessagePartProps
} from '@assistant-ui/react'
import { AssistantChatTransport, useChatRuntime } from '@assistant-ui/react-ai-sdk'

type GatewayBoot = {
  channelId: string
  title: string
  chatPath: string
  ssePath: string
  sessionsPath: string
  requiresToken: boolean
}

type HttpSessionSummary = {
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

type HttpSessionDetail = HttpSessionSummary & {
  messages: UIMessage[]
}

type StoredShellState = {
  activeChatId?: string
  sidebarCollapsed: boolean
}

declare global {
  interface Window {
    __TIA_GATEWAY_BOOT__?: GatewayBoot
  }
}

const boot = window.__TIA_GATEWAY_BOOT__

if (!boot) {
  throw new Error('Missing tia-gateway boot config.')
}

const tokenStorageKey = `tia-gateway:${boot.channelId}:token`
const shellStateStorageKey = `tia-gateway:${boot.channelId}:shell`

function cx(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return typeof error === 'string' ? error : 'Unknown error'
}

function summarizeDetail(detail: HttpSessionDetail): HttpSessionSummary {
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

function readStoredToken(): string {
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

function persistToken(token: string): void {
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

function readStoredShellState(): StoredShellState {
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

function persistShellState(state: StoredShellState): void {
  try {
    window.localStorage.setItem(shellStateStorageKey, JSON.stringify(state))
  } catch {
    // Ignore storage failures and continue with in-memory state.
  }
}

function buildAuthHeaders(token: string | null | undefined): Headers {
  const headers = new Headers()
  if (token?.trim()) {
    headers.set('authorization', `Bearer ${token.trim()}`)
  }
  return headers
}

async function validateToken(token: string): Promise<boolean> {
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

async function loadSessionSummaries(token: string): Promise<HttpSessionSummary[]> {
  const data = await fetchGatewayJson<{ sessions: HttpSessionSummary[] }>(boot.sessionsPath, {
    token
  })
  return data.sessions
}

async function loadSessionDetail(token: string, chatId: string): Promise<HttpSessionDetail> {
  const data = await fetchGatewayJson<{ session: HttpSessionDetail }>(
    `${boot.sessionsPath}/${encodeURIComponent(chatId)}`,
    {
      token
    }
  )
  return data.session
}

async function createGatewaySession(token: string): Promise<HttpSessionSummary> {
  const data = await fetchGatewayJson<{ session: HttpSessionSummary }>(boot.sessionsPath, {
    method: 'POST',
    token
  })
  return data.session
}

async function deleteGatewaySession(token: string, chatId: string): Promise<void> {
  await fetchGatewayJson<void>(`${boot.sessionsPath}/${encodeURIComponent(chatId)}`, {
    method: 'DELETE',
    token
  })
}

function chooseActiveChatId(
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

function formatSessionTime(value: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    }).format(new Date(value))
  } catch {
    return value
  }
}

function formatStructuredValue(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }

  if (value == null) {
    return ''
  }

  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function resolveDisplayedToolName(props: ToolCallMessagePartProps): string {
  if (
    props.toolName === 'acp.acp_provider_agent_dynamic_tool' &&
    isRecord(props.args) &&
    typeof props.args.toolName === 'string'
  ) {
    return props.args.toolName
  }

  return props.toolName
}

function resolveDisplayedToolArgs(props: ToolCallMessagePartProps): unknown {
  if (
    props.toolName === 'acp.acp_provider_agent_dynamic_tool' &&
    isRecord(props.args) &&
    'args' in props.args
  ) {
    return props.args.args
  }

  return props.args
}

const initialToken = readStoredToken()
const initialShellState = readStoredShellState()

function UserMessage(): JSX.Element {
  return (
    <MessagePrimitive.Root className="mb-4 flex justify-end">
      <div className="max-w-[85%] rounded-[24px] bg-primary px-4 py-3 text-sm leading-7 text-primary-foreground shadow-[0_16px_40px_rgba(58,94,182,0.22)] [&_p]:m-0">
        <MessagePrimitive.Parts />
      </div>
    </MessagePrimitive.Root>
  )
}

function GatewayToolPart(props: ToolCallMessagePartProps): JSX.Element {
  const statusLabel =
    props.status.type === 'running'
      ? 'Running'
      : props.status.type === 'requires-action'
        ? 'Needs action'
        : props.isError
          ? 'Failed'
          : props.result !== undefined
            ? 'Done'
            : 'Queued'

  const argsText = formatStructuredValue(resolveDisplayedToolArgs(props))
  const resultText = props.result === undefined ? '' : formatStructuredValue(props.result)

  return (
    <section
      className={cx(
        'rounded-[22px] border bg-secondary/75 p-4 shadow-sm',
        props.isError && 'border-destructive/35 bg-destructive/8'
      )}
    >
      <header className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-muted-foreground">
            Tool
          </p>
          <h3 className="mt-1 text-sm font-semibold text-foreground">
            {resolveDisplayedToolName(props)}
          </h3>
        </div>
        <span className="rounded-full border border-border/80 bg-white/70 px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
          {statusLabel}
        </span>
      </header>

      {argsText ? (
        <div className="mt-4 space-y-2">
          <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
            Input
          </p>
          <pre className="overflow-x-auto rounded-2xl bg-white/80 p-3 text-xs leading-6 text-foreground shell-scrollbar">
            {argsText}
          </pre>
        </div>
      ) : null}

      {resultText ? (
        <div className="mt-4 space-y-2">
          <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
            {props.isError ? 'Error' : 'Output'}
          </p>
          <pre className="overflow-x-auto rounded-2xl bg-white/80 p-3 text-xs leading-6 text-foreground shell-scrollbar">
            {resultText}
          </pre>
        </div>
      ) : null}
    </section>
  )
}

function AssistantMessage(): JSX.Element {
  return (
    <MessagePrimitive.Root className="mb-5 flex justify-start">
      <div className="max-w-[90%] space-y-3">
        <div className="flex items-center gap-2 px-1">
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-white/70 bg-white/75 text-[11px] font-semibold uppercase tracking-[0.2em] text-primary shadow-sm">
            GW
          </span>
          <div>
            <p className="text-sm font-semibold text-foreground">Gateway</p>
            <p className="text-xs text-muted-foreground">ACP workspace session</p>
          </div>
        </div>
        <div className="rounded-[26px] border border-border/70 bg-white/86 px-4 py-3 text-sm leading-7 text-foreground shadow-sm backdrop-blur-md [&_code]:rounded-md [&_code]:bg-secondary/90 [&_code]:px-1.5 [&_code]:py-0.5 [&_p]:m-0 [&_p+p]:mt-3 [&_pre]:overflow-x-auto [&_pre]:rounded-2xl [&_pre]:bg-secondary/70 [&_pre]:p-3">
          <MessagePrimitive.Parts
            components={{
              tools: {
                Fallback: GatewayToolPart
              }
            }}
          />
        </div>
      </div>
    </MessagePrimitive.Root>
  )
}

function AssistantShell(props: {
  token: string
  locked: boolean
  chatId: string
  initialMessages: UIMessage[]
}): JSX.Element {
  const transport = useMemo(() => {
    return new AssistantChatTransport({
      api: boot.chatPath,
      prepareSendMessagesRequest: async (options) => {
        const headers = new Headers(options.headers)
        const authHeaders = buildAuthHeaders(props.token)
        authHeaders.forEach((value, key) => headers.set(key, value))

        const nextBody =
          options.body && typeof options.body === 'object'
            ? {
                ...(options.body as Record<string, unknown>),
                id: props.chatId,
                chatId: props.chatId
              }
            : {
                id: props.chatId,
                chatId: props.chatId
              }

        return {
          headers,
          body: nextBody
        }
      },
      prepareReconnectToStreamRequest: async (options) => {
        const headers = new Headers(options.headers)
        const authHeaders = buildAuthHeaders(props.token)
        authHeaders.forEach((value, key) => headers.set(key, value))

        const api = props.token
          ? `${boot.ssePath}/${encodeURIComponent(props.chatId)}?token=${encodeURIComponent(props.token)}`
          : `${boot.ssePath}/${encodeURIComponent(props.chatId)}`

        return {
          api,
          headers
        }
      }
    })
  }, [props.chatId, props.token])

  const runtime = useChatRuntime({
    resume: !props.locked,
    messages: props.initialMessages,
    transport
  })

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-[28px] bg-white/56">
        <ThreadPrimitive.Root className="flex min-h-0 flex-1 flex-col">
          <ThreadPrimitive.Empty>
            <section className="mx-auto flex max-w-xl flex-col items-center px-6 py-16 text-center">
              <p className="rounded-full border border-border/80 bg-white/70 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.24em] text-muted-foreground">
                assistant-ui + ACP
              </p>
              <h2 className="mt-5 font-serif text-3xl text-foreground sm:text-4xl">
                Start a real ACP workspace conversation.
              </h2>
              <p className="mt-4 text-sm leading-7 text-muted-foreground">
                New sessions open fresh agent context. Existing ACP sessions in the sidebar
                reopen the last transcript stored by this gateway and keep resumable streaming
                enabled.
              </p>
            </section>
          </ThreadPrimitive.Empty>

          <ThreadPrimitive.Viewport
            autoScroll
            className="shell-scrollbar min-h-0 flex-1 overflow-y-auto px-4 pb-6 pt-5 sm:px-6"
          >
            <ThreadPrimitive.Messages
              components={{
                UserMessage,
                AssistantMessage
              }}
            />
          </ThreadPrimitive.Viewport>

          <div className="px-4 pb-3 sm:px-6">
            <ThreadPrimitive.ScrollToBottom className="rounded-full border border-border/80 bg-white/82 px-3 py-2 text-xs font-medium text-muted-foreground shadow-sm transition hover:border-primary/30 hover:text-foreground">
              Jump to latest
            </ThreadPrimitive.ScrollToBottom>
          </div>
        </ThreadPrimitive.Root>

        <ComposerPrimitive.Root className="border-t border-border/70 bg-white/72 p-3 sm:p-4">
          <div className="flex items-end gap-3 rounded-[26px] border border-border/70 bg-white/90 p-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.7)]">
            <ComposerPrimitive.Input
              className="min-h-[56px] flex-1 resize-none bg-transparent px-4 py-3 text-sm leading-7 text-foreground outline-none placeholder:text-muted-foreground/80"
              disabled={props.locked}
              placeholder={
                props.locked
                  ? 'Enter the access token to unlock this gateway.'
                  : 'Ask the agent to inspect, edit, run, or explain work in this session'
              }
              rows={1}
              submitMode="enter"
            />
            <ComposerPrimitive.Send
              className="inline-flex h-12 shrink-0 items-center justify-center rounded-[18px] bg-primary px-4 text-sm font-semibold text-primary-foreground transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={props.locked}
            >
              Send
            </ComposerPrimitive.Send>
          </div>
        </ComposerPrimitive.Root>
      </div>
    </AssistantRuntimeProvider>
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
  const activeSession = sessions.find((session) => session.chatId === activeChatId) ?? sessions[0] ?? null

  useEffect(() => {
    persistShellState({
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
        let nextSessions = await loadSessionSummaries(token)
        if (nextSessions.length === 0) {
          nextSessions = [await createGatewaySession(token)]
        }

        if (cancelled) {
          return
        }

        setSessions(nextSessions)
        setActiveChatId((current) =>
          chooseActiveChatId(
            nextSessions,
            initialShellState.activeChatId,
            current
          )
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
    if (locked || !activeSession) {
      setActiveSessionDetail(null)
      return
    }

    let cancelled = false

    const run = async () => {
      setIsLoadingSessionDetail(true)
      setActiveSessionDetail(null)
      setSessionError('')

      try {
        const detail = await loadSessionDetail(token, activeSession.chatId)
        if (cancelled) {
          return
        }

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
  }, [activeSession, locked, token])

  const handleRefreshSessions = async () => {
    if (locked) {
      setSessionError('Unlock the gateway first to load sessions.')
      return
    }

    setIsLoadingSessions(true)
    setSessionError('')

    try {
      let nextSessions = await loadSessionSummaries(token)
      if (nextSessions.length === 0) {
        nextSessions = [await createGatewaySession(token)]
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
      const created = await createGatewaySession(token)
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
      await deleteGatewaySession(token, chatId)
      const remainingSessions = sessions.filter((session) => session.chatId !== chatId)

      if (remainingSessions.length === 0) {
        const created = await createGatewaySession(token)
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
      const isValid = await validateToken(candidate)
      if (!isValid) {
        setUnlockError('That token was rejected by the gateway.')
        return
      }

      persistToken(candidate)
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
    persistToken('')
    setToken('')
    setDraftToken('')
    setUnlockError('')
    setSessions([])
    setActiveChatId('')
    setActiveSessionDetail(null)
  }

  return (
    <div className="min-h-screen px-4 py-4 sm:px-6 lg:px-8">
      <div className="mx-auto flex min-h-[calc(100vh-2rem)] max-w-[1520px] flex-col gap-4">
        <header className="rounded-[30px] border border-white/70 bg-card/90 px-6 py-5 panel-shadow backdrop-blur-xl sm:px-8">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-muted-foreground">
                tia-gateway
              </p>
              <h1 className="mt-3 font-serif text-3xl text-foreground sm:text-4xl">
                {boot.title}
              </h1>
              <p className="mt-3 max-w-3xl text-sm leading-7 text-muted-foreground">
                The HTTP workbench now talks to ACP agents through AI SDK-compatible transport
                and keeps a single persisted session list for drafts, attached ACP sessions, and
                stored message history.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-border/80 bg-white/72 px-3 py-1.5 text-xs font-medium text-foreground">
                {boot.requiresToken ? 'Token protected' : 'Open local channel'}
              </span>
              <span className="rounded-full border border-border/80 bg-white/72 px-3 py-1.5 text-xs font-medium text-muted-foreground">
                {boot.chatPath}
              </span>
              <span className="rounded-full border border-border/80 bg-white/72 px-3 py-1.5 text-xs font-medium text-muted-foreground">
                {boot.sessionsPath}
              </span>
            </div>
          </div>
        </header>

        {boot.requiresToken ? (
          <section className="rounded-[28px] border border-white/70 bg-card/88 px-5 py-5 panel-shadow backdrop-blur-xl sm:px-6">
            <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
              <div className="max-w-2xl">
                <p className="text-sm font-semibold text-foreground">Access token</p>
                <p className="mt-2 text-sm leading-7 text-muted-foreground">
                  The workbench UI can be shared locally, but chat and session endpoints remain
                  protected. Enter the startup token once and this browser will reuse it.
                </p>
              </div>

              <form className="flex w-full max-w-2xl flex-col gap-3" onSubmit={handleUnlock}>
                <label className="space-y-2">
                  <span className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
                    Gateway token
                  </span>
                  <input
                    autoCapitalize="off"
                    autoComplete="off"
                    autoCorrect="off"
                    className="w-full rounded-[20px] border border-border/80 bg-white/88 px-4 py-3 text-sm text-foreground outline-none ring-0 placeholder:text-muted-foreground/70 focus:border-primary/35"
                    name="token"
                    onChange={(event) => setDraftToken(event.target.value)}
                    placeholder="paste the startup token"
                    spellCheck={false}
                    type="password"
                    value={draftToken}
                  />
                </label>

                <div className="flex flex-wrap items-center gap-3">
                  <button
                    className="inline-flex h-11 items-center justify-center rounded-[18px] bg-primary px-4 text-sm font-semibold text-primary-foreground transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={isUnlocking}
                    type="submit"
                  >
                    {token ? 'Refresh token' : isUnlocking ? 'Checking...' : 'Unlock workbench'}
                  </button>
                  {token ? (
                    <button
                      className="inline-flex h-11 items-center justify-center rounded-[18px] border border-border/80 bg-white/78 px-4 text-sm font-medium text-foreground transition hover:border-primary/30"
                      onClick={handleForgetToken}
                      type="button"
                    >
                      Forget token
                    </button>
                  ) : null}
                </div>

                {unlockError ? (
                  <p className="text-sm text-destructive">{unlockError}</p>
                ) : null}
              </form>
            </div>
          </section>
        ) : null}

        <div className="flex min-h-0 flex-1 flex-col gap-4 lg:flex-row">
          <aside
            className={cx(
              'min-h-0 overflow-hidden rounded-[30px] border border-white/70 bg-card/88 panel-shadow backdrop-blur-xl',
              sidebarCollapsed ? 'hidden' : 'flex',
              'w-full flex-col lg:w-[340px]'
            )}
          >
            <div className="flex items-center justify-between gap-3 border-b border-border/70 px-4 py-4 sm:px-5">
              <div>
                <p className="text-sm font-semibold text-foreground">Sessions</p>
                <p className="text-xs text-muted-foreground">
                  Draft chats and ACP sessions in one list.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  className="inline-flex h-10 items-center justify-center rounded-[16px] border border-border/80 bg-white/76 px-3 text-xs font-medium text-foreground transition hover:border-primary/30 disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={isLoadingSessions || locked}
                  onClick={() => {
                    void handleRefreshSessions()
                  }}
                  type="button"
                >
                  {isLoadingSessions ? 'Refreshing...' : 'Refresh'}
                </button>
                <button
                  className="inline-flex h-10 items-center justify-center rounded-[16px] bg-primary px-3 text-xs font-semibold text-primary-foreground transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={isCreatingSession || locked}
                  onClick={() => {
                    void handleCreateSession()
                  }}
                  type="button"
                >
                  {isCreatingSession ? 'Creating...' : 'New'}
                </button>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3 shell-scrollbar sm:px-4">
              {sessions.length === 0 && !isLoadingSessions ? (
                <div className="rounded-[24px] border border-dashed border-border/80 bg-white/55 px-4 py-5 text-sm leading-7 text-muted-foreground">
                  {locked
                    ? 'Unlock the gateway to load sessions.'
                    : 'No sessions yet. Create one to start a fresh ACP workspace conversation.'}
                </div>
              ) : null}

              <div className="space-y-2">
                {sessions.map((session) => {
                  const isActive = session.chatId === activeSession?.chatId

                  return (
                    <div
                      className={cx(
                        'flex items-stretch gap-2 rounded-[24px] border p-2 transition',
                        isActive
                          ? 'border-primary/30 bg-primary/8 shadow-[0_18px_40px_rgba(58,94,182,0.12)]'
                          : 'border-border/75 bg-white/64 hover:border-primary/20 hover:bg-white/78'
                      )}
                      key={session.chatId}
                    >
                      <button
                        className="flex min-w-0 flex-1 flex-col items-start rounded-[18px] px-3 py-3 text-left"
                        onClick={() => {
                          setActiveChatId(session.chatId)
                          setSessionError('')
                        }}
                        type="button"
                      >
                        <div className="flex w-full items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-semibold text-foreground">
                              {session.label}
                            </p>
                            <p className="mt-1 text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
                              {session.status === 'attached' ? 'ACP session' : 'Draft'}
                            </p>
                          </div>
                          <span className="rounded-full border border-border/80 bg-white/70 px-2 py-1 text-[11px] font-medium text-muted-foreground">
                            {session.messageCount}
                          </span>
                        </div>

                        <div className="mt-3 flex w-full items-center justify-between gap-3 text-xs text-muted-foreground">
                          <span className="truncate">
                            {session.acpSessionId || 'Fresh context'}
                          </span>
                          <span className="shrink-0">{formatSessionTime(session.updatedAt)}</span>
                        </div>

                        {session.cwd ? (
                          <p className="mt-2 w-full truncate text-xs text-muted-foreground/80">
                            {session.cwd}
                          </p>
                        ) : null}
                      </button>

                      {session.canDelete ? (
                        <button
                          aria-label={`Remove ${session.label}`}
                          className="inline-flex w-10 shrink-0 items-center justify-center rounded-[18px] border border-transparent text-lg text-muted-foreground transition hover:border-destructive/30 hover:bg-destructive/8 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-50"
                          disabled={deletingChatId === session.chatId}
                          onClick={() => {
                            void handleDeleteSession(session.chatId)
                          }}
                          type="button"
                        >
                          {deletingChatId === session.chatId ? '...' : 'x'}
                        </button>
                      ) : null}
                    </div>
                  )
                })}
              </div>
            </div>
          </aside>

          <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[32px] border border-white/70 bg-card/90 panel-shadow backdrop-blur-xl">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 px-4 py-4 sm:px-6">
              <div className="flex items-center gap-3">
                <button
                  className="inline-flex h-10 items-center justify-center rounded-[16px] border border-border/80 bg-white/76 px-3 text-xs font-medium text-foreground transition hover:border-primary/30"
                  onClick={() => setSidebarCollapsed((previous) => !previous)}
                  type="button"
                >
                  {sidebarCollapsed ? 'Show sessions' : 'Hide sessions'}
                </button>

                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-muted-foreground">
                    Active session
                  </p>
                  <p className="mt-1 text-base font-semibold text-foreground">
                    {activeSession?.label || 'No session selected'}
                  </p>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {activeSession?.acpSessionId ? (
                  <span className="rounded-full border border-border/80 bg-white/72 px-3 py-1.5 text-xs font-medium text-muted-foreground">
                    {activeSession.acpSessionId}
                  </span>
                ) : null}
                <span className="rounded-full border border-border/80 bg-white/72 px-3 py-1.5 text-xs font-medium text-muted-foreground">
                  {activeSession?.status === 'attached' ? 'Attached' : 'Draft'}
                </span>
              </div>
            </div>

            {sessionError ? (
              <div className="border-b border-destructive/15 bg-destructive/8 px-4 py-3 text-sm text-destructive sm:px-6">
                {sessionError}
              </div>
            ) : null}

            <div className="min-h-0 flex-1 p-3 sm:p-4">
              {locked ? (
                <div className="flex h-full items-center justify-center rounded-[28px] border border-dashed border-border/80 bg-white/45 px-6 text-center text-sm leading-7 text-muted-foreground">
                  Unlock the gateway to load sessions and start chatting.
                </div>
              ) : !activeSession ? (
                <div className="flex h-full items-center justify-center rounded-[28px] border border-dashed border-border/80 bg-white/45 px-6 text-center text-sm leading-7 text-muted-foreground">
                  Create or select a session to open the ACP workbench.
                </div>
              ) : isLoadingSessionDetail || !activeSessionDetail ? (
                <div className="flex h-full items-center justify-center rounded-[28px] border border-dashed border-border/80 bg-white/45 px-6 text-center text-sm leading-7 text-muted-foreground">
                  Loading session history...
                </div>
              ) : (
                <AssistantShell
                  chatId={activeSession.chatId}
                  initialMessages={activeSessionDetail.messages}
                  key={`${activeSession.chatId}:${activeSessionDetail.updatedAt}`}
                  locked={locked}
                  token={token}
                />
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}

const rootElement = document.getElementById('app')

if (!rootElement) {
  throw new Error('Missing #app mount point.')
}

createRoot(rootElement).render(<App />)
