import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../common/email/email.service';
import { AppConfig } from '../config/domains/app.config';
import { SecurityConfig } from '../config/domains/security.config';
import { isProductionEnv } from '../config/validation/env-rules';
import { SocketSessionService } from '../iam/websockets/socket-session.service';

export const PASSWORD_RESET_TTL_MINUTES = 60;

/** The one answer `forgot-password` gives, so an address cannot be probed. */
export const FORGOT_PASSWORD_MESSAGE = 'If an account exists for that email, a reset link has been sent.';

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Forgot-password flow (roadmap 6.7). The raw token reaches the user only by
 * email, the row stores its SHA-256, a token is single-use and expires after
 * an hour, and a new request voids the user's earlier unused tokens. A
 * successful reset ends every session of the account (tokenVersion bump,
 * refresh tokens revoked, sockets dropped) and clears a login lock.
 */
@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger(PasswordResetService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly appConfig: AppConfig,
    private readonly securityConfig: SecurityConfig,
    private readonly socketSessions: SocketSessionService,
  ) {}

  async request(rawEmail: string): Promise<{ message: string }> {
    if (!this.email.isConfigured && isProductionEnv()) {
      // The same rule as invitations: a production server must be able to deliver the link.
      throw new ServiceUnavailableException('Password reset email delivery is not configured (SMTP_URL)');
    }
    const email = rawEmail.trim().toLowerCase();
    // User is a global model (read before any tenant is known).
    const user = await this.prisma.user.findFirst({
      where: { email, isDeleted: false, isActive: true },
      select: { id: true, name: true, password: true },
    });
    // No password: a Google-only account signs in with Google; a reset would turn it into a password account (roadmap 2.9 forbids the link).
    if (!user || !user.password) {
      this.logger.log(`Password reset requested for an address without a resettable account`);
      return { message: FORGOT_PASSWORD_MESSAGE };
    }

    const rawToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MINUTES * 60_000);
    await this.prisma.$transaction(async (tx) => {
      await tx.passwordResetToken.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: new Date() } });
      await tx.passwordResetToken.create({ data: { userId: user.id, tokenHash: hashToken(rawToken), expiresAt } });
    });

    const origin = this.appConfig.frontendUrl.split(',')[0].trim();
    const link = `${origin}/reset-password?token=${rawToken}`;
    try {
      await this.email.send({
        purpose: 'password_reset',
        to: email,
        subject: 'Reset your DukaanAI password',
        text: [
          `Hi ${user.name},`,
          '',
          'Someone asked to reset the password of your DukaanAI account. If that was you, open this link within the next hour:',
          link,
          '',
          `If you did not ask for this, ignore this email; your password stays as it is.`,
        ].join('\n'),
      });
    } catch {
      // The answer stays the neutral one: a 500 here would say "this address
      // has an account" (unknown addresses never reach the relay). The link
      // that was not delivered is voided, and the failure is logged and
      // counted by EmailService (email_messages_total{outcome="failed"}).
      await this.prisma.passwordResetToken
        .updateMany({ where: { userId: user.id, tokenHash: hashToken(rawToken), usedAt: null }, data: { usedAt: new Date() } })
        .catch((err: unknown) => this.logger.error(`Undelivered reset token of user ${user.id} could not be voided: ${err instanceof Error ? err.message : String(err)}`));
      this.logger.error(`Password reset link for user ${user.id} was not delivered; the user was given the neutral answer`);
      return { message: FORGOT_PASSWORD_MESSAGE };
    }
    this.logger.log(`Password reset link sent to user ${user.id}`);
    return { message: FORGOT_PASSWORD_MESSAGE };
  }

  async reset(rawToken: string, password: string): Promise<{ message: string }> {
    const now = new Date();
    const row = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash: hashToken(rawToken.toLowerCase()) },
      select: { id: true, userId: true, expiresAt: true, usedAt: true, user: { select: { email: true, isDeleted: true, isActive: true } } },
    });
    if (!row || row.usedAt || row.expiresAt <= now || row.user.isDeleted || !row.user.isActive) {
      throw new BadRequestException({ message: 'This reset link is invalid or has expired. Request a new one.', code: 'PASSWORD_RESET_INVALID' });
    }

    const salt = await bcrypt.genSalt(this.securityConfig.bcryptRounds);
    const hashed = await bcrypt.hash(password, salt);
    await this.prisma.$transaction(async (tx) => {
      // Single use: the conditional update loses the race to a concurrent reset with the same link.
      const claimed = await tx.passwordResetToken.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: now } });
      if (claimed.count !== 1) {
        throw new BadRequestException({ message: 'This reset link has already been used.', code: 'PASSWORD_RESET_INVALID' });
      }
      await tx.user.update({
        where: { id: row.userId },
        data: { password: hashed, tokenVersion: { increment: 1 }, isLocked: false, lockedUntil: null, failedAttempts: 0 },
      });
      await tx.refreshToken.updateMany({ where: { userId: row.userId, isRevoked: false }, data: { isRevoked: true } });
    });
    this.socketSessions.disconnectUser(row.userId, 'Password changed');
    this.logger.log(`Password reset completed for user ${row.userId}`);
    await this.notifyPasswordChanged(row.user.email, 'the reset link');
    return { message: 'Your password has been changed. Sign in with the new password.' };
  }

  /**
   * `POST /auth/change-password` (ASVS 2.1.5, roadmap 9.15): the signed-in
   * user proves the current password and sets a new one under the policy.
   * Like a reset it ends every session of the account (tokenVersion bump,
   * refresh tokens revoked, sockets dropped), so the caller signs in again;
   * a notification goes to the account's address (ASVS 2.2.3).
   */
  async change(userId: string, currentPassword: string, newPassword: string): Promise<{ message: string }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, password: true, isDeleted: true, isActive: true },
    });
    if (!user || user.isDeleted || !user.isActive) {
      throw new BadRequestException({ message: 'This account cannot change its password.', code: 'PASSWORD_CHANGE_UNAVAILABLE' });
    }
    if (!user.password) {
      // A Google-only account has no password to prove or replace.
      throw new BadRequestException({ message: 'This account signs in with Google and has no password.', code: 'PASSWORD_NOT_SET' });
    }
    if (!(await bcrypt.compare(currentPassword, user.password))) {
      this.logger.warn(`Password change refused for user ${userId}: current password incorrect`);
      throw new BadRequestException({ message: 'The current password is incorrect.', code: 'PASSWORD_CURRENT_INVALID' });
    }
    if (await bcrypt.compare(newPassword, user.password)) {
      throw new BadRequestException({ message: 'The new password must differ from the current one.', code: 'PASSWORD_UNCHANGED' });
    }

    const salt = await bcrypt.genSalt(this.securityConfig.bcryptRounds);
    const hashed = await bcrypt.hash(newPassword, salt);
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: { password: hashed, tokenVersion: { increment: 1 }, isLocked: false, lockedUntil: null, failedAttempts: 0 },
      });
      await tx.refreshToken.updateMany({ where: { userId: user.id, isRevoked: false }, data: { isRevoked: true } });
    });
    this.socketSessions.disconnectUser(user.id, 'Password changed');
    this.logger.log(`Password changed by user ${user.id}; every session ended`);
    await this.notifyPasswordChanged(user.email, 'the account settings');
    return { message: 'Your password has been changed. Sign in again with the new password.' };
  }

  /** ASVS 2.2.3: the account learns of a credential change by email; a delivery problem never undoes the change. */
  private async notifyPasswordChanged(email: string, how: string): Promise<void> {
    try {
      await this.email.send({
        purpose: 'password_changed',
        to: email,
        subject: 'Your DukaanAI password was changed',
        text: [
          `The password of your DukaanAI account was changed just now through ${how}, and every signed-in session was ended.`,
          '',
          'If this was you, sign in again with the new password.',
          'If it was not you, use "Forgot password" on the sign-in page at once and contact the shop owner.',
        ].join('\n'),
      });
    } catch (err) {
      this.logger.warn(`Password change notification to ${email} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
