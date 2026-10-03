import { Injectable } from '@nestjs/common';
import { ConfigDomain, EnvVariable } from '../registry/registry.decorators';
import { IsString, IsNotEmpty, IsOptional, IsInt, Min } from 'class-validator';

/**
 * The RedisConfig factory in EnterpriseConfigModule hydrates `redisUrl` only, so
 * the optional tuning knobs read their env variables here (validated by the same
 * validateConfig pass) instead of relying on class-transformer hydration.
 */
function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

@Injectable()
@ConfigDomain({ owner: 'Redis', feature: 'Configuration', version: '1.1.0', description: 'RedisConfig Domain' })
export class RedisConfig {
  @IsString()
  @IsNotEmpty()
  @EnvVariable('REDIS_URL')
  readonly redisUrl: string;

  /** Max time to establish the TCP connection before it is considered failed (ms). */
  @IsOptional()
  @IsInt()
  @Min(1)
  @EnvVariable('REDIS_CONNECT_TIMEOUT_MS')
  readonly connectTimeoutMs: number = intFromEnv('REDIS_CONNECT_TIMEOUT_MS', 3000);

  /** Max time a single command may wait for a reply before rejecting (ms). */
  @IsOptional()
  @IsInt()
  @Min(1)
  @EnvVariable('REDIS_COMMAND_TIMEOUT_MS')
  readonly commandTimeoutMs: number = intFromEnv('REDIS_COMMAND_TIMEOUT_MS', 2000);

  /**
   * ioredis retries per command while reconnecting. Applies to the app client only;
   * BullMQ builds its own connection in app.module.ts and requires `null` there.
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  @EnvVariable('REDIS_MAX_RETRIES_PER_REQUEST')
  readonly maxRetriesPerRequest: number = intFromEnv('REDIS_MAX_RETRIES_PER_REQUEST', 1);
}
