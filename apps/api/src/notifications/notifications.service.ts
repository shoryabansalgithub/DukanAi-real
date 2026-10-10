import { Injectable, NotFoundException } from '@nestjs/common';
import { Notification, NotificationType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TenantContextService } from '../iam/tenant-context/tenant-context.service';
import { CreateNotificationDto } from './dto/notification.dto';
import { ListQueryDto, pageArgs, PagedResult } from '../common/pagination';

/** Shape the notifications page renders. */
export interface NotificationView {
  id: string;
  type: NotificationType;
  title: string;
  message: string;
  isRead: boolean;
  createdAt: string;
}

function toView(notification: Notification): NotificationView {
  return {
    id: notification.id,
    type: notification.type,
    title: notification.title,
    message: notification.message,
    isRead: notification.isRead,
    createdAt: notification.createdAt.toISOString(),
  };
}

@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** Newest first, hard-capped page (roadmap 5.6; the former fixed `take: 100` is now the default page). */
  async findAll(query?: ListQueryDto): Promise<PagedResult<NotificationView>> {
    // shopId is injected by the tenant Prisma extension.
    const { skip, take } = pageArgs(query);
    const where = { isDeleted: false };
    const [notifications, total] = await Promise.all([
      this.prisma.notification.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip, take }),
      this.prisma.notification.count({ where }),
    ]);
    return { items: notifications.map(toView), total, skip, take };
  }

  async create(dto: CreateNotificationDto): Promise<NotificationView> {
    const notification = await this.prisma.notification.create({
      data: {
        // Scalar shopId (not shop.connect): the tenant Prisma extension
        // validates/injects shopId for tenant-owned models.
        shopId: this.tenantContext.getShopId(),
        type: dto.type,
        title: dto.title,
        message: dto.message,
        entityId: dto.entityId ?? null,
      },
    });
    return toView(notification);
  }

  async markRead(id: string): Promise<NotificationView> {
    const existing = await this.prisma.notification.findFirst({ where: { id, isDeleted: false } });
    if (!existing) {
      throw new NotFoundException(`Notification ${id} not found`);
    }
    const notification = await this.prisma.notification.update({
      where: { id },
      data: { isRead: true },
    });
    return toView(notification);
  }

  async markAllRead(): Promise<{ updated: number }> {
    const result = await this.prisma.notification.updateMany({
      where: { isRead: false, isDeleted: false },
      data: { isRead: true },
    });
    return { updated: result.count };
  }
}
