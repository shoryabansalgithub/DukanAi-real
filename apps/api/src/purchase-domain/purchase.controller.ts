import { Controller, Get, Post, Put, Param, Body, Query, Req } from '@nestjs/common';
import { CurrentShop } from '../iam/decorators/current-shop.decorator';
import { CurrentUser } from '../iam/decorators/current-user.decorator';
import { PurchaseRepository } from './repositories/purchase.repository';
import type { Request } from 'express';
import { MANAGEMENT_ROLES } from '../auth/role-sets';
import { Roles } from '../auth/roles.decorator';
import { LimitOffsetQueryDto, limitOffsetArgs } from '../common/pagination';
import { ApprovalDecisionDto } from '../common/dto/approval-decision.dto';
import { CreatePurchaseOrderDto, UpdatePurchaseDraftDto } from './dto/purchase-order.dto';

@Controller('purchases')
export class PurchaseController {
  constructor(private readonly repository: PurchaseRepository) {}

  @Roles(...MANAGEMENT_ROLES)
  @Post()
  async createPurchaseOrder(@CurrentShop() shopId: string, @CurrentUser('id') actorId: string, @Body() payload: CreatePurchaseOrderDto, @Req() req: Request) {
    const ipAddress = req.ip;
    return this.repository.createPurchaseOrder(shopId, payload, actorId, ipAddress);
  }

  @Get()
  async listPurchaseOrders(
    @CurrentShop() shopId: string,
    @Query() query: LimitOffsetQueryDto,
  ) {
    const { limit, offset } = limitOffsetArgs(query);
    return this.repository.listPurchaseOrders(shopId, limit, offset);
  }

  @Get(':id')
  async getPurchaseOrder(@CurrentShop() shopId: string, @Param('id') id: string) {
    return this.repository.getPurchaseOrder(shopId, id);
  }

  @Roles(...MANAGEMENT_ROLES)
  @Post(':id/approve')
  async approvePurchaseOrder(@CurrentShop() shopId: string, @Param('id') id: string, @CurrentUser('id') actorId: string, @Body() body: ApprovalDecisionDto, @Req() req: Request) {
    return this.repository.approvePurchaseOrder(shopId, id, actorId, req.ip, body.comments, body.signature);
  }

  // Phase 3.4.2 Enterprise Additions
  
  @Roles(...MANAGEMENT_ROLES)
  @Put(':id/draft')
  async updateDraft(@CurrentShop() shopId: string, @Param('id') id: string, @CurrentUser('id') actorId: string, @Body() payload: UpdatePurchaseDraftDto) {
    return this.repository.updateDraft(shopId, id, payload, actorId);
  }

  @Roles(...MANAGEMENT_ROLES)
  @Post(':id/submit')
  async submitPurchaseOrder(@CurrentShop() shopId: string, @Param('id') id: string, @CurrentUser('id') actorId: string, @Body() body: ApprovalDecisionDto) {
    return this.repository.submitPurchaseOrder(shopId, id, actorId, body.comments);
  }

  @Roles(...MANAGEMENT_ROLES)
  @Post(':id/reject')
  async rejectPurchaseOrder(@CurrentShop() shopId: string, @Param('id') id: string, @CurrentUser('id') actorId: string, @Body() body: ApprovalDecisionDto) {
    return this.repository.rejectPurchaseOrder(shopId, id, actorId, body.comments);
  }
}
