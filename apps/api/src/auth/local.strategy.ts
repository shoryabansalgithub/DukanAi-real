import { Strategy } from 'passport-local';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { SafeUserDto } from '../users/dto/safe-user.dto';
import { CorrelatedRequest } from '../common/middleware/correlation-id.middleware';

@Injectable()
export class LocalStrategy extends PassportStrategy(Strategy) {
  constructor(private authService: AuthService) {
    // The request reaches the credential check so its log lines name the
    // client address and the correlation id of the access line (roadmap 9.22).
    super({ usernameField: 'email', passReqToCallback: true });
  }

  async validate(req: CorrelatedRequest, email: string, pass: string): Promise<SafeUserDto> {
    const user = await this.authService.validateUser(email, pass, { ip: req.ip, correlationId: req.correlationId });
    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }
    return user;
  }
}
