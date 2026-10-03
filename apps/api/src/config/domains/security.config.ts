import { Injectable } from '@nestjs/common';
import { IsInt, Max, Min } from 'class-validator';
import { ConfigDomain, EnvVariable } from '../registry/registry.decorators';
import { IntegerFromEnv } from '../hydrate-from-env';

/**
 * Password hashing, login lockout and rate-limit windows. Hydrated with
 * `hydrateFromEnv`: an unset or blank variable keeps the default, a value that
 * is not an integer or is out of bounds fails boot.
 *
 * Every window is in MILLISECONDS, the unit `@nestjs/throttler` v6 counts in,
 * and the variables carry the `_MS` suffix for that reason (the older
 * `RATE_LIMIT_*_TTL` keys held seconds and produced 10 ms windows; they are no
 * longer read). A window under one second is refused outright: it is the same
 * misconfiguration and would leave the limiter effectively off.
 *
 * The three general throttlers apply per client IP to every route; the
 * `AUTH_RATE_LIMIT_*` limits replace them on the routes marked with
 * `@AuthThrottle()` (login, register, refresh, Google sign-in, invitation
 * accept) over the same windows, plus a per-account limit keyed by the
 * submitted email so a distributed brute force is capped too. See
 * `src/common/throttling`.
 */
@Injectable()
@ConfigDomain({ owner: 'Security', feature: 'Configuration', version: '2.0.0', description: 'SecurityConfig Domain' })
export class SecurityConfig {
  /** bcrypt cost factor; 4..31 is the range the algorithm accepts. */
  @IsInt()
  @Min(4)
  @Max(31)
  @IntegerFromEnv()
  @EnvVariable('BCRYPT_ROUNDS')
  bcryptRounds: number = 10;

  @IsInt()
  @Min(1000)
  @IntegerFromEnv()
  @EnvVariable('RATE_LIMIT_SHORT_TTL_MS')
  rateLimitShortTtlMs: number = 10_000;

  @IsInt()
  @Min(1)
  @IntegerFromEnv()
  @EnvVariable('RATE_LIMIT_SHORT_LIMIT')
  rateLimitShortLimit: number = 20;

  @IsInt()
  @Min(1000)
  @IntegerFromEnv()
  @EnvVariable('RATE_LIMIT_MEDIUM_TTL_MS')
  rateLimitMediumTtlMs: number = 60_000;

  @IsInt()
  @Min(1)
  @IntegerFromEnv()
  @EnvVariable('RATE_LIMIT_MEDIUM_LIMIT')
  rateLimitMediumLimit: number = 100;

  @IsInt()
  @Min(1000)
  @IntegerFromEnv()
  @EnvVariable('RATE_LIMIT_LONG_TTL_MS')
  rateLimitLongTtlMs: number = 3_600_000;

  @IsInt()
  @Min(1)
  @IntegerFromEnv()
  @EnvVariable('RATE_LIMIT_LONG_LIMIT')
  rateLimitLongLimit: number = 1000;

  @IsInt()
  @Min(1)
  @IntegerFromEnv()
  @EnvVariable('AUTH_RATE_LIMIT_SHORT_LIMIT')
  authRateLimitShortLimit: number = 5;

  @IsInt()
  @Min(1)
  @IntegerFromEnv()
  @EnvVariable('AUTH_RATE_LIMIT_MEDIUM_LIMIT')
  authRateLimitMediumLimit: number = 20;

  @IsInt()
  @Min(1)
  @IntegerFromEnv()
  @EnvVariable('AUTH_RATE_LIMIT_LONG_LIMIT')
  authRateLimitLongLimit: number = 100;

  /** Login attempts per account (any address) over the medium window before 429. */
  @IsInt()
  @Min(1)
  @IntegerFromEnv()
  @EnvVariable('AUTH_RATE_LIMIT_ACCOUNT_LIMIT')
  authRateLimitAccountLimit: number = 10;

  @IsInt()
  @Min(1)
  @IntegerFromEnv()
  @EnvVariable('SECURITY_MAX_LOGIN_ATTEMPTS')
  maxLoginAttempts: number = 5;

  @IsInt()
  @Min(0)
  @IntegerFromEnv()
  @EnvVariable('SECURITY_LOCKOUT_DURATION_MS')
  lockoutDurationMs: number = 900_000;
}
