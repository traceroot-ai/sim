/**
 * utils.ts
 *
 * Shared logging utilities for both Node.js and Edge runtime loggers.
 * This file contains no external dependencies to keep it lightweight.
 */

/**
 * LogLevel enum defines the severity levels for logging
 *
 * DEBUG: Detailed information, typically useful only for diagnosing problems
 *        These logs are only shown in development environment
 *
 * INFO: Confirmation that things are working as expected
 *       These logs are shown in both development and production environments
 *
 * WARN: Indication that something unexpected happened, or may happen in the near future
 *       The application can still continue working as expected
 *
 * ERROR: Error events that might still allow the application to continue running
 *        These should be investigated and fixed
 */
export enum LogLevel {
  DEBUG = 'DEBUG',
  INFO = 'INFO',
  WARN = 'WARN',
  ERROR = 'ERROR',
}

/**
 * Get the minimum log level from environment variable or use defaults
 * - Development: DEBUG (show all logs)
 * - Production: ERROR (only show errors, but can be overridden by LOG_LEVEL env var)
 * - Test: ERROR (only show errors in tests)
 */
export const getMinLogLevel = (): LogLevel => {
  const logLevel = process.env.LOG_LEVEL
  if (logLevel) {
    return logLevel as LogLevel
  }

  const nodeEnv = process.env.NODE_ENV || 'development'
  switch (nodeEnv) {
    case 'development':
      return LogLevel.DEBUG
    case 'production':
      return LogLevel.ERROR
    case 'test':
      return LogLevel.ERROR
    default:
      return LogLevel.DEBUG
  }
}

/**
 * Configuration for different environments
 */
export interface LogConfig {
  enabled: boolean
  minLevel: LogLevel
  colorize: boolean
}

/**
 * Get logging configuration for the current environment
 */
export const getLogConfig = (): LogConfig => {
  const nodeEnv = process.env.NODE_ENV || 'development'

  const config = {
    development: {
      enabled: true,
      minLevel: getMinLogLevel(),
      colorize: true,
    },
    production: {
      enabled: true,
      minLevel: getMinLogLevel(),
      colorize: false,
    },
    test: {
      enabled: false,
      minLevel: getMinLogLevel(),
      colorize: false,
    },
  }

  return config[nodeEnv as keyof typeof config] || config.development
}

/**
 * Determines if a log at the given level should be displayed
 * based on the current environment configuration
 */
export const shouldLog = (level: LogLevel): boolean => {
  const config = getLogConfig()

  if (!config.enabled) return false

  // In production, only log on server-side (where window is undefined)
  if (process.env.NODE_ENV === 'production' && typeof window !== 'undefined') {
    return false
  }

  const levels = [LogLevel.DEBUG, LogLevel.INFO, LogLevel.WARN, LogLevel.ERROR]
  const minLevelIndex = levels.indexOf(config.minLevel)
  const currentLevelIndex = levels.indexOf(level)

  return currentLevelIndex >= minLevelIndex
}

/**
 * Format objects for logging, converting objects to JSON strings
 */
export const formatObject = (obj: any): string => {
  try {
    if (obj instanceof Error) {
      return JSON.stringify(
        {
          message: obj.message,
          stack: process.env.NODE_ENV === 'development' ? obj.stack : undefined,
          ...(obj as any),
        },
        null,
        process.env.NODE_ENV === 'development' ? 2 : 0
      )
    }
    return JSON.stringify(obj, null, process.env.NODE_ENV === 'development' ? 2 : 0)
  } catch (_error) {
    return '[Circular or Non-Serializable Object]'
  }
}

/**
 * Format arguments for logging, converting objects to JSON strings
 */
export const formatArgs = (args: any[]): any[] => {
  return args.map((arg) => {
    if (arg === null || arg === undefined) return arg
    if (typeof arg === 'object') return formatObject(arg)
    return arg
  })
}
