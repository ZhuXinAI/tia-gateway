import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { UIMessage } from 'ai'

type StoredHttpSessionFile = {
  version: 1
  sessions?: StoredHttpSessionRecord[]
}

export type StoredHttpSessionRecord = {
  chatId: string
  label: string
  createdAt: string
  updatedAt: string
  acpSessionId?: string
  cwd?: string
  messages: UIMessage[]
}

const STORE_VERSION = 1 as const

function isEnoent(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await readFile(filePath, 'utf-8')
    return JSON.parse(raw) as T
  } catch (error) {
    if (isEnoent(error)) {
      return null
    }

    throw error
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, JSON.stringify(value, null, 2), 'utf-8')
}

function ensureChatId(value: string | undefined): string {
  const trimmed = value?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : `chat-${randomUUID()}`
}

function ensureSessionRecord(
  value: Partial<StoredHttpSessionRecord> & Pick<StoredHttpSessionRecord, 'chatId'>
): StoredHttpSessionRecord {
  const now = new Date().toISOString()

  return {
    chatId: ensureChatId(value.chatId),
    label: value.label?.trim() || 'New session',
    createdAt: value.createdAt?.trim() || now,
    updatedAt: value.updatedAt?.trim() || value.createdAt?.trim() || now,
    acpSessionId: value.acpSessionId?.trim() || undefined,
    cwd: value.cwd?.trim() || undefined,
    messages: Array.isArray(value.messages) ? value.messages : []
  }
}

export class HttpSessionStore {
  private loaded = false
  private readonly sessions = new Map<string, StoredHttpSessionRecord>()

  constructor(private readonly filePath: string) {}

  async list(): Promise<StoredHttpSessionRecord[]> {
    await this.ensureLoaded()
    return [...this.sessions.values()].sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt)
    )
  }

  async get(chatId: string): Promise<StoredHttpSessionRecord | undefined> {
    await this.ensureLoaded()
    return this.sessions.get(chatId)
  }

  async getByAcpSessionId(sessionId: string): Promise<StoredHttpSessionRecord | undefined> {
    await this.ensureLoaded()
    const normalizedSessionId = sessionId.trim()

    for (const session of this.sessions.values()) {
      if (session.acpSessionId === normalizedSessionId) {
        return session
      }
    }

    return undefined
  }

  async create(input: {
    chatId?: string
    label?: string
    acpSessionId?: string
    cwd?: string
    messages?: UIMessage[]
  } = {}): Promise<StoredHttpSessionRecord> {
    await this.ensureLoaded()

    const record = ensureSessionRecord({
      chatId: input.chatId ?? `chat-${randomUUID()}`,
      label: input.label,
      acpSessionId: input.acpSessionId,
      cwd: input.cwd,
      messages: input.messages
    })

    this.sessions.set(record.chatId, record)
    await this.persist()
    return record
  }

  async upsert(record: StoredHttpSessionRecord): Promise<StoredHttpSessionRecord> {
    await this.ensureLoaded()
    const normalized = ensureSessionRecord(record)
    this.sessions.set(normalized.chatId, normalized)
    await this.persist()
    return normalized
  }

  async update(
    chatId: string,
    patch: Partial<Omit<StoredHttpSessionRecord, 'chatId' | 'createdAt'>>
  ): Promise<StoredHttpSessionRecord | undefined> {
    await this.ensureLoaded()
    const existing = this.sessions.get(chatId)
    if (!existing) {
      return undefined
    }

    const next = ensureSessionRecord({
      ...existing,
      ...patch,
      chatId,
      createdAt: existing.createdAt,
      updatedAt: patch.updatedAt ?? new Date().toISOString()
    })

    this.sessions.set(chatId, next)
    await this.persist()
    return next
  }

  async delete(chatId: string): Promise<boolean> {
    await this.ensureLoaded()
    const deleted = this.sessions.delete(chatId)
    if (!deleted) {
      return false
    }

    await this.persist()
    return true
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) {
      return
    }

    const data = await readJson<StoredHttpSessionFile>(this.filePath)
    for (const record of data?.sessions ?? []) {
      if (!record?.chatId) {
        continue
      }

      const normalized = ensureSessionRecord(record)
      this.sessions.set(normalized.chatId, normalized)
    }

    this.loaded = true
  }

  private async persist(): Promise<void> {
    await writeJson(this.filePath, {
      version: STORE_VERSION,
      sessions: [...this.sessions.values()]
    } satisfies StoredHttpSessionFile)
  }
}
