import { Injectable } from '@nestjs/common';
import { ConfigDomain, EnvVariable } from '../registry/registry.decorators';
import { IsString, IsNotEmpty, IsInt, Max, Min } from 'class-validator';
import { IntegerFromEnv, StringFromEnv } from '../hydrate-from-env';

/**
 * The Redis endpoint and the tuning of the shared clients. Hydrated with
 * `hydrateFromEnv` (audit R13): an unset or blank variable keeps the
 * default, and anything that is not an integer fails boot. The former
 * `parseInt` fallback read `REDIS_COMMAND_TIMEOUT_MS=2s` as 2 ms and
 * `REDIS_CONNECT_TIMEOUT_MS=abc` silently as the default.
 */
@Injectable()
@ConfigDomain({ owner: 'Redis', feature: 'Configuration', version: '1.2.0', description: 'RedisConfig Domain' })
export class RedisConfig {
  @IsString()
  @IsNotEmpty()
  @StringFromEnv()
  @EnvVariable('REDIS_URL')
  readonly redisUrl: string;

  /** Max time to establish the TCP connection before it is considered failed (ms). */
  @IsInt()
  @Min(1)
  @Max(600_000)
  @IntegerFromEnv()
  @EnvVariable('REDIS_CONNECT_TIMEOUT_MS')
  readonly connectTimeoutMs: number = 3000;

  /** Max time a single command may wait for a reply before rejecting (ms); the cache client uses it too. */
  @IsInt()
  @Min(1)
  @Max(600_000)
  @IntegerFromEnv()
  @EnvVariable('REDIS_COMMAND_TIMEOUT_MS')
  readonly commandTimeoutMs: number = 2000;

  /**
   * ioredis retries per command while reconnecting. Applies to the app client only;
   * BullMQ builds its own connection in app.module.ts and requires `null` there.
   */
  @IsInt()
  @Min(0)
  @Max(100)
  @IntegerFromEnv()
  @EnvVariable('REDIS_MAX_RETRIES_PER_REQUEST')
  readonly maxRetriesPerRequest: number = 1;
}
