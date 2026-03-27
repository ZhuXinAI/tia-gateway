export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface Logger {
  readonly level: LogLevel
  child(scope: string): Logger
  debug(message: string, ...args: unknown[]): void
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
}

const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
}

class ConsoleLogger implements Logger {
  constructor(
    public readonly level: LogLevel,
    private readonly scope?: string
  ) {}

  child(scope: string): Logger {
    return new ConsoleLogger(this.level, this.scope ? `${this.scope}:${scope}` : scope)
  }

  debug(message: string, ...args: unknown[]): void {
    this.write('debug', message, ...args)
  }

  info(message: string, ...args: unknown[]): void {
    this.write('info', message, ...args)
  }

  warn(message: string, ...args: unknown[]): void {
    this.write('warn', message, ...args)
  }

  error(message: string, ...args: unknown[]): void {
    this.write('error', message, ...args)
  }

  private write(level: LogLevel, message: string, ...args: unknown[]): void {
    if (LOG_LEVEL_ORDER[level] < LOG_LEVEL_ORDER[this.level]) {
      return
    }

    const timestamp = new Date().toISOString()
    const scope = this.scope ? ` [${this.scope}]` : ''
    const suffix =
      args.filter((value) => value !== undefined).length === 0
        ? ''
        : ` ${args
            .filter((value) => value !== undefined)
            .map((value) => {
              if (value instanceof Error) {
                return value.stack ?? value.message
              }

              if (typeof value === 'string') {
                return value
              }

              try {
                return JSON.stringify(value)
              } catch {
                return String(value)
              }
            })
            .join(' ')}`

    const line = `${timestamp} ${level.toUpperCase()}${scope} ${message}${suffix}`
    if (level === 'error') {
      console.error(line)
      return
    }

    if (level === 'warn') {
      console.warn(line)
      return
    }

    console.log(line)
  }
}

export function createLogger(level: LogLevel = 'info', scope?: string): Logger {
  return new ConsoleLogger(level, scope)
}
