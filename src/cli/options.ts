import { Command } from 'commander'
import type { LogLevel } from '../logging.js'

export type StartCommandOptions = {
  config?: string
  agent?: string
  cwd?: string
  showThoughts?: boolean
  logLevel?: LogLevel
}

export type OnboardCommandOptions = {
  config?: string
}

export interface CliHandlers {
  version: string
  onStart(options: StartCommandOptions): Promise<void> | void
  onAgents(): Promise<void> | void
  onOnboard(options: OnboardCommandOptions): Promise<void> | void
}

function addStartOptions(command: Command): Command {
  return command
    .option('-c, --config <file>', 'Path to tia-gateway config JSON')
    .option('--agent <value>', 'ACP preset or raw ACP command override')
    .option('--cwd <dir>', 'Working directory for the ACP agent')
    .option('--show-thoughts', 'Forward ACP thinking messages to the channel')
    .option('--log-level <level>', 'debug | info | warn | error')
}

function readStartOptions(command: Command): StartCommandOptions {
  const options = command.opts<StartCommandOptions>()
  return {
    config: options.config?.trim() || undefined,
    agent: options.agent?.trim() || undefined,
    cwd: options.cwd?.trim() || undefined,
    showThoughts: options.showThoughts,
    logLevel: options.logLevel
  }
}

export function createCliProgram(handlers: CliHandlers): Command {
  const program = addStartOptions(
    new Command()
      .name('tia-gateway')
      .description('Channel-to-agent gateway runtime CLI.')
      .usage('[command] [options]')
      .helpOption('-h, --help', 'Show help')
      .version(handlers.version, '-v, --version', 'Show version')
      .showHelpAfterError()
  )

  program.action(async () => {
    await handlers.onStart(readStartOptions(program))
  })

  const startCommand = addStartOptions(
    program.command('start').description('Start the gateway runtime.')
  )
  startCommand.action(async () => {
    await handlers.onStart(readStartOptions(startCommand))
  })

  program
    .command('agents')
    .description('List built-in ACP agents.')
    .action(async () => {
      await handlers.onAgents()
    })

  const onboardCommand = program
    .command('onboard')
    .description('Run interactive channel onboarding.')
    .helpOption('-h, --help', 'Show help')
    .option('-c, --config <file>', 'Path to tia-gateway config JSON')

  onboardCommand.action(async () => {
    const options = onboardCommand.optsWithGlobals<OnboardCommandOptions>()
    await handlers.onOnboard({
      config: options.config?.trim() || undefined
    })
  })

  return program
}
