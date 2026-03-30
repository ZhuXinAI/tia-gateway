import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import os from 'node:os'
import type { RawGatewayConfig } from './config.js'

export const DEFAULT_GATEWAY_CONFIG_FILE = 'tia-gateway.config.json'
const DEFAULT_DIRECTORY_REGISTRY_FILE = 'directories.json'

type StoredDirectoryConfigEntry = {
  config?: RawGatewayConfig
  configPath?: string
}

type StoredDirectoryRegistry = {
  directories?: Record<string, StoredDirectoryConfigEntry>
}

export type GatewayConfigSource = {
  kind: 'file' | 'directory-file' | 'directory-inline'
  config: RawGatewayConfig | null
  cwd: string
  configBaseDir: string
  registryPath: string
  configFilePath?: string
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
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

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, JSON.stringify(value, null, 2), 'utf-8')
}

function compactHomePath(value: string): string {
  const homeDir = os.homedir()
  return value === homeDir || value.startsWith(`${homeDir}/`)
    ? `~${value.slice(homeDir.length)}`
    : value
}

export function resolveHomePath(value: string): string {
  return value.startsWith('~/') ? join(os.homedir(), value.slice(2)) : value
}

export function resolveConfigValuePath(baseDir: string, value: string): string {
  const expanded = resolveHomePath(value)
  return isAbsolute(expanded) ? expanded : join(baseDir, expanded)
}

export function defaultStorageDir(): string {
  return join(os.homedir(), '.tia-gateway')
}

export function defaultDirectoryRegistryPath(): string {
  return join(defaultStorageDir(), DEFAULT_DIRECTORY_REGISTRY_FILE)
}

export function resolveExplicitGatewayConfigPath(
  inputFilePath: string,
  cwd = process.cwd()
): string {
  const expanded = resolveHomePath(inputFilePath.trim())
  return isAbsolute(expanded) ? expanded : join(cwd, expanded)
}

export function describeGatewayConfigSource(source: GatewayConfigSource): string {
  if (source.kind === 'directory-inline') {
    return `${compactHomePath(source.registryPath)} (entry for ${source.cwd})`
  }

  return compactHomePath(source.configFilePath ?? source.registryPath)
}

async function readDirectoryRegistry(registryPath: string): Promise<StoredDirectoryRegistry> {
  return (await readJsonFile<StoredDirectoryRegistry>(registryPath)) ?? {}
}

async function writeDirectoryRegistry(
  registryPath: string,
  registry: StoredDirectoryRegistry
): Promise<void> {
  await writeJsonFile(registryPath, registry)
}

async function resolveDirectoryKey(cwd: string): Promise<string> {
  try {
    return await realpath(cwd)
  } catch {
    return cwd
  }
}

export async function rememberGatewayConfigPath(
  filePath: string,
  cwd = process.cwd()
): Promise<void> {
  const registryPath = defaultDirectoryRegistryPath()
  const registry = await readDirectoryRegistry(registryPath)
  const directoryKey = await resolveDirectoryKey(cwd)
  const configFilePath = resolveExplicitGatewayConfigPath(filePath, cwd)

  registry.directories ??= {}
  registry.directories[directoryKey] = { configPath: configFilePath }

  await writeDirectoryRegistry(registryPath, registry)
}

export async function readGatewayConfigSource(input: {
  filePath?: string
  cwd?: string
} = {}): Promise<GatewayConfigSource> {
  const cwd = await resolveDirectoryKey(input.cwd ?? process.cwd())
  const registryPath = defaultDirectoryRegistryPath()

  if (input.filePath) {
    const configFilePath = resolveExplicitGatewayConfigPath(input.filePath, cwd)
    return {
      kind: 'file',
      config: await readJsonFile<RawGatewayConfig>(configFilePath),
      cwd,
      configBaseDir: dirname(configFilePath),
      registryPath,
      configFilePath
    }
  }

  const registry = await readDirectoryRegistry(registryPath)
  const entry = registry.directories?.[cwd]

  if (entry?.configPath) {
    const configFilePath = resolveExplicitGatewayConfigPath(entry.configPath, cwd)
    return {
      kind: 'directory-file',
      config: await readJsonFile<RawGatewayConfig>(configFilePath),
      cwd,
      configBaseDir: dirname(configFilePath),
      registryPath,
      configFilePath
    }
  }

  return {
    kind: 'directory-inline',
    config: entry?.config ?? null,
    cwd,
    configBaseDir: cwd,
    registryPath
  }
}

export async function writeGatewayConfigSource(
  source: GatewayConfigSource,
  config: RawGatewayConfig
): Promise<GatewayConfigSource> {
  if (source.kind === 'file' || source.kind === 'directory-file') {
    if (!source.configFilePath) {
      throw new Error('Missing config file path for file-backed gateway config source.')
    }

    await writeJsonFile(source.configFilePath, config)
    await rememberGatewayConfigPath(source.configFilePath, source.cwd)
    return {
      ...source,
      config
    }
  }

  const registry = await readDirectoryRegistry(source.registryPath)
  registry.directories ??= {}
  registry.directories[source.cwd] = { config }

  await writeDirectoryRegistry(source.registryPath, registry)

  return {
    ...source,
    config
  }
}
