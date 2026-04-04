import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import os from 'node:os'
import test from 'node:test'
import {
  AcpSessionBindingStore,
  buildAcpBindingScope
} from '../src/protocols/acp/session-binding-store.js'

test('AcpSessionBindingStore persists bindings per scope', async () => {
  const tempDir = await mkdtemp(join(os.tmpdir(), 'tia-gateway-bindings-'))
  const filePath = join(tempDir, 'bindings.json')
  const scopeA = buildAcpBindingScope({
    command: 'npx',
    args: ['agent-a'],
    cwd: '/repo/a'
  })
  const scopeB = buildAcpBindingScope({
    command: 'npx',
    args: ['agent-b'],
    cwd: '/repo/b'
  })

  const storeA = new AcpSessionBindingStore(filePath, scopeA)
  await storeA.set('wechat-main:user-1', 'session-abc')

  const storeAReloaded = new AcpSessionBindingStore(filePath, scopeA)
  assert.equal(await storeAReloaded.get('wechat-main:user-1'), 'session-abc')

  const storeB = new AcpSessionBindingStore(filePath, scopeB)
  assert.equal(await storeB.get('wechat-main:user-1'), undefined)

  await storeAReloaded.delete('wechat-main:user-1')
  const storeAAfterDelete = new AcpSessionBindingStore(filePath, scopeA)
  assert.equal(await storeAAfterDelete.get('wechat-main:user-1'), undefined)
})
