import { validateSync } from 'class-validator';
import { hydrateFromEnv } from '../hydrate-from-env';
import { RedisConfig } from './redis.config';

/** Audit R13: REDIS_* tuning is parsed strictly; garbage fails boot instead of silently becoming a default. */
describe('RedisConfig', () => {
  const build = (env: Record<string, string>) => hydrateFromEnv(RedisConfig, { REDIS_URL: 'redis://localhost:6379/1', ...env });

  it('keeps the defaults for unset or blank variables', () => {
    const config = build({ REDIS_COMMAND_TIMEOUT_MS: '  ' });
    expect(validateSync(config)).toEqual([]);
    expect(config).toMatchObject({ redisUrl: 'redis://localhost:6379/1', connectTimeoutMs: 3000, commandTimeoutMs: 2000, maxRetriesPerRequest: 1 });
  });

  it('reads integers, 0 included where the bound allows it', () => {
    const config = build({ REDIS_CONNECT_TIMEOUT_MS: '1500', REDIS_COMMAND_TIMEOUT_MS: '750', REDIS_MAX_RETRIES_PER_REQUEST: '0' });
    expect(validateSync(config)).toEqual([]);
    expect(config).toMatchObject({ connectTimeoutMs: 1500, commandTimeoutMs: 750, maxRetriesPerRequest: 0 });
  });

  it.each([
    ['REDIS_COMMAND_TIMEOUT_MS', '2s'],
    ['REDIS_CONNECT_TIMEOUT_MS', 'abc'],
    ['REDIS_CONNECT_TIMEOUT_MS', '1.5'],
    ['REDIS_COMMAND_TIMEOUT_MS', '0'],
    ['REDIS_MAX_RETRIES_PER_REQUEST', '-1'],
  ])('refuses %s=%s', (variable, value) => {
    expect(validateSync(build({ [variable]: value })).length).toBeGreaterThan(0);
  });

  it('requires REDIS_URL', () => {
    expect(validateSync(hydrateFromEnv(RedisConfig, {})).length).toBeGreaterThan(0);
  });
});
