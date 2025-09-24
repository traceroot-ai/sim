/**
 * logger.ts
 *
 * Enhanced logger that extends EdgeLogger with Node.js-specific features.
 * Adds TraceRoot integration and colorization for server-side logging.
 *
 * For Edge Runtime (middleware), use edge-logger.ts directly to avoid bundle size issues.
 * For other code that might run in browser/SSR, this logger will gracefully degrade.
 */
import { EdgeLogger } from './edge-logger'
import { formatArgs, getLogConfig, LogLevel } from './utils'

// Conditional imports that are safe to fail
let chalk: any = null
let traceRootLogger: any = null

try {
  // Only import chalk in Node.js environments
  if (typeof window === 'undefined' && typeof process !== 'undefined') {
    chalk = require('chalk')
  }
} catch {
  // Chalk not available or in browser, will use plain console logging
}

try {
  // Only import TraceRoot in Node.js environments
  if (typeof window === 'undefined' && typeof process !== 'undefined') {
    const traceRoot = require('traceroot-sdk-ts')
    traceRootLogger = traceRoot.getLogger
  }
} catch {
  // TraceRoot SDK not available, will fall back to console logging
}

// Re-export LogLevel for backward compatibility
export { LogLevel }

/**
 * Enhanced logger class that extends EdgeLogger with Node.js-specific features
 *
 * This class adds colorization and TraceRoot integration while maintaining
 * compatibility with Edge Runtime and browser environments.
 */
export class Logger extends EdgeLogger {
  private traceRootLoggerInstance: any = null

  /**
   * Create a new logger for a specific module
   * @param module The name of the module (e.g., 'OpenAIProvider', 'AgentBlockHandler')
   */
  constructor(module: string) {
    super(module)

    // Initialize TraceRoot logger instance if available (Node.js only)
    if (traceRootLogger) {
      try {
        this.traceRootLoggerInstance = traceRootLogger(module)
      } catch (error) {
        console.warn(
          `Failed to create TraceRoot logger for module ${module}, falling back to console logging`
        )
      }
    }
  }

  /**
   * Enhanced logging method with TraceRoot integration and colorization
   * Overrides the base EdgeLogger method to add Node.js-specific features
   *
   * @param level The severity level of the log
   * @param message The main log message
   * @param args Additional arguments to log
   */
  protected log(level: LogLevel, message: string, ...args: any[]) {
    // Use TraceRoot if available (Node.js only)
    if (this.traceRootLoggerInstance) {
      switch (level) {
        case LogLevel.DEBUG:
          this.traceRootLoggerInstance.debug(message, ...args)
          return
        case LogLevel.INFO:
          this.traceRootLoggerInstance.info(message, ...args)
          return
        case LogLevel.WARN:
          this.traceRootLoggerInstance.warn(message, ...args)
          return
        case LogLevel.ERROR:
          this.traceRootLoggerInstance.error(message, ...args)
          return
      }
    }

    // Enhanced console logging with colors (if chalk available)
    if (chalk) {
      const timestamp = new Date().toISOString()
      const formattedArgs = formatArgs(args)
      const config = getLogConfig()

      if (config.colorize) {
        let levelColor
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
        return
      }
    }

    // Fallback to base EdgeLogger behavior (no colors, safe for all environments)
    super.log(level, message, ...args)
  }

  /**
   * Log a debug message
   *
   * Use for detailed information useful during development and debugging.
   * These logs are only shown in development environment.
   *
   * Examples:
   * - Variable values during execution
   * - Function entry/exit points
   * - Detailed request/response data
   *
   * @param message The message to log
   * @param args Additional arguments to log
   */
  debug(message: string, ...args: any[]) {
    if (this.traceRootLoggerInstance) {
      this.traceRootLoggerInstance.debug(message, ...args)
    } else {
      this.log(LogLevel.DEBUG, message, ...args)
    }
  }

  /**
   * Log an info message
   *
   * Use for general information about application operation.
   * These logs are shown in both development and production environments.
   *
   * Examples:
   * - Application startup/shutdown
   * - Configuration information
   * - Successful operations
   *
   * @param message The message to log
   * @param args Additional arguments to log
   */
  info(message: string, ...args: any[]) {
    if (this.traceRootLoggerInstance) {
      this.traceRootLoggerInstance.info(message, ...args)
    } else {
      this.log(LogLevel.INFO, message, ...args)
    }
  }

  /**
   * Log a warning message
   *
   * Use for potentially problematic situations that don't cause operation failure.
   *
   * Examples:
   * - Deprecated feature usage
   * - Suboptimal configurations
   * - Recoverable errors
   *
   * @param message The message to log
   * @param args Additional arguments to log
   */
  warn(message: string, ...args: any[]) {
    if (this.traceRootLoggerInstance) {
      this.traceRootLoggerInstance.warn(message, ...args)
    } else {
      this.log(LogLevel.WARN, message, ...args)
    }
  }

  /**
   * Log an error message
   *
   * Use for error events that might still allow the application to continue.
   *
   * Examples:
   * - API call failures
   * - Operation failures
   * - Unexpected exceptions
   *
   * @param message The message to log
   * @param args Additional arguments to log
   */
  error(message: string, ...args: any[]) {
    if (this.traceRootLoggerInstance) {
      this.traceRootLoggerInstance.error(message, ...args)
    } else {
      this.log(LogLevel.ERROR, message, ...args)
    }
  }
}

/**
 * Create a logger for a specific module
 *
 * Usage example:
 * ```
 * import { createLogger } from '@/lib/logger'
 *
 * const logger = createLogger('MyComponent')
 *
 * logger.debug('Initializing component', { props })
 * logger.info('Component mounted')
 * logger.warn('Deprecated prop used', { propName })
 * logger.error('Failed to fetch data', error)
 * ```
 *
 * @param module The name of the module (e.g., 'OpenAIProvider', 'AgentBlockHandler')
 * @returns A Logger instance
 */
export function createLogger(module: string): Logger {
  return new Logger(module)
}
