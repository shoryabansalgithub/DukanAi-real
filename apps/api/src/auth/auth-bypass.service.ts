import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import * as crypto from 'crypto';
import { Role, ShopStatus, Prisma } from '@prisma/client';
import { AuthConfig, authBypassPermitted } from '../config/domains/auth.config';
import { PrismaService } from '../prisma/prisma.service';
import { SafeUserDto } from '../users/dto/safe-user.dto';
import { UserMapper, safeUserSelect } from '../users/user.mapper';

export const SYSTEM_USER_EMAIL = 'system@dukaanai.local';
export const SYSTEM_SHOP_NAME = 'System Shop (auth bypass)';

// safeUserSelect plus the shop status TenantGuard reads off req.user.
const systemUserSelect = {
  ...safeUserSelect,
  shop: { select: { status: true } },
} satisfies Prisma.UserSelect;

/**
 * Operator-controlled authentication bypass.
 *
 * When AUTH_DISABLED is explicitly set truthy, JwtAuthGuard skips JWT
 * validation and runs every request as a provisioned system user (role OWNER,
 * with a real shop so tenant isolation and foreign keys keep working).
 *
 * Secure by default: the flag is validated by AuthConfig in the
 * EnterpriseConfigModule and defaults to false. Unset, empty, or unrecognized
 * values keep auth enabled (unrecognized values fail validation and refuse to
 * boot). This is a deployment switch, not an identity decision — it never
 * accepts unverified identity from a request, so it cannot reintroduce an
 * auth-bypass hole. Real auth code, including Google account provisioning,
 * stays intact.
 */
@Injectable()
export class AuthBypassService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AuthBypassService.name);
  private systemUser: SafeUserDto | null = null;

  constructor(
    private readonly authConfig: AuthConfig,
    private readonly prisma: PrismaService,
  ) {}

  /** Decided once at construction: the environment cannot change under a running process. */
  private readonly permittedHere = authBypassPermitted(process.env.NODE_ENV);

  get isEnabled(): boolean {
    return this.authConfig.authDisabled === true && this.permittedHere;
  }

  onApplicationBootstrap(): void {
    if (this.isEnabled) {
      this.logger.warn(
        '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!',
      );
      this.logger.warn(
        `AUTH DISABLED - all requests run as system user ${SYSTEM_USER_EMAIL}.`,
      );
      this.logger.warn(
        'Every endpoint is open without credentials. Never run production traffic with AUTH_DISABLED set.',
      );
      this.logger.warn(
        '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!',
      );
    }
  }

  /**
   * Returns the system user every bypassed request runs as, provisioning a
   * dedicated shop and OWNER user on first use so downstream tenant scoping
   * and foreign keys resolve against real rows.
   */
  async getSystemUser(): Promise<SafeUserDto> {
    if (this.systemUser) {
      return this.systemUser;
    }

    let user = await this.findSystemUser();
    if (!user) {
      try {
        user = await this.provisionSystemUser();
      } catch (error) {
        // A concurrent request may have provisioned it first; the unique
        // email constraint makes the create fail, so re-read before giving up.
        user = await this.findSystemUser();
        if (!user) {
          throw error;
        }
      }
    }

    this.systemUser = user;
    return user;
  }

  private async findSystemUser(): Promise<SafeUserDto | null> {
    const record = await this.prisma.user.findUnique({
      where: { email: SYSTEM_USER_EMAIL },
      select: systemUserSelect,
    });
    return record ? UserMapper.toSafeUserDto(record) : null;
  }

  private async provisionSystemUser(): Promise<SafeUserDto> {
    // Pre-generate both ids so the two rows can reference each other.
    const userId = crypto.randomUUID();
    const shopId = crypto.randomUUID();

    const record = await this.prisma.$transaction(async (tx) => {
      // Shop.ownerId -> User.id and User.shopId -> Shop.id are mutually-required
      // foreign keys, so neither row can be inserted first without transiently
      // violating the other's constraint. Defer FK enforcement for the paired
      // insert; both rows reference each other consistently once committed.
      // Scoped to this pinned-connection interactive transaction.
      await tx.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 0');
      try {
        await tx.shop.create({
          data: {
            id: shopId,
            name: SYSTEM_SHOP_NAME,
            status: ShopStatus.ACTIVE,
            ownerId: userId,
          },
        });
        return await tx.user.create({
          data: {
            id: userId,
            email: SYSTEM_USER_EMAIL,
            name: 'System User',
            role: Role.OWNER,
            shopId,
            // No password: this account can never log in through real auth.
            password: null,
          },
          select: systemUserSelect,
        });
      } finally {
        await tx.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 1');
      }
    });

    this.logger.warn(
      `Provisioned auth-bypass system user ${SYSTEM_USER_EMAIL} in shop "${SYSTEM_SHOP_NAME}".`,
    );
    return UserMapper.toSafeUserDto(record);
  }
}
