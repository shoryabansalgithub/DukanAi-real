import { Controller, Get, Post, Param, Body, Query, Req } from '@nestjs/common';
import { CurrentShop } from '../iam/decorators/current-shop.decorator';
import { CurrentUser } from '../iam/decorators/current-user.decorator';
import { VendorBillRepository } from './repositories/vendor-bill.repository';
import type { Request } from 'express';
import { MANAGEMENT_ROLES } from '../auth/role-sets';
import { Roles } from '../auth/roles.decorator';
import { LimitOffsetQueryDto, limitOffsetArgs } from '../common/pagination';
import { ApprovalDecisionDto } from '../common/dto/approval-decision.dto';
import { CreateVendorBillDto, PayVendorBillDto } from './dto/vendor-bill.dto';

@Controller('vendor-bills')
export class VendorBillController {
  constructor(private readonly repository: VendorBillRepository) {}

  @Roles(...MANAGEMENT_ROLES)
  @Post()
  async createBill(@CurrentShop() shopId: string, @CurrentUser('id') actorId: string, @Body() payload: CreateVendorBillDto, @Req() req: Request) {
    return this.repository.createVendorBill(shopId, payload, actorId, req.ip);
  }

  @Get()
  async listBills(
    @CurrentShop() shopId: string,
    @Query() query: LimitOffsetQueryDto,
  ) {
    const { limit, offset } = limitOffsetArgs(query);
    return this.repository.listVendorBills(shopId, limit, offset);
  }

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
