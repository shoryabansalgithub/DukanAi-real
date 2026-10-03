import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../../auth/public.decorator';
import { IS_SKIP_TENANT_KEY } from '../decorators/skip-tenant.decorator';
import { SafeUserDto } from '../../users/dto/safe-user.dto';
import { ShopStatus } from '@prisma/client';

interface RequestWithUser {
  user?: SafeUserDto;
}

/** Why a request for a shop in this state is refused (roadmap 1.8: only ACTIVE shops pass). */
const STATUS_MESSAGES: Record<Exclude<ShopStatus, 'ACTIVE'>, string> = {
  SUSPENDED: 'This shop is suspended. Contact support to reactivate it.',
  LOCKED: 'This shop has been locked for security reasons.',
  ARCHIVED: 'This shop has been archived.',
  DELETED: 'This shop has been deleted.',
};

/**
 * Global guard that enforces tenant isolation by rejecting authenticated
 * requests where the user has no shop assignment (shopId = null) or whose
 * shop is not ACTIVE.
 *
 * Execution order (via APP_GUARD registration):
 *   ThrottlerGuard → JwtAuthGuard → TenantGuard → RolesGuard
 *
 * Bypassed when:
 *   - Route is marked @Public() (unauthenticated routes)
 *   - Route is marked @SkipTenantCheck() (super-admin/system routes)
 */
@Injectable()
export class TenantGuard implements CanActivate {
  private readonly logger = new Logger(TenantGuard.name);

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // Skip for public routes (no user present)
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    // Skip for routes that intentionally operate without tenant context
    const isSkipTenant = this.reflector.getAllAndOverride<boolean>(
      IS_SKIP_TENANT_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (isSkipTenant) {
      return true;
    }

    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const user = request.user;

    // If JwtAuthGuard already rejected (no user), let it handle the 401.
    // TenantGuard only fires after successful JWT validation.
    if (!user) {
      return true;
    }

    if (!user.shopId) {
      this.logger.warn(
        `Tenant guard rejected user ${user.id} (${user.email}) — no shop assignment`,
      );
      throw new ForbiddenException(
        'Your account is not assigned to any shop. Contact your administrator.',
      );
    }

    if (user.shopStatus !== ShopStatus.ACTIVE) {
      // Unknown status (user loaded without its shop) fails closed as well.
      const message = user.shopStatus ? STATUS_MESSAGES[user.shopStatus] : 'The status of your shop could not be verified.';
      this.logger.warn(`Tenant guard rejected user ${user.id} (${user.email}) — shop ${user.shopId} is ${user.shopStatus ?? 'unknown'}`);
      throw new ForbiddenException(message);
    }

    return true;
  }
}
