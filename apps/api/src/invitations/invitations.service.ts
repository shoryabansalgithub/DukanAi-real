import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Role } from '@prisma/client';
import { CreateInvitationDto } from './dto/create-invitation.dto';
import { AcceptInvitationDto } from './dto/accept-invitation.dto';
import * as crypto from 'crypto';
import * as bcrypt from 'bcrypt';
import { SafeUserDto } from '../users/dto/safe-user.dto';
import { UserMapper, safeUserSelect } from '../users/user.mapper';
import { ADMIN_ROLES, outranks } from '../auth/role-sets';
import { EmailService } from '../common/email/email.service';
import { AppConfig } from '../config/domains/app.config';
import { isProductionEnv } from '../config/validation/env-rules';

/** Who is acting: the caller's id and role, as JwtStrategy put them on the request. */
export interface Actor {
  id: string;
  role: Role;
}

export const INVITATION_TTL_HOURS = 48;
export const MAX_ACTIVE_INVITATIONS_PER_SHOP = 50;

/**
 * Staff invitations (roadmap 2.8, audit P1-8). The invited role must rank
 * strictly below the inviter's, the inviter is recorded, and the token only
 * ever travels by email to the invitee: the API response carries no token, so
 * an inviter cannot accept their own invitation into a higher role. A MANAGER
 * may revoke only invitations they issued; ADMIN and above revoke any.
 */
@Injectable()
export class InvitationsService {
  private readonly logger = new Logger(InvitationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly appConfig: AppConfig,
  ) {}

  async generate(shopId: string, inviter: Actor, data: CreateInvitationDto) {
    if (data.role === Role.SUPER_ADMIN || data.role === Role.OWNER) {
      throw new BadRequestException('Cannot invite users as OWNER or SUPER_ADMIN');
    }
    if (!outranks(inviter.role, data.role)) {
      throw new ForbiddenException(`A ${inviter.role} can only invite roles below their own; ${data.role} is not`);
    }
    if (!this.email.isConfigured && isProductionEnv()) {
      // The token must reach the invitee by email; without a transport there is no safe way to hand it over.
      throw new ServiceUnavailableException('Invitation email delivery is not configured (SMTP_URL)');
    }

    const email = data.email.trim().toLowerCase();
    const now = new Date();
    const activeInvitationsCount = await this.prisma.invitation.count({
      where: { shopId, isUsed: false, expiresAt: { gt: now } },
    });
    if (activeInvitationsCount >= MAX_ACTIVE_INVITATIONS_PER_SHOP) {
      throw new BadRequestException('Maximum active invitations limit reached for this shop');
    }

    const existingUser = await this.prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (existingUser) {
      throw new ConflictException('User with this email already exists.');
    }

    const existingInvite = await this.prisma.invitation.findFirst({
      where: { email, shopId, isUsed: false, expiresAt: { gt: now } },
      select: { id: true },
    });
    if (existingInvite) {
      throw new ConflictException('An active invitation already exists for this email.');
    }

    const rawToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(now.getTime() + INVITATION_TTL_HOURS * 3_600_000);
    const [shop, invitation] = await this.prisma.$transaction(async (tx) => {
      const shopRow = await tx.shop.findUniqueOrThrow({ where: { id: shopId }, select: { name: true } });
      const row = await tx.invitation.create({
        data: { email, role: data.role, shopId, inviterId: inviter.id, token: hashToken(rawToken), expiresAt },
        select: { id: true, expiresAt: true },
      });
      return [shopRow, row] as const;
    });

    await this.email.send({
      to: email,
      subject: `You're invited to ${shop.name} on DukaanAI`,
      text: this.invitationText(shop.name, data.role, rawToken, expiresAt),
    });
    this.logger.log(`Invitation ${invitation.id} for ${data.role} sent to ${email} by ${inviter.id}`);

    return { message: 'Invitation sent', invitationId: invitation.id, email, role: data.role, expiresAt: invitation.expiresAt };
  }

  async revoke(shopId: string, actor: Actor, id: string) {
    const invite = await this.prisma.invitation.findUnique({ where: { id }, select: { shopId: true, isUsed: true, inviterId: true } });
    if (!invite || invite.shopId !== shopId) throw new NotFoundException('Invitation not found');
    if (invite.isUsed) throw new BadRequestException('Cannot revoke a used invitation');
    if (!ADMIN_ROLES.includes(actor.role) && invite.inviterId !== actor.id) {
      throw new ForbiddenException('You can only revoke invitations you issued');
    }

    await this.prisma.invitation.delete({ where: { id } });
    return { message: 'Invitation revoked successfully' };
  }

  async accept(data: AcceptInvitationDto): Promise<SafeUserDto> {
    const invitation = await this.prisma.invitation.findUnique({ where: { token: hashToken(data.token) } });

    if (!invitation) {
      throw new NotFoundException('Invalid or expired invitation token');
    }
    if (invitation.isUsed) {
      throw new BadRequestException('This invitation has already been used');
    }
    if (new Date() > invitation.expiresAt) {
      throw new BadRequestException('This invitation has expired');
    }

    const salt = await bcrypt.genSalt();
    const hashedPassword = await bcrypt.hash(data.password, salt);
    const userId = crypto.randomUUID();

    try {
      const user = await this.prisma.$transaction(async (tx) => {
        // Consume the invitation first; a second acceptance of the same token finds it used.
        const consumed = await tx.invitation.updateMany({ where: { id: invitation.id, isUsed: false }, data: { isUsed: true } });
        if (consumed.count !== 1) throw new BadRequestException('This invitation has already been used');

        return tx.user.create({
          data: {
            id: userId,
            email: invitation.email,
            name: data.name,
            role: invitation.role,
            password: hashedPassword,
            shopId: invitation.shopId,
          },
          select: safeUserSelect,
        });
      });

      return UserMapper.toSafeUserDto(user);
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException('Failed to accept invitation. The email might already be registered.');
    }
  }

  private invitationText(shopName: string, role: Role, token: string, expiresAt: Date): string {
    const origin = this.appConfig.frontendUrl.split(',')[0].trim();
    return [
      `You have been invited to join ${shopName} on DukaanAI as ${role}.`,
      '',
      `Open ${origin}/register?invite=${token} to create your account, or enter this invitation code where asked:`,
      '',
      token,
      '',
      `The invitation expires on ${expiresAt.toISOString()} (${INVITATION_TTL_HOURS} hours after it was sent).`,
      'If you were not expecting this invitation, ignore this message.',
    ].join('\n');
  }
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}
