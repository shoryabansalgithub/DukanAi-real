import { Controller, Get, Post, Param, Body, Query, Req } from '@nestjs/common';
import { CurrentShop } from '../iam/decorators/current-shop.decorator';
import { CurrentUser } from '../iam/decorators/current-user.decorator';
import { PurchaseReturnRepository } from './repositories/purchase-return.repository';
import type { Request } from 'express';
import { MANAGEMENT_ROLES } from '../auth/role-sets';
import { Roles } from '../auth/roles.decorator';
import { LimitOffsetQueryDto, limitOffsetArgs } from '../common/pagination';
import { ApprovalDecisionDto } from '../common/dto/approval-decision.dto';
import { CreatePurchaseReturnDto, DispatchShipmentDto } from './dto/purchase-return.dto';

@Controller('purchase-returns')
export class PurchaseReturnController {
  constructor(private readonly repository: PurchaseReturnRepository) {}

  @Roles(...MANAGEMENT_ROLES)
  @Post()
  async createReturn(@CurrentShop() shopId: string, @CurrentUser('id') actorId: string, @Body() payload: CreatePurchaseReturnDto, @Req() req: Request) {
    return this.repository.createPurchaseReturn(shopId, payload, actorId, req.ip);
  }

  @Get()
  async listReturns(
    @CurrentShop() shopId: string,
    @Query() query: LimitOffsetQueryDto,
  ) {
    const { limit, offset } = limitOffsetArgs(query);
    return this.repository.listPurchaseReturns(shopId, limit, offset);
  }

  @Get(':id')
  async getReturn(@CurrentShop() shopId: string, @Param('id') id: string) {
    return this.repository.getPurchaseReturn(shopId, id);
  }

  @Roles(...MANAGEMENT_ROLES)
  @Post(':id/submit')
  async submitReturn(@CurrentShop() shopId: string, @Param('id') id: string, @CurrentUser('id') actorId: string, @Req() req: Request) {
    return this.repository.submitPurchaseReturn(shopId, id, actorId, req.ip);
  }

  @Roles(...MANAGEMENT_ROLES)
  @Post(':id/approve')
  async approveReturn(@CurrentShop() shopId: string, @Param('id') id: string, @CurrentUser('id') actorId: string, @Body() body: ApprovalDecisionDto, @Req() req: Request) {
    return this.repository.approvePurchaseReturn(shopId, id, actorId, req.ip, body.comments, body.signature);
  }

  @Roles(...MANAGEMENT_ROLES)
  @Post(':id/shipment')
  async shipReturn(@CurrentShop() shopId: string, @Param('id') id: string, @CurrentUser('id') actorId: string, @Body() body: DispatchShipmentDto, @Req() req: Request) {
    return this.repository.dispatchShipment(shopId, id, body, actorId, req.ip);
  }

  @Roles(...MANAGEMENT_ROLES)
  @Post(':id/complete')
  async completeReturn(@CurrentShop() shopId: string, @Param('id') id: string, @CurrentUser('id') actorId: string, @Req() req: Request) {
    return this.repository.completePurchaseReturn(shopId, id, actorId, req.ip);
  }
}
