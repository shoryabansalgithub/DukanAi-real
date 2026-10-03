import { Injectable } from '@nestjs/common';
import { IsNotEmpty, IsString, Matches } from 'class-validator';
import { ConfigDomain, EnvVariable } from '../registry/registry.decorators';
import { StringFromEnv } from '../hydrate-from-env';
import { IsProductionSecret } from '../validation/env-rules';
import { DURATION_PATTERN } from '../../common/time/duration';

const DURATION_MESSAGE = { message: '$property must be an integer with a unit: ms, s, m, h or d (e.g. 15m, 7d)' };

/** The only algorithm tokens are signed with and accepted in (pinned everywhere they are verified). */
export const JWT_ALGORITHM = 'HS256';

/**
 * Access-token signing and session lifetimes. Hydrated with `hydrateFromEnv`;
 * in production the secret must be a real value of at least 32 characters (a
 * committed template placeholder refuses to boot). Refresh tokens are opaque
 * random strings stored hashed, so there is no refresh signing secret.
 *
 * Access tokens are short-lived (`JWT_EXPIRES_IN`, 15 minutes by default) and
 * carry the session family id, which `JwtStrategy` checks, so a logout or a
 * detected token reuse takes effect at once. `JWT_REFRESH_EXPIRES_IN` is the
 * idle lifetime of one refresh token; `SESSION_ABSOLUTE_LIFETIME` caps the
 * whole family from the login, however often it is rotated.
 */
@Injectable()
@ConfigDomain({ owner: 'Jwt', feature: 'Configuration', version: '2.0.0', description: 'JwtConfig Domain' })
export class JwtConfig {
  @IsString()
  @IsNotEmpty()
  @IsProductionSecret()
  @StringFromEnv()
  @EnvVariable('JWT_SECRET')
  readonly jwtSecret: string;

  @IsString()
  @IsNotEmpty()
  @StringFromEnv()
  @EnvVariable('JWT_EXPIRES_IN')
  readonly jwtExpiresIn: string = '15m';

  @IsString()
  @Matches(DURATION_PATTERN, DURATION_MESSAGE)
  @StringFromEnv()
  @EnvVariable('JWT_REFRESH_EXPIRES_IN')
  readonly jwtRefreshExpiresIn: string = '7d';

  @IsString()
  @Matches(DURATION_PATTERN, DURATION_MESSAGE)
  @StringFromEnv()
  @EnvVariable('SESSION_ABSOLUTE_LIFETIME')
  readonly sessionAbsoluteLifetime: string = '30d';
}
