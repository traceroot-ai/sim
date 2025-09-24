import { beforeEach, describe, expect, test, vi } from 'vitest'

vi.unmock('@/lib/logs/console/base-logger')

import { BaseLogger, createBaseLogger } from '@/lib/logs/console/base-logger'

describe('BaseLogger', () => {
  let logger: BaseLogger

  beforeEach(() => {
    logger = new BaseLogger('TestModule')
  })

  describe('class instantiation', () => {
    test('should create base logger instance', () => {
      expect(logger).toBeDefined()
      expect(logger).toBeInstanceOf(BaseLogger)
    })
  })

  describe('createBaseLogger factory function', () => {
    test('should create base logger instance', () => {
      const factoryLogger = createBaseLogger('FactoryModule')
      expect(factoryLogger).toBeDefined()
      expect(factoryLogger).toBeInstanceOf(BaseLogger)
    })
  })

  describe('logging methods', () => {
    test('should have debug method', () => {
      expect(typeof logger.debug).toBe('function')
    })

    test('should have info method', () => {
      expect(typeof logger.info).toBe('function')
    })

    test('should have warn method', () => {
      expect(typeof logger.warn).toBe('function')
    })

    test('should have error method', () => {
      expect(typeof logger.error).toBe('function')
    })
  })
})
