import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ListQueryDto, PagedList } from '../common/pagination';
import { CurrentUser } from '../iam/decorators/current-user.decorator';
import { SafeUserDto } from '../users/dto/safe-user.dto';
import { SuppliersService } from './suppliers.service';
import { CreateSupplierDto, RecordSupplierPaymentDto, UpdateSupplierDto } from './dto/supplier.dto';
import { ADMIN_ROLES, MANAGEMENT_ROLES } from '../auth/role-sets';
import { Roles } from '../auth/roles.decorator';

@Controller('suppliers')
export class SuppliersController {
  constructor(private readonly suppliersService: SuppliersService) {}

  @Get()
  @PagedList()
  findAll(@Query() query: ListQueryDto) {
    return this.suppliersService.findAll(query);
  }

  @Roles(...MANAGEMENT_ROLES)
  @Post()
  create(@Body() dto: CreateSupplierDto) {
    return this.suppliersService.create(dto);
  }

  @Roles(...MANAGEMENT_ROLES)
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateSupplierDto) {
    return this.suppliersService.update(id, dto);
  }

  @Roles(...MANAGEMENT_ROLES)
  @Post(':id/payments')
  recordPayment(@Param('id') id: string, @Body() dto: RecordSupplierPaymentDto, @CurrentUser() user: SafeUserDto) {
    return this.suppliersService.recordPayment(id, dto, user.id);
  }

  @Roles(...ADMIN_ROLES)
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.suppliersService.softDelete(id);
  }
}
