import assert from 'node:assert/strict'
import test from 'node:test'
import { createCliProgram } from '../src/cli/options.js'

async function runCli(argv: string[]): Promise<Array<Record<string, unknown>>> {
  const calls: Array<Record<string, unknown>> = []
  const program = createCliProgram({
    version: '0.2.0',
    onStart: (options) => {
      calls.push({ command: 'start', ...options })
    },
    onAgents: () => {
      calls.push({ command: 'agents' })
    },
    onOnboard: (options) => {
      calls.push({ command: 'onboard', ...options })
    }
  })

  await program.parseAsync(['node', 'tia-gateway', ...argv], { from: 'node' })
  return calls
}

test('CLI defaults to start when no subcommand is provided', async () => {
  const calls = await runCli(['--agent', 'codex', '--show-thoughts'])

  assert.deepEqual(calls, [
    {
      command: 'start',
      agent: 'codex',
      config: undefined,
      cwd: undefined,
      showThoughts: true,
      logLevel: undefined
    }
  ])
})

test('CLI parses onboard command options', async () => {
  const calls = await runCli(['onboard', '--config', './custom.json'])

  assert.deepEqual(calls, [
    {
      command: 'onboard',
      config: './custom.json'
    }
  ])
})

test('CLI help keeps the -h flag on root and start commands', () => {
  const program = createCliProgram({
    version: '0.2.0',
    onStart: () => undefined,
    onAgents: () => undefined,
    onOnboard: () => undefined
  })
  const startCommand = program.commands.find((command) => command.name() === 'start')

  assert.match(program.helpInformation(), /-h, --help/)
  assert.match(startCommand?.helpInformation() ?? '', /-h, --help/)
})
