import { Body, Controller, Get, Param, Post, Query, Req, Res, HttpCode, HttpStatus } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Role } from '@prisma/client';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { BillingService } from './billing.service';
import { InvoiceReversalService } from './services/invoice-reversal.service';
import { InvoiceQueryService } from './services/invoice-query.service';
import { CreateInvoiceDto } from './dto/create-invoice.dto';
import { CalculateInvoiceDto } from './dto/calculate-invoice.dto';
import { CancelInvoiceDto, ReturnInvoiceDto } from './dto/return-invoice.dto';
import { ListInvoicesDto } from './dto/list-invoices.dto';
import { Roles } from '../auth/roles.decorator';
import { TenantContextService } from '../iam/tenant-context/tenant-context.service';
import { SafeUserDto } from '../users/dto/safe-user.dto';
import { BillingActor } from './billing.types';

const POS_ROLES = [Role.OWNER, Role.ADMIN, Role.SUPER_ADMIN, Role.MANAGER, Role.CASHIER];
const READ_ROLES = [...POS_ROLES, Role.VIEWER];
const MANAGER_ROLES = [Role.OWNER, Role.ADMIN, Role.SUPER_ADMIN, Role.MANAGER];

@ApiTags('billing')
@ApiBearerAuth()
@Controller('billing')
export class BillingController {
  constructor(
    private readonly billingService: BillingService,
    private readonly reversal: InvoiceReversalService,
    private readonly queries: InvoiceQueryService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private actor(req: Request): BillingActor {
    const user = req.user as SafeUserDto;
    return {
      shopId: this.tenantContext.getShopId(),
      userId: user.id,
      role: user.role,
      ipAddress: req.ip,
      correlationId: this.tenantContext.getCorrelationId(),
    };
  }

  @Post('calculate')
  @Roles(...POS_ROLES)
  @HttpCode(HttpStatus.OK)
  calculate(@Req() req: Request, @Body() dto: CalculateInvoiceDto) {
    return this.billingService.calculateInvoice(dto, this.actor(req));
  }

  @Post('invoice')
  @Roles(...POS_ROLES)
  async createInvoice(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() dto: CreateInvoiceDto) {
    const result = await this.billingService.createInvoice(dto, this.actor(req));
    res.status(result.replayed ? HttpStatus.OK : HttpStatus.CREATED);
    return result;
  }

  @Get('invoices')
  @Roles(...READ_ROLES)
  list(@Req() req: Request, @Query() query: ListInvoicesDto) {
    return this.queries.list(query, this.actor(req));
  }

  @Get('invoices/:id')
  @Roles(...READ_ROLES)
  get(@Req() req: Request, @Param('id') id: string) {
    return this.queries.get(id, this.actor(req));
  }

  @Get('invoices/:id/receipt')
  @Roles(...READ_ROLES)
  receipt(@Req() req: Request, @Param('id') id: string) {
    return this.queries.receipt(id, this.actor(req));
  }

  @Post('returns')
  @Roles(...POS_ROLES)
  async processReturn(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() dto: ReturnInvoiceDto) {
    const result = await this.reversal.processReturn(dto, this.actor(req));
    res.status(result.replayed ? HttpStatus.OK : HttpStatus.CREATED);
    return result;
  }

  @Post('invoices/:id/cancel')
  @Roles(...MANAGER_ROLES)
  @HttpCode(HttpStatus.OK)
  cancel(@Req() req: Request, @Param('id') id: string, @Body() dto: CancelInvoiceDto) {
    return this.reversal.cancelInvoice(id, dto, this.actor(req));
  }
}
