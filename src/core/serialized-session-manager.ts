import type { Logger } from '../logging.js'

type SessionState<TTask> = {
  createdAt: number
  lastActivity: number
  processing: boolean
  queue: TTask[]
}

export type SerializedSessionManagerOptions<TTask> = {
  idleTimeoutMs: number
  maxConcurrentSessions: number
  logger: Logger
  onSessionClosed?: (sessionKey: string) => Promise<void> | void
  worker: (task: TTask) => Promise<void>
}

export class SerializedSessionManager<TTask> {
  private readonly sessions = new Map<string, SessionState<TTask>>()
  private cleanupTimer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly options: SerializedSessionManagerOptions<TTask>) {}

  start(): void {
    if (this.cleanupTimer) {
      return
    }

    this.cleanupTimer = setInterval(() => {
      void this.cleanupIdleSessions()
    }, 2 * 60_000)
    this.cleanupTimer.unref()
  }

  async stop(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }

    const sessionKeys = [...this.sessions.keys()]
    this.sessions.clear()

    for (const sessionKey of sessionKeys) {
      await this.options.onSessionClosed?.(sessionKey)
    }
  }

  async enqueue(sessionKey: string, task: TTask): Promise<void> {
    let session = this.sessions.get(sessionKey)
    if (!session) {
      if (
        this.options.maxConcurrentSessions > 0 &&
        this.sessions.size >= this.options.maxConcurrentSessions
      ) {
        await this.evictOldestIdleSession()
      }

      session = {
        createdAt: Date.now(),
        lastActivity: Date.now(),
        processing: false,
        queue: []
      }
      this.sessions.set(sessionKey, session)
    }

    session.lastActivity = Date.now()
    session.queue.push(task)

    if (!session.processing) {
      session.processing = true
      void this.processQueue(sessionKey, session)
    }
  }

  get activeSessionCount(): number {
    return this.sessions.size
  }

  private async processQueue(sessionKey: string, session: SessionState<TTask>): Promise<void> {
    try {
      while (session.queue.length > 0) {
        const task = session.queue.shift()
        if (!task) {
          continue
        }

        session.lastActivity = Date.now()
        try {
          await this.options.worker(task)
        } catch (error) {
          this.options.logger.error(`Unhandled session worker error for ${sessionKey}`, error)
        }
      }
    } finally {
      session.processing = false
      session.lastActivity = Date.now()
    }
  }

  private async cleanupIdleSessions(): Promise<void> {
    if (this.options.idleTimeoutMs <= 0) {
      return
    }

    const now = Date.now()
    for (const [sessionKey, session] of this.sessions) {
      if (session.processing) {
        continue
      }

      if (now - session.lastActivity <= this.options.idleTimeoutMs) {
        continue
      }

      this.sessions.delete(sessionKey)
      this.options.logger.info(`Closing idle session ${sessionKey}`)
      await this.options.onSessionClosed?.(sessionKey)
    }
  }

  private async evictOldestIdleSession(): Promise<void> {
    let oldestSessionKey: string | null = null
    let oldestActivity = Number.POSITIVE_INFINITY

    for (const [sessionKey, session] of this.sessions) {
      if (session.processing) {
        continue
      }

      if (session.lastActivity < oldestActivity) {
        oldestActivity = session.lastActivity
        oldestSessionKey = sessionKey
      }
    }

    if (!oldestSessionKey) {
      throw new Error(
        'Maximum concurrent sessions reached and no idle session is available to evict.'
      )
    }

    this.sessions.delete(oldestSessionKey)
    this.options.logger.warn(`Evicting idle session ${oldestSessionKey}`)
    await this.options.onSessionClosed?.(oldestSessionKey)
  }
}
