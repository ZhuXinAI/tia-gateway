import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { defaultStorageDir } from '../../config-store.js'

type StoredBinding = {
  sessionId: string
  updatedAt: string
}

type StoredSessionBindingFile = {
  version: 1
  scopes?: Record<string, Record<string, StoredBinding>>
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

export function buildAcpBindingScope(input: {
  command: string
  args: string[]
  cwd: string
}): string {
  const digest = createHash('sha256')
    .update(JSON.stringify(input))
    .digest('hex')
  return `acp:${digest}`
}

export function defaultAcpSessionBindingStorePath(): string {
  return join(defaultStorageDir(), 'acp-session-bindings.json')
}

export class AcpSessionBindingStore {
  private loaded = false
  private readonly bindings = new Map<string, string>()

  constructor(
    private readonly filePath: string,
    private readonly scope: string
  ) {}

  async get(sessionKey: string): Promise<string | undefined> {
    await this.ensureLoaded()
    return this.bindings.get(sessionKey)
  }

  async set(sessionKey: string, sessionId: string): Promise<void> {
    await this.ensureLoaded()
    this.bindings.set(sessionKey, sessionId)
    await this.persist()
  }

  async delete(sessionKey: string): Promise<void> {
    await this.ensureLoaded()
    if (!this.bindings.delete(sessionKey)) {
      return
    }

    await this.persist()
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) {
      return
    }

    const data = await readJson<StoredSessionBindingFile>(this.filePath)
    const scopedBindings = data?.scopes?.[this.scope] ?? {}
    for (const [sessionKey, value] of Object.entries(scopedBindings)) {
      if (value?.sessionId) {
        this.bindings.set(sessionKey, value.sessionId)
      }
    }

    this.loaded = true
  }

  private async persist(): Promise<void> {
    const data = (await readJson<StoredSessionBindingFile>(this.filePath)) ?? {
      version: STORE_VERSION
    }

    if (data.version !== STORE_VERSION) {
      data.version = STORE_VERSION
    }

    data.scopes ??= {}
    const scopeEntries: Record<string, StoredBinding> = {}
    const updatedAt = new Date().toISOString()

    for (const [sessionKey, sessionId] of this.bindings.entries()) {
      scopeEntries[sessionKey] = { sessionId, updatedAt }
    }

    data.scopes[this.scope] = scopeEntries
    await writeJson(this.filePath, data)
  }
}
