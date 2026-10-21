import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Role } from '@prisma/client';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ShiftsService } from './shifts.service';
import { CloseShiftDto, ListShiftsDto, OpenShiftDto } from './dto/shift.dto';
import { Roles } from '../auth/roles.decorator';
import { TenantContextService } from '../iam/tenant-context/tenant-context.service';
import { SafeUserDto } from '../users/dto/safe-user.dto';
import { BillingActor } from '../billing/billing.types';

const POS_ROLES = [Role.OWNER, Role.ADMIN, Role.SUPER_ADMIN, Role.MANAGER, Role.CASHIER];

@ApiTags('shifts')
@ApiBearerAuth()
@Controller('shifts')
export class ShiftsController {
  constructor(private readonly shifts: ShiftsService, private readonly tenantContext: TenantContextService) {}

  private actor(req: Request): BillingActor {
    const user = req.user as SafeUserDto;
    return { shopId: this.tenantContext.getShopId(), userId: user.id, role: user.role, ipAddress: req.ip, correlationId: this.tenantContext.getCorrelationId() };
  }

  @Get('current')
  @Roles(...POS_ROLES)
  current(@Req() req: Request) {
    return this.shifts.current(this.actor(req));
  }

  @Post('open')
  @Roles(...POS_ROLES)
  open(@Req() req: Request, @Body() dto: OpenShiftDto) {
    return this.shifts.open(dto, this.actor(req));
  }

  @Post('current/close')
  @Roles(...POS_ROLES)
  @HttpCode(HttpStatus.OK)
  closeCurrent(@Req() req: Request, @Body() dto: CloseShiftDto) {
    return this.shifts.close(dto, this.actor(req));
  }

  @Post(':id/close')
  @Roles(...POS_ROLES)
  @HttpCode(HttpStatus.OK)
  close(@Req() req: Request, @Param('id') id: string, @Body() dto: CloseShiftDto) {
    return this.shifts.close(dto, this.actor(req), id);
  }

  @Get()
  @Roles(...POS_ROLES, Role.VIEWER)
  list(@Req() req: Request, @Query() query: ListShiftsDto) {
    return this.shifts.list(query, this.actor(req));
  }

  @Get(':id')
  @Roles(...POS_ROLES, Role.VIEWER)
  get(@Req() req: Request, @Param('id') id: string) {
    return this.shifts.get(id, this.actor(req));
  }
}
