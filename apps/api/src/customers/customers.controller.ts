import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Role } from '@prisma/client';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CustomersService } from './customers.service';
import { CustomerSearchService } from './services/customer-search.service';
import { CreateCustomerDto, ListCustomersDto, PaginationDto, RecordPaymentDto, SearchCustomersDto, UpdateCustomerDto } from './dto/create-customer.dto';
import { Roles } from '../auth/roles.decorator';
import { TenantContextService } from '../iam/tenant-context/tenant-context.service';
import { SafeUserDto } from '../users/dto/safe-user.dto';
import { BillingActor } from '../billing/billing.types';

const POS_ROLES = [Role.OWNER, Role.ADMIN, Role.SUPER_ADMIN, Role.MANAGER, Role.CASHIER];
const READ_ROLES = [...POS_ROLES, Role.VIEWER];
const MANAGER_ROLES = [Role.OWNER, Role.ADMIN, Role.SUPER_ADMIN, Role.MANAGER];

@ApiTags('customers')
@ApiBearerAuth()
@Controller('customers')
export class CustomersController {
  constructor(
    private readonly customersService: CustomersService,
    private readonly searchService: CustomerSearchService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private actor(req: Request): BillingActor {
    const user = req.user as SafeUserDto;
    return { shopId: this.tenantContext.getShopId(), userId: user.id, role: user.role, ipAddress: req.ip, correlationId: this.tenantContext.getCorrelationId() };
  }

  @Post()
  @Roles(...POS_ROLES)
  create(@Req() req: Request, @Body() dto: CreateCustomerDto) {
    return this.customersService.create(dto, this.actor(req));
  }

  @Get()
  @Roles(...READ_ROLES)
  findAll(@Query() query: ListCustomersDto) {
    return this.customersService.findAll(query);
  }

  @Post('search')
  @Roles(...READ_ROLES)
  @HttpCode(HttpStatus.OK)
  search(@Req() req: Request, @Body() body: SearchCustomersDto) {
    return this.searchService.search(this.actor(req).shopId, body.query, body.skip, body.take);
  }

  @Get(':id')
  @Roles(...READ_ROLES)
  findOne(@Param('id') id: string) {
    return this.customersService.findOne(id);
  }

  @Patch(':id')
  @Roles(...POS_ROLES)
  update(@Req() req: Request, @Param('id') id: string, @Body() dto: UpdateCustomerDto) {
    return this.customersService.update(id, dto, this.actor(req));
  }

  @Get(':id/ledger')
  @Roles(...READ_ROLES)
  ledger(@Param('id') id: string, @Query() query: PaginationDto) {
    return this.customersService.ledgerEntries(id, query);
  }

  @Get(':id/invoices')
  @Roles(...READ_ROLES)
  invoices(@Param('id') id: string, @Query() query: PaginationDto) {
    return this.customersService.invoices(id, query);
  }

  @Post(':id/payments')
  @Roles(...POS_ROLES)
  async recordPayment(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Param('id') id: string, @Body() dto: RecordPaymentDto) {
    const result = await this.customersService.recordPayment(id, dto, this.actor(req));
    res.status(result.replayed ? HttpStatus.OK : HttpStatus.CREATED);
    return result;
  }

  @Delete(':id')
  @Roles(...MANAGER_ROLES)
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Req() req: Request, @Param('id') id: string) {
    await this.customersService.softDelete(id, this.actor(req));
  }
}
