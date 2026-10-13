import { Controller, Get, Post, Param, Body, Query, Req } from '@nestjs/common';
import { CurrentShop } from '../iam/decorators/current-shop.decorator';
import { CurrentUser } from '../iam/decorators/current-user.decorator';
import { VendorBillRepository } from './repositories/vendor-bill.repository';
import type { Request } from 'express';
import { FINANCE_ROLES, MANAGEMENT_ROLES } from '../auth/role-sets';
import { Roles } from '../auth/roles.decorator';
import { LimitOffsetQueryDto, limitOffsetArgs } from '../common/pagination';
import { ApprovalDecisionDto } from '../common/dto/approval-decision.dto';
import { CreateVendorBillDto, PayVendorBillDto } from './dto/vendor-bill.dto';
import { FeatureGate } from '../common/features/feature-gate';

@FeatureGate('procurement')
@Controller('vendor-bills')
export class VendorBillController {
  constructor(private readonly repository: VendorBillRepository) {}

  @Roles(...MANAGEMENT_ROLES)
  @Post()
  async createBill(@CurrentShop() shopId: string, @CurrentUser('id') actorId: string, @Body() payload: CreateVendorBillDto, @Req() req: Request) {
    return this.repository.createVendorBill(shopId, payload, actorId, req.ip);
  }

  @Roles(...FINANCE_ROLES)
  @Get()
  async listBills(
    @CurrentShop() shopId: string,
    @Query() query: LimitOffsetQueryDto,
  ) {
    const { limit, offset } = limitOffsetArgs(query);
    return this.repository.listVendorBills(shopId, limit, offset);
  }

  @Roles(...FINANCE_ROLES)
  @Get(':id')
  async getBill(@CurrentShop() shopId: string, @Param('id') id: string) {
    return this.repository.getVendorBill(shopId, id);
  }

  @Roles(...MANAGEMENT_ROLES)
  @Post(':id/submit')
  async submitBill(@CurrentShop() shopId: string, @Param('id') id: string, @CurrentUser('id') actorId: string, @Req() req: Request) {
    return this.repository.submitVendorBill(shopId, id, actorId, req.ip);
  }

  @Roles(...MANAGEMENT_ROLES)
  @Post(':id/approve')
  async approveBill(@CurrentShop() shopId: string, @Param('id') id: string, @CurrentUser('id') actorId: string, @Body() body: ApprovalDecisionDto, @Req() req: Request) {
    return this.repository.approveVendorBill(shopId, id, actorId, req.ip, body.comments, body.signature);
  }

  /** PENDING_APPROVAL -> REJECTED by a manager other than the creator or submitter. */
  @Roles(...MANAGEMENT_ROLES)
  @Post(':id/reject')
  async rejectBill(@CurrentShop() shopId: string, @Param('id') id: string, @CurrentUser('id') actorId: string, @Body() body: ApprovalDecisionDto) {
    return this.repository.rejectVendorBill(shopId, id, actorId, body.comments);
  }

  /** DRAFT / SUBMITTED / PENDING_APPROVAL -> CANCELLED. */
  @Roles(...MANAGEMENT_ROLES)
  @Post(':id/cancel')
  async cancelBill(@CurrentShop() shopId: string, @Param('id') id: string, @CurrentUser('id') actorId: string, @Body() body: ApprovalDecisionDto) {
    return this.repository.cancelVendorBill(shopId, id, actorId, body.comments);
  }

  @Roles(...MANAGEMENT_ROLES)
  @Post(':id/post')
  async postBill(@CurrentShop() shopId: string, @Param('id') id: string, @CurrentUser('id') actorId: string, @Req() req: Request) {
    return this.repository.postVendorBill(shopId, id, actorId, req.ip);
  }

  @Roles(...MANAGEMENT_ROLES)
  @Post(':id/pay')
  async payBill(@CurrentShop() shopId: string, @Param('id') id: string, @CurrentUser('id') actorId: string, @Body() payload: PayVendorBillDto, @Req() req: Request) {
    return this.repository.payVendorBill(shopId, id, payload, actorId, req.ip);
  }
}
