import { Injectable, BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TransferOwnershipDto } from './dto/transfer-ownership.dto';
import * as bcrypt from 'bcrypt';
import { Role } from '@prisma/client';
import { SocketSessionService } from '../iam/websockets/socket-session.service';
import { SHOP_PROFILE_FIELDS, UpdateShopProfileDto } from './dto/update-shop-profile.dto';

@Injectable()
export class ShopsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly socketSessionService: SocketSessionService,
  ) {}

  /** Shop profile for the settings page - core fields plus GSTIN from settings. */
  async getShopProfile(shopId: string) {
    const shop = await this.prisma.shop.findUnique({
      where: { id: shopId },
      select: {
        id: true,
        name: true,
        address: true,
        city: true,
        state: true,
        pincode: true,
        phone: true,
        email: true,
        logoUrl: true,
        createdAt: true,
        settings: { select: { gstin: true, currency: true, timezone: true } },
      },
    });
    if (!shop) throw new NotFoundException('Shop not found');
    return shop;
  }

  /**
   * Writes only the profile columns named in SHOP_PROFILE_FIELDS. The body is a
   * validated UpdateShopProfileDto, and the Prisma `data` object is built field
   * by field: a request can never reach relations such as `users` or `owner`.
   */
  async updateShopProfile(shopId: string, dto: UpdateShopProfileDto) {
    const shopFields: Partial<Pick<UpdateShopProfileDto, (typeof SHOP_PROFILE_FIELDS)[number]>> = {};
    for (const field of SHOP_PROFILE_FIELDS) {
      if (dto[field] !== undefined) shopFields[field] = dto[field];
    }
    const gstin = dto.gstin;

    await this.prisma.$transaction(async (tx) => {
      if (Object.keys(shopFields).length > 0) {
        await tx.shop.update({ where: { id: shopId }, data: shopFields });
      }
      if (gstin !== undefined) {
        await tx.shopSettings.upsert({
          where: { shopId },
          create: { shopId, gstin },
          update: { gstin },
        });
      }
    });

    return this.getShopProfile(shopId);
  }

  async transferOwnership(shopId: string, currentOwnerId: string, dto: TransferOwnershipDto) {
    const shop = await this.prisma.shop.findUnique({ where: { id: shopId } });
    if (!shop) throw new NotFoundException('Shop not found');
    if (shop.ownerId !== currentOwnerId) throw new ForbiddenException('Only the current owner can transfer ownership');

    const currentOwner = await this.prisma.user.findUnique({ where: { id: currentOwnerId } });
    if (!currentOwner) throw new NotFoundException('Current owner not found');

    if (!currentOwner.password) {
      throw new ForbiddenException('Ownership transfer requires a password. Google-authenticated owners must set a password first.');
    }
    const passwordValid = await bcrypt.compare(dto.currentPassword, currentOwner.password);
    if (!passwordValid) throw new ForbiddenException('Invalid password');

    const newOwner = await this.prisma.user.findUnique({ where: { id: dto.newOwnerId } });
    if (!newOwner) throw new NotFoundException('New owner not found');
    if (newOwner.shopId !== shopId) throw new BadRequestException('New owner must belong to this shop');
    if (newOwner.isDeleted || !newOwner.isActive) throw new BadRequestException('New owner account is inactive or deleted');

    // Execute atomic ownership transfer and token version invalidation
    await this.prisma.$transaction(async (tx) => {
      // 1. Demote old owner to ADMIN and increment tokenVersion to revoke sessions
      await tx.user.update({
        where: { id: currentOwnerId },
        data: { role: Role.ADMIN, tokenVersion: { increment: 1 } },
      });

      // 2. Update new owner role to OWNER and increment tokenVersion
      await tx.user.update({
        where: { id: dto.newOwnerId },
        data: { role: Role.OWNER, tokenVersion: { increment: 1 } },
      });

      // 3. Update shop ownerId
      await tx.shop.update({
        where: { id: shopId },
        data: { ownerId: dto.newOwnerId },
      });
      
      // 4. Audit Log
      await tx.auditLog.create({
        data: {
          shopId,
          userId: currentOwnerId,
          action: 'TRANSFER_OWNERSHIP',
          entity: 'Shop',
          entityId: shopId,
          afterData: { oldOwner: currentOwnerId, newOwner: dto.newOwnerId },
        }
      });
    });

    this.socketSessionService.disconnectUser(currentOwnerId, 'Ownership transferred - Session revoked');
    this.socketSessionService.disconnectUser(dto.newOwnerId, 'Role promoted - Session revoked');

    return { message: 'Ownership transferred successfully' };
  }

  async deleteShop(shopId: string, ownerId: string) {
    const shop = await this.prisma.shop.findUnique({ where: { id: shopId } });
    if (!shop) throw new NotFoundException('Shop not found');
    if (shop.ownerId !== ownerId) throw new ForbiddenException('Only the owner can delete the shop');

    // To avoid circular FK issues, soft delete users first, then the shop.
    await this.prisma.$transaction(async (tx) => {
      await tx.user.updateMany({
        where: { shopId },
        data: { isDeleted: true, deletedAt: new Date(), isActive: false, tokenVersion: { increment: 1 } },
      });

      await tx.shop.update({
        where: { id: shopId },
        data: { status: 'DELETED', isDeleted: true, deletedAt: new Date() },
      });
      
      await tx.auditLog.create({
        data: {
          shopId,
          userId: ownerId,
          action: 'DELETE_SHOP',
          entity: 'Shop',
          entityId: shopId,
        }
      });
    });

    this.socketSessionService.disconnectShop(shopId, 'Shop has been deleted');

    return { message: 'Shop successfully deleted' };
  }
}
