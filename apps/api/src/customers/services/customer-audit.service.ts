import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class CustomerAuditService {
  constructor(private readonly prisma: PrismaService) {}

  /** Writes one audit row; pass the caller's `tx` so the row commits with the change it records. */
  async logAction(
    data: {
      customerId: string;
      actorId?: string;
      action: string;
      previousPayload?: any;
      newPayload?: any;
      ipAddress?: string;
    },
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ) {
    return db.customerAudit.create({
      data: {
        customerId: data.customerId,
        actorId: data.actorId ?? null,
        action: data.action,
        previousPayload: data.previousPayload ? data.previousPayload : undefined,
        newPayload: data.newPayload ? data.newPayload : undefined,
        ipAddress: data.ipAddress,
      }
    });
  }
}
