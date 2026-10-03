import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { UsersService } from '../users/users.service';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { SafeUserDto } from '../users/dto/safe-user.dto';
import { PrismaService } from '../prisma/prisma.service';
import * as crypto from 'crypto';
import { SocketSessionService } from '../iam/websockets/socket-session.service';
import { JwtConfig } from '../config/domains/jwt.config';
import { durationToMs } from '../common/time/duration';
import { ListQueryDto, pageArgs } from '../common/pagination';

export interface LoginResponseDto {
  access_token: string;
  refresh_token: string;
  user: SafeUserDto;
}

/** Claims of an access token; `sid` is the session family the token belongs to. */
export interface AccessTokenPayload {
  sub: string;
  email: string;
  role: string;
  shopId: string;
  tokenVersion: number;
  sid: string;
}

/** `RefreshToken.userAgent` / `ipAddress` are VARCHAR(191); browsers send longer User-Agent strings. */
export const SESSION_TEXT_LIMIT = 191;

const hashToken = (token: string): string => crypto.createHash('sha256').update(token).digest('hex');

/**
 * Sessions are refresh-token families. A login opens a family (its id is the
 * first token's id) and issues an access token carrying that id as `sid`.
 * Every refresh rotates: the presented token is consumed and a successor is
 * written in the same family, atomically, so the family always has exactly
 * one live token. Presenting a consumed token again means two parties hold
 * the family (the token leaked): the family is revoked and the user's
 * tokenVersion bumped, which ends every session. A family also ends when its
 * absolute lifetime passes or on logout, and access tokens die with it because
 * `JwtStrategy` checks the family on every request.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private usersService: UsersService,
    private jwtService: JwtService,
    private prisma: PrismaService,
    private socketSessionService: SocketSessionService,
    private jwtConfig: JwtConfig,
  ) {}

  async validateUser(email: string, pass: string): Promise<SafeUserDto | null> {
    const user = await this.usersService.findByEmailWithPassword(email);
    // Google OAuth users have no password — they cannot use credentials login.
    if (!user || !user.password) {
      return null;
    }

    if (user.isDeleted) {
      return null;
    }

    if (!user.isActive) {
      return null;
    }

    if (await this.usersService.isLockedNow(user)) {
      return null;
    }

    const passwordValid = await bcrypt.compare(pass, user.password);
    if (!passwordValid) {
      await this.usersService.incrementFailedAttempts(user.id);
      return null;
    }

    await this.usersService.resetFailedAttempts(user.id);
    return this.usersService.findSafeById(user.id);
  }

  /** Opens a new session family for `user` and issues its first token pair. */
  async login(user: SafeUserDto, ipAddress?: string, userAgent?: string): Promise<LoginResponseDto> {
    const now = new Date();
    const familyId = crypto.randomUUID();
    const absoluteExpiresAt = new Date(now.getTime() + durationToMs(this.jwtConfig.sessionAbsoluteLifetime));
    const refreshToken = await this.prisma.$transaction((tx) =>
      this.issueRefreshToken(tx, { userId: user.id, familyId, absoluteExpiresAt, ipAddress, userAgent, now }),
    );
    return { access_token: this.signAccessToken(user, familyId), refresh_token: refreshToken, user };
  }

  /**
   * Rotates a refresh token: consumes it and issues a successor in the same
   * family. The consume step is a conditional update on `isRevoked = false`;
   * when it matches no row the token was already consumed or revoked, and a
   * token that was consumed by rotation is treated as reuse.
   */
  async refresh(refreshToken: string, ipAddress?: string, userAgent?: string): Promise<LoginResponseDto> {
    const now = new Date();
    const session = await this.prisma.refreshToken.findUnique({ where: { token: hashToken(refreshToken) } });
    if (!session) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }
    if (session.rotatedAt) {
      await this.onTokenReuse(session.userId, session.familyId);
      throw new UnauthorizedException('Refresh token reuse detected; all sessions have been revoked');
    }
    if (session.isRevoked || session.expiresAt <= now || session.absoluteExpiresAt <= now) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    const user = await this.usersService.findSafeById(session.userId);
    if (!user || !user.isActive) {
      throw new UnauthorizedException('User inactive or deleted');
    }

    const successor = await this.prisma.$transaction(async (tx) => {
      const consumed = await tx.refreshToken.updateMany({
        where: { id: session.id, isRevoked: false, rotatedAt: null },
        data: { isRevoked: true, rotatedAt: now },
      });
      if (consumed.count !== 1) return null; // lost a race with another presenter of the same token
      return this.issueRefreshToken(tx, {
        userId: user.id,
        familyId: session.familyId,
        absoluteExpiresAt: session.absoluteExpiresAt,
        ipAddress,
        userAgent,
        now,
      });
    });
    if (successor === null) {
      await this.onTokenReuse(session.userId, session.familyId);
      throw new UnauthorizedException('Refresh token reuse detected; all sessions have been revoked');
    }

    return { access_token: this.signAccessToken(user, session.familyId), refresh_token: successor, user };
  }

  /** Ends the session family the access token belongs to; its refresh token and access tokens stop working at once. */
  async logout(userId: string, familyId: string): Promise<{ message: string }> {
    await this.prisma.refreshToken.updateMany({ where: { userId, familyId, isRevoked: false }, data: { isRevoked: true } });
    return { message: 'Logged out' };
  }

  /** True while the family still has a live (unrevoked, unexpired) token: the check behind every access token. */
  async isSessionActive(userId: string, familyId: string, now = new Date()): Promise<boolean> {
    const live = await this.prisma.refreshToken.findFirst({
      where: { userId, familyId, isRevoked: false, expiresAt: { gt: now }, absoluteExpiresAt: { gt: now } },
      select: { id: true },
    });
    return live !== null;
  }

  /** One row per live session family, for the sessions page. */
  async getSessions(userId: string, query?: ListQueryDto) {
    const now = new Date();
    const { skip, take } = pageArgs(query);
    const where = { userId, isRevoked: false, expiresAt: { gt: now }, absoluteExpiresAt: { gt: now } };
    const [items, total] = await Promise.all([
      this.prisma.refreshToken.findMany({
        where,
        select: { id: true, familyId: true, ipAddress: true, userAgent: true, createdAt: true, expiresAt: true, absoluteExpiresAt: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip,
        take,
      }),
      this.prisma.refreshToken.count({ where }),
    ]);
    return { items, total, skip, take };
  }

  /** Revokes the whole family the given token belongs to (a session, not just its current token). */
  async revokeSession(sessionId: string, userId: string) {
    const token = await this.prisma.refreshToken.findFirst({ where: { id: sessionId, userId }, select: { familyId: true } });
    if (token) {
      await this.prisma.refreshToken.updateMany({ where: { userId, familyId: token.familyId, isRevoked: false }, data: { isRevoked: true } });
    }
    // Disconnect sockets when a session is explicitly revoked
    this.socketSessionService.disconnectUser(userId, 'Session revoked');
    return { message: 'Session revoked' };
  }

  private signAccessToken(user: SafeUserDto, familyId: string): string {
    const payload: AccessTokenPayload = { email: user.email, sub: user.id, role: user.role, shopId: user.shopId, tokenVersion: user.tokenVersion, sid: familyId };
    return this.jwtService.sign(payload);
  }

  private async issueRefreshToken(
    tx: Pick<PrismaService, 'refreshToken'>,
    input: { userId: string; familyId: string; absoluteExpiresAt: Date; ipAddress?: string; userAgent?: string; now: Date },
  ): Promise<string> {
    const refreshToken = crypto.randomBytes(40).toString('hex');
    const idleExpiresAt = new Date(input.now.getTime() + durationToMs(this.jwtConfig.jwtRefreshExpiresIn));
    await tx.refreshToken.create({
      data: {
        token: hashToken(refreshToken),
        userId: input.userId,
        familyId: input.familyId,
        expiresAt: idleExpiresAt < input.absoluteExpiresAt ? idleExpiresAt : input.absoluteExpiresAt,
        absoluteExpiresAt: input.absoluteExpiresAt,
        ipAddress: input.ipAddress?.slice(0, SESSION_TEXT_LIMIT),
        userAgent: input.userAgent?.slice(0, SESSION_TEXT_LIMIT),
      },
    });
    return refreshToken;
  }

  /**
   * A consumed token came back: the family leaked, and whoever holds it may
   * have had the account for a while. Sign the user out everywhere: every
   * live refresh token (all families) is revoked and tokenVersion is bumped,
   * so no access token minted before this moment is accepted either.
   */
  private async onTokenReuse(userId: string, familyId: string): Promise<void> {
    this.logger.warn(`Refresh token reuse detected for user ${userId} (family ${familyId}); revoking all sessions`);
    await this.prisma.$transaction([
      this.prisma.refreshToken.updateMany({ where: { userId, isRevoked: false }, data: { isRevoked: true } }),
      this.prisma.user.update({ where: { id: userId }, data: { tokenVersion: { increment: 1 } } }),
    ]);
    this.socketSessionService.disconnectUser(userId, 'Session revoked after refresh token reuse');
  }
}
