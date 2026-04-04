import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { promisify } from 'node:util'
import { build } from 'esbuild'

const entryPoint = resolve('src/web/app.tsx')
const jsOutFile = resolve('src/web/app.js')
const cssEntryPoint = resolve('src/web/app.tailwind.css')
const cssOutFile = resolve('src/web/app.css')
const run = promisify(execFile)
const tailwindBin = resolve(
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'tailwindcss.cmd' : 'tailwindcss'
)

await mkdir(dirname(jsOutFile), { recursive: true })

await build({
  entryPoints: [entryPoint],
  outfile: jsOutFile,
  bundle: true,
  format: 'esm',
  minify: true,
  sourcemap: false,
  platform: 'browser',
  target: ['es2022'],
  jsx: 'automatic',
  define: {
    'process.env.NODE_ENV': '"production"'
  }
})

await run(tailwindBin, ['-i', cssEntryPoint, '-o', cssOutFile, '--minify'])
