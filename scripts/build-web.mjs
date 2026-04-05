import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const pnpmBin = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'

await run(pnpmBin, ['--filter', '@tia-gateway/web-shell', 'run', 'build'])
