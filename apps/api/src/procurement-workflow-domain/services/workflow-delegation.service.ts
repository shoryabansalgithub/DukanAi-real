import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { assertOwned } from '../../prisma/tenant-ownership';

@Injectable()
export class WorkflowDelegationService {
  constructor(private readonly prisma: PrismaService) {}

  async createDelegation(shopId: string, delegatorId: string, delegateId: string, startDate: Date, endDate: Date, notes?: string) {
    if (startDate >= endDate) throw new BadRequestException('End date must be after start date');
    await assertOwned(this.prisma, 'user', delegateId, shopId, { isDeleted: false });
    await assertOwned(this.prisma, 'user', delegateId, shopId, { isDeleted: false });
    
    return this.prisma.workflowDelegation.create({
      data: {
        shopId,
        delegatorUserId: delegatorId,
        delegateUserId: delegateId,
        startDate,
        endDate,
        notes
      }
    });
  }
  
  // Future implementation: intercepts Task assignment and auto-reassigns to delegateId
}
