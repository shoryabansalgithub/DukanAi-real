import { CanActivate, ExecutionContext, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { SafeUserDto } from '../users/dto/safe-user.dto';
import { ANY_AUTHENTICATED_KEY } from './any-authenticated.decorator';
import { IS_PUBLIC_KEY } from './public.decorator';
import { ROLES_KEY } from './roles.decorator';

interface RequestWithUser {
  method?: string;
  user?: SafeUserDto;
}

/** Methods that only read; they stay open to every authenticated user unless `@Roles` narrows them. */
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Deny by default. A handler that changes state must say who may call it:
 * `@Roles(...)`, `@AnyAuthenticated()` (own-data self-service) or `@Public()`.
 * A write handler with none of them is refused (403) even for an OWNER, and
 * `RouteAuthorizationAssertion` refuses to boot the API in that state, so the
 * guard's fallback is a second line of defence, not the policy.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  private readonly logger = new Logger(RolesGuard.name);

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) {
      return true;
    }

    const requiredRoles = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, targets);
    if (context.getType() !== 'http') {
      // WebSocket / RPC contexts carry no HTTP method; only an explicit role list applies.
      return !requiredRoles?.length || this.hasRole(context, requiredRoles);
    }

    const request = context.switchToHttp().getRequest<RequestWithUser>();
    if (requiredRoles?.length) {
      return Boolean(request.user && requiredRoles.includes(request.user.role));
    }
    if (this.reflector.getAllAndOverride<boolean>(ANY_AUTHENTICATED_KEY, targets)) {
      return Boolean(request.user);
    }
    if (READ_METHODS.has((request.method ?? 'GET').toUpperCase())) {
      return true;
    }

    this.logger.error(
      `${context.getClass().name}.${context.getHandler().name} changes state but declares no @Roles(); refusing the request.`,
    );
    throw new ForbiddenException('This operation has no authorization policy and is disabled.');
  }

  private hasRole(context: ExecutionContext, requiredRoles: Role[]): boolean {
    const user = context.switchToHttp().getRequest<RequestWithUser>()?.user;
    return Boolean(user && requiredRoles.includes(user.role));
  }
}
