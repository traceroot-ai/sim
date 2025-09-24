/**
 * base-logger.ts
 *
 * Base logger implementation that provides core logging functionality.
 * Can be used in Edge Runtime environments and serves as the foundation for the full Node.js logger.
 * Includes conditional colorization based on environment configuration.
 */

import { formatArgs, getLogConfig, LogLevel, shouldLog } from './utils'

// Conditional chalk import for Edge Runtime compatibility
let chalk: any = null
try {
  if (typeof window === 'undefined' && typeof process !== 'undefined') {
    chalk = require('chalk')
  }
} catch {
  // Fallback to no colorization
}
import { formatArgs, getLogConfig, LogLevel, shouldLog } from './utils'

/**
 * Base logger class that provides core logging functionality
 * Supports both Edge Runtime environments and Node.js environments
 * Includes conditional colorization based on environment configuration
 */
export class BaseLogger {
  protected module: string

  constructor(module: string) {
    this.module = module
  }

  /**
   * Core logging method that can be overridden by extending classes
   */
  protected log(level: LogLevel, message: string, ...args: any[]) {
    if (!shouldLog(level)) return

    const timestamp = new Date().toISOString()
    const formattedArgs = formatArgs(args)
    const config = getLogConfig()

    // Use colorization if enabled in config
    if (config.colorize) {
      let levelColor: typeof chalk.red
      const moduleColor = chalk.cyan
      const timestampColor = chalk.gray

      switch (level) {
        case LogLevel.DEBUG:
          levelColor = chalk.blue
          break
        case LogLevel.INFO:
          levelColor = chalk.green
          break
        case LogLevel.WARN:
          levelColor = chalk.yellow
          break
        case LogLevel.ERROR:
          levelColor = chalk.red
          break
      }

      const coloredPrefix = `${timestampColor(`[${timestamp}]`)} ${levelColor(`[${level}]`)} ${moduleColor(`[${this.module}]`)}`

      if (level === LogLevel.ERROR) {
        console.error(coloredPrefix, message, ...formattedArgs)
      } else {
        console.log(coloredPrefix, message, ...formattedArgs)
      }
    } else {
      // Simple console logging without colors
      const prefix = `[${timestamp}] [${level}] [${this.module}]`

      if (level === LogLevel.ERROR) {
        console.error(prefix, message, ...formattedArgs)
      } else {
        console.log(prefix, message, ...formattedArgs)
      }
    }
  }

  debug(message: string, ...args: any[]) {
    this.log(LogLevel.DEBUG, message, ...args)
  }

  info(message: string, ...args: any[]) {
    this.log(LogLevel.INFO, message, ...args)
  }

  warn(message: string, ...args: any[]) {
    this.log(LogLevel.WARN, message, ...args)
  }

  error(message: string, ...args: any[]) {
    this.log(LogLevel.ERROR, message, ...args)
  }
}

/**
 * Create a base logger instance
 */
export function createBaseLogger(module: string): BaseLogger {
  return new BaseLogger(module)
}
