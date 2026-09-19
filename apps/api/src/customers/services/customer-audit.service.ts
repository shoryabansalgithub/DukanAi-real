import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class CustomerAuditService {
  constructor(private readonly prisma: PrismaService) {}

  async logAction(data: {
    customerId: string;
    actorId?: string;
    action: string;
    previousPayload?: any;
    newPayload?: any;
    ipAddress?: string;
  }) {
    return this.prisma.customerAudit.create({
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
