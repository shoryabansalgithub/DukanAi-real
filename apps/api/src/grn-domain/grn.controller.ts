import { Controller, Get, Post, Param, Body, Query, Req } from '@nestjs/common';
import { CurrentShop } from '../iam/decorators/current-shop.decorator';
import { CurrentUser } from '../iam/decorators/current-user.decorator';
import { GrnRepository } from './repositories/grn.repository';
import type { Request } from 'express';
import { FINANCE_ROLES, MANAGEMENT_ROLES } from '../auth/role-sets';
import { Roles } from '../auth/roles.decorator';
import { LimitOffsetQueryDto, limitOffsetArgs } from '../common/pagination';
import { ApprovalDecisionDto } from '../common/dto/approval-decision.dto';
import { CreateGoodsReceiptDto, InspectGoodsDto, ReceiveGoodsDto } from './dto/goods-receipt.dto';
import { FeatureGate } from '../common/features/feature-gate';

@FeatureGate('procurement')
@Controller('grn')
export class GrnController {
  constructor(private readonly repository: GrnRepository) {}

  @Roles(...MANAGEMENT_ROLES)
  @Post()
  async createGrn(@CurrentShop() shopId: string, @CurrentUser('id') actorId: string, @Body() payload: CreateGoodsReceiptDto, @Req() req: Request) {
    return this.repository.createGoodsReceipt(shopId, payload, actorId, req.ip);
  }

  @Roles(...FINANCE_ROLES)
  @Get()
  async listGrns(
    @CurrentShop() shopId: string,
    @Query() query: LimitOffsetQueryDto,
  ) {
    const { limit, offset } = limitOffsetArgs(query);
    return this.repository.listGoodsReceipts(shopId, limit, offset);
  }

  @Roles(...FINANCE_ROLES)
  @Get(':id')
  async getGrn(@CurrentShop() shopId: string, @Param('id') id: string) {
    return this.repository.getGoodsReceipt(shopId, id);
  }

  @Roles(...MANAGEMENT_ROLES)
  @Post(':id/receive')
  async receiveGoods(@CurrentShop() shopId: string, @Param('id') id: string, @CurrentUser('id') actorId: string, @Body() payload: ReceiveGoodsDto, @Req() req: Request) {
    return this.repository.receiveGoods(shopId, id, payload, actorId, req.ip);
  }

  @Roles(...MANAGEMENT_ROLES)
  @Post(':id/inspect')
  async inspectGoods(@CurrentShop() shopId: string, @Param('id') id: string, @CurrentUser('id') actorId: string, @Body() payload: InspectGoodsDto, @Req() req: Request) {
    return this.repository.inspectGoods(shopId, id, payload, actorId, req.ip);
  }

  @Roles(...MANAGEMENT_ROLES)
  @Post(':id/accept')
  async acceptGoods(@CurrentShop() shopId: string, @Param('id') id: string, @CurrentUser('id') actorId: string, @Req() req: Request) {
    return this.repository.acceptGoods(shopId, id, actorId, req.ip);
  }

  @Roles(...MANAGEMENT_ROLES)
  @Post(':id/approve')
  async approveGrn(@CurrentShop() shopId: string, @Param('id') id: string, @CurrentUser('id') actorId: string, @Body() body: ApprovalDecisionDto, @Req() req: Request) {
    return this.repository.approveGrn(shopId, id, actorId, req.ip, body.comments, body.signature);
  }

  /** Refuses the delivery before its goods are accepted (a manager other than the receiver). */
  @Roles(...MANAGEMENT_ROLES)
  @Post(':id/reject')
  async rejectGrn(@CurrentShop() shopId: string, @Param('id') id: string, @CurrentUser('id') actorId: string, @Body() body: ApprovalDecisionDto) {
    return this.repository.rejectGrn(shopId, id, actorId, body.comments);
  }

  /** Withdraws a receipt before its goods are accepted. */
  @Roles(...MANAGEMENT_ROLES)
  @Post(':id/cancel')
  async cancelGrn(@CurrentShop() shopId: string, @Param('id') id: string, @CurrentUser('id') actorId: string, @Body() body: ApprovalDecisionDto) {
    return this.repository.cancelGrn(shopId, id, actorId, body.comments);
  }
}
