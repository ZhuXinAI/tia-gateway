import { access, cp, mkdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'

const sourceDir = resolve('src/web')
const targetDir = resolve('dist/web')
const requiredAssets = ['app.js', 'app.css']

for (const asset of requiredAssets) {
  try {
    await access(resolve(sourceDir, asset))
  } catch {
    throw new Error(
      `Missing ${asset} in src/web. Run "npm run build:web" before "npm run build".`
    )
  }
}

await rm(targetDir, { recursive: true, force: true })
await mkdir(targetDir, { recursive: true })

for (const asset of requiredAssets) {
  await cp(resolve(sourceDir, asset), resolve(targetDir, asset))
}
