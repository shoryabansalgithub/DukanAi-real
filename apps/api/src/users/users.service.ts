import { Injectable, ConflictException, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Role, Prisma } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { CreateUserDto } from './dto/create-user.dto';
import { SafeUserDto } from './dto/safe-user.dto';
import * as crypto from 'crypto';
import {
  SafeUserRecord,
  UserMapper,
  UserWithPasswordRecord,
  safeUserSelect,
  userWithPasswordSelect,
} from './user.mapper';
import { SecurityConfig } from '../config/domains/security.config';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private prisma: PrismaService,
    private securityConfig: SecurityConfig
  ) {}

  async findByEmailWithPassword(
    email: string,
  ): Promise<UserWithPasswordRecord | null> {
    return this.prisma.user.findUnique({
      where: { email },
      select: userWithPasswordSelect,
    });
  }

  async findSafeById(id: string): Promise<SafeUserDto | null> {
    const user = await this.prisma.user.findUnique({
      where: { id, isDeleted: false },
      select: safeUserSelect,
    });

    return user ? UserMapper.toSafeUserDto(user) : null;
  }

  async findByIdWithSecurity(id: string): Promise<UserWithPasswordRecord | null> {
    return this.prisma.user.findUnique({
      where: { id },
      select: userWithPasswordSelect,
    });
  }

  async create(data: CreateUserDto): Promise<SafeUserDto> {
    const salt = await bcrypt.genSalt(this.securityConfig.bcryptRounds);
    const hashedPassword = await bcrypt.hash(data.password, salt);
    const userId = crypto.randomUUID();
    const shopId = crypto.randomUUID();

    try {
      const user: SafeUserRecord = await this.prisma.$transaction(async (tx) => {
        await tx.shop.create({
          data: {
            id: shopId,
            name: data.shopName,
          },
        });

        const createdUser = await tx.user.create({
          data: {
            id: userId,
            email: data.email,
            name: data.name,
            role: Role.OWNER,
            password: hashedPassword,
            shopId: shopId,
          },
          select: safeUserSelect,
        });

        // A Shop and its owner reference each other. The shop is created
        // owner-less within this transaction, then linked once the user
        // exists. This preserves referential integrity without disabling FKs.
        await tx.shop.update({
          where: { id: shopId },
          data: { ownerId: userId },
        });

        return createdUser;
      });

      return UserMapper.toSafeUserDto(user);
    } catch (error) {
      // Handle unique constraint violation on email
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('A user with this email already exists');
      }
      this.logger.error('Failed to create user', error);
      throw error;
    }
  }

  /**
   * Provision a user from Google OAuth.
   *
   * Resolution order:
   * 1. Existing user matched by googleId → return immediately
   * 2. Existing user matched by email → link googleId and return (account linking)
   * 3. New user → create user + shop in a transaction, role = OWNER
   *
   * Google users have no password set; they authenticate exclusively via OAuth.
   */
  async findOrCreateGoogleUser(
    googleId: string,
    email: string,
    name: string,
  ): Promise<SafeUserDto> {
    // 1. Match by Google ID — returning user
    const byGoogle = await this.prisma.user.findFirst({
      where: { googleId },
      select: safeUserSelect,
    });
    if (byGoogle) return UserMapper.toSafeUserDto(byGoogle);

    // 2. An account with this email that was not created through Google is
    //    never linked automatically: anyone can register a password account
    //    under someone else's address, and linking would hand that account to
    //    whoever later signs in with the real Google identity (P2-19). The
    //    owner signs in with their password; linking needs an explicit,
    //    authenticated step.
    const byEmail = await this.prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (byEmail) {
      this.logger.warn(`Google sign-in refused for ${email}: an account with this email exists and is not linked to Google`);
      throw new ConflictException('An account with this email already exists. Sign in with your password.');
    }

    // 3. New user — create user + shop atomically
    const userId = crypto.randomUUID();
    const shopId = crypto.randomUUID();

    try {
      const user: SafeUserRecord = await this.prisma.$transaction(async (tx) => {
        await tx.shop.create({
          data: {
            id: shopId,
            name: `${name}'s Shop`,
          },
        });

        const createdUser = await tx.user.create({
          data: {
            id: userId,
            email,
            name,
            googleId,
            role: Role.OWNER,
            shopId,
          },
          select: safeUserSelect,
        });

        await tx.shop.update({
          where: { id: shopId },
          data: { ownerId: userId },
        });

        return createdUser;
      });

      this.logger.log(`Created new Google OAuth user ${userId}`);
      return UserMapper.toSafeUserDto(user);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        // Race: another request created the user between our lookups
        const retry = await this.prisma.user.findUnique({
          where: { email },
          select: safeUserSelect,
        });
        if (retry) return UserMapper.toSafeUserDto(retry);
      }
      this.logger.error('Failed to create Google OAuth user', error);
      throw error;
    }
  }

  /**
   * Counts a failed password in one atomic statement (two concurrent failures
   * can no longer read the same value and both write +1), then locks the
   * account once the counter reaches the limit. The lock only blocks new
   * logins for `lockoutDurationMs`; it never touches open sessions.
   */
  async incrementFailedAttempts(userId: string): Promise<void> {
    const { failedAttempts } = await this.prisma.user.update({
      where: { id: userId },
      data: { failedAttempts: { increment: 1 } },
      select: { failedAttempts: true },
    });
    if (failedAttempts >= this.securityConfig.maxLoginAttempts) {
      await this.prisma.user.updateMany({
        where: { id: userId, isLocked: false },
        data: { isLocked: true, lockedUntil: new Date(Date.now() + this.securityConfig.lockoutDurationMs) },
      });
    }
  }

  /**
   * A lock whose `lockedUntil` has passed is over: clear it and the counter so
   * the next failures start a fresh window instead of re-locking on the first
   * one. Returns true when the account is (still) locked.
   */
  async isLockedNow(user: { id: string; isLocked: boolean; lockedUntil: Date | null }, now = new Date()): Promise<boolean> {
    if (!user.isLocked) return false;
    if (user.lockedUntil && user.lockedUntil <= now) {
      await this.resetFailedAttempts(user.id);
      return false;
    }
    return true;
  }

  async resetFailedAttempts(userId: string): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        failedAttempts: 0,
        isLocked: false,
        lockedUntil: null,
      },
    });
  }
}
