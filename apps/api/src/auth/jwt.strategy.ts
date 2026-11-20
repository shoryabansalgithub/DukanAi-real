import { ExtractJwt, Strategy } from 'passport-jwt';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JWT_ALGORITHM, JwtConfig } from '../config/domains/jwt.config';
import { UsersService } from '../users/users.service';
import { SafeUserDto } from '../users/dto/safe-user.dto';
import { UserMapper } from '../users/user.mapper';
import { AccessTokenPayload, AuthService } from './auth.service';

type JwtPayload = Partial<AccessTokenPayload> & Pick<AccessTokenPayload, 'sub' | 'tokenVersion'>;

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private readonly jwtConfig: JwtConfig,
    private readonly usersService: UsersService,
    private readonly authService: AuthService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: jwtConfig.jwtSecret,
      algorithms: [JWT_ALGORITHM],
    });
  }

  async validate(payload: JwtPayload): Promise<SafeUserDto & { sessionId: string }> {
    // Every access token names its session family; one without is not ours.
    if (typeof payload.sid !== 'string' || payload.sid === '') {
      throw new UnauthorizedException('Token carries no session');
    }
    const user = await this.usersService.findByIdWithSecurity(payload.sub);
    if (!user) {
      throw new UnauthorizedException('User no longer exists');
    }

    if (user.isDeleted) {
      throw new UnauthorizedException('Account has been deleted');
    }

    if (user.tokenVersion !== payload.tokenVersion) {
      throw new UnauthorizedException('Session has been revoked');
    }

    if (!user.isActive) {
      throw new UnauthorizedException('Account has been deactivated');
    }

    // A brute-force lock blocks new logins only (AuthService.validateUser);
    // sessions that were open before it stay valid, otherwise anyone who
    // knows an email address could log every device of that user out (P1-4).
    // Suspension (isActive) and revocation (tokenVersion) are checked above.

    // Logout, an explicit revoke, refresh-token reuse and the absolute session
    // lifetime all end the family; the access token ends with it.
    if (!(await this.authService.isSessionActive(user.id, payload.sid))) {
      throw new UnauthorizedException('Session has ended');
    }

    return Object.assign(UserMapper.toSafeUserDto(user as any), { sessionId: payload.sid });
  }
}
