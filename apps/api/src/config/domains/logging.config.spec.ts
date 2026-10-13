import 'reflect-metadata';
import { validateSync } from 'class-validator';
import { hydrateFromEnv } from '../hydrate-from-env';
import { LoggingConfig, LOG_LEVELS, logLevelsUpTo } from './logging.config';

describe('LoggingConfig (roadmap 7.6)', () => {
  const nodeEnv = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = nodeEnv;
  });

  it('expands a threshold into the levels Nest should print', () => {
    expect(logLevelsUpTo('log')).toEqual(['fatal', 'error', 'warn', 'log']);
    expect(logLevelsUpTo('error')).toEqual(['fatal', 'error']);
    expect(logLevelsUpTo('verbose')).toEqual([...LOG_LEVELS]);
  });

  it('defaults to debug outside production and reads LOG_LEVEL', () => {
    process.env.NODE_ENV = 'development';
    const byDefault = hydrateFromEnv(LoggingConfig, {});
    expect(byDefault.logLevel).toBe('debug');
    expect(validateSync(byDefault)).toEqual([]);

    const warn = hydrateFromEnv(LoggingConfig, { LOG_LEVEL: 'warn' });
    expect(warn.levels).toEqual(['fatal', 'error', 'warn']);
    expect(validateSync(warn)).toEqual([]);

    expect(hydrateFromEnv(LoggingConfig, { LOG_LEVEL: '  ' }).logLevel).toBe('debug');
  });

  it('rejects an unknown level', () => {
    const errors = validateSync(hydrateFromEnv(LoggingConfig, { LOG_LEVEL: 'chatty' }));
    expect(errors.map((e) => e.property)).toEqual(['logLevel']);
  });

  it('defaults to log in production and refuses debug or verbose there', () => {
    process.env.NODE_ENV = 'production';
    const byDefault = hydrateFromEnv(LoggingConfig, {});
    expect(byDefault.logLevel).toBe('log');
    expect(validateSync(byDefault)).toEqual([]);
    expect(validateSync(hydrateFromEnv(LoggingConfig, { LOG_LEVEL: 'error' }))).toEqual([]);

    for (const level of ['debug', 'verbose']) {
      const errors = validateSync(hydrateFromEnv(LoggingConfig, { LOG_LEVEL: level }));
      expect(errors).toHaveLength(1);
      expect(Object.values(errors[0].constraints ?? {}).join(' ')).toMatch(/production prints at most the "log" level/);
    }
  });
});
