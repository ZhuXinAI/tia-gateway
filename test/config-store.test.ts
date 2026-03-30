import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import os from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  readGatewayConfigSource,
  writeGatewayConfigSource
} from '../src/config-store.js'

test('writeGatewayConfigSource tracks explicit config files for the current directory', async () => {
  const tempHome = await mkdtemp(join(os.tmpdir(), 'tia-gateway-store-home-'))
  const projectDir = join(tempHome, 'project')
  const previousHome = process.env.HOME

  process.env.HOME = tempHome

  try {
    await mkdir(projectDir, { recursive: true })
    const directoryKey = await realpath(projectDir)

    const fileSource = await readGatewayConfigSource({
      filePath: './configs/custom.json',
      cwd: projectDir
    })

    await writeGatewayConfigSource(fileSource, {
      channels: [
        {
          type: 'telegram',
          botToken: 'tracked-token'
        }
      ]
    })

    const registryPath = join(tempHome, '.tia-gateway', 'directories.json')
    const registry = JSON.parse(await readFile(registryPath, 'utf-8')) as {
      directories: Record<string, { configPath?: string }>
    }

    assert.equal(
      registry.directories[directoryKey]?.configPath,
      join(directoryKey, 'configs', 'custom.json')
    )

    const trackedSource = await readGatewayConfigSource({ cwd: projectDir })
    assert.equal(trackedSource.kind, 'directory-file')
    assert.equal(trackedSource.config?.channels?.[0]?.type, 'telegram')
    assert.equal(trackedSource.config?.channels?.[0]?.botToken, 'tracked-token')
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME
    } else {
      process.env.HOME = previousHome
    }

    await rm(tempHome, { recursive: true, force: true })
  }
})
