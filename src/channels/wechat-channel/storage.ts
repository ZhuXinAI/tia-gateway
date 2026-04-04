import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createDefaultRuntimeState } from './utils.js'
import type {
  WechatAccountData,
  WechatQrLoginState,
  WechatRuntimeState
} from './types.js'

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await readFile(filePath, 'utf-8')
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

function accountFilePath(dataDirectoryPath: string): string {
  return join(dataDirectoryPath, 'account.json')
}

function stateFilePath(dataDirectoryPath: string): string {
  return join(dataDirectoryPath, 'state.json')
}

function qrStateFilePath(dataDirectoryPath: string): string {
  return join(dataDirectoryPath, 'qr-login.json')
}

export async function loadWechatAccount(
  dataDirectoryPath: string
): Promise<WechatAccountData | null> {
  return readJsonFile<WechatAccountData>(accountFilePath(dataDirectoryPath))
}

export async function saveWechatAccount(
  dataDirectoryPath: string,
  account: WechatAccountData
): Promise<void> {
  await mkdir(dataDirectoryPath, { recursive: true })
  await writeFile(accountFilePath(dataDirectoryPath), JSON.stringify(account, null, 2), 'utf-8')
}

export async function clearWechatAccount(dataDirectoryPath: string): Promise<void> {
  await unlink(accountFilePath(dataDirectoryPath)).catch(() => undefined)
}

export async function loadWechatRuntimeState(
  dataDirectoryPath: string
): Promise<WechatRuntimeState> {
  return (
    (await readJsonFile<WechatRuntimeState>(stateFilePath(dataDirectoryPath))) ??
    createDefaultRuntimeState()
  )
}

export async function saveWechatRuntimeState(
  dataDirectoryPath: string,
  state: WechatRuntimeState
): Promise<void> {
  await mkdir(dataDirectoryPath, { recursive: true })
  await writeFile(stateFilePath(dataDirectoryPath), JSON.stringify(state, null, 2), 'utf-8')
}

export async function resetWechatRuntimeState(dataDirectoryPath: string): Promise<void> {
  await saveWechatRuntimeState(dataDirectoryPath, createDefaultRuntimeState())
}

export async function loadWechatQrState(
  dataDirectoryPath: string
): Promise<WechatQrLoginState | null> {
  return readJsonFile<WechatQrLoginState>(qrStateFilePath(dataDirectoryPath))
}

export async function saveWechatQrState(
  dataDirectoryPath: string,
  state: WechatQrLoginState
): Promise<void> {
  await mkdir(dataDirectoryPath, { recursive: true })
  await writeFile(qrStateFilePath(dataDirectoryPath), JSON.stringify(state, null, 2), 'utf-8')
}

export async function clearWechatQrState(dataDirectoryPath: string): Promise<void> {
  await unlink(qrStateFilePath(dataDirectoryPath)).catch(() => undefined)
}
