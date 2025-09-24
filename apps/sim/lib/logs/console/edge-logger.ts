/**
 * edge-logger.ts
 *
 * Lightweight logger specifically designed for Edge Runtime environments like middleware.
 * This logger avoids importing heavy dependencies like TraceRoot SDK to keep bundle size small.
 *
 * Also serves as the base logger that can be extended by the full Node.js logger.
 */

import { formatArgs, LogLevel, shouldLog } from './utils'

/**
 * Base logger for Edge Runtime environments and as foundation for Node.js logger
 * Optimized for minimal bundle size and compatibility with Edge Runtime constraints
 */
export class EdgeLogger {
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

    // Simple console logging without colors (safe for all environments)
    const prefix = `[${timestamp}] [${level}] [${this.module}]`

    if (level === LogLevel.ERROR) {
      console.error(prefix, message, ...formattedArgs)
    } else {
      console.log(prefix, message, ...formattedArgs)
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
 * Create a lightweight logger for Edge Runtime
 */
export function createEdgeLogger(module: string): EdgeLogger {
  return new EdgeLogger(module)
}
