import { Controller, Get, Post, Param, Body, Query, Req } from '@nestjs/common';
import { ListQueryDto, PagedList } from '../common/pagination';
import { InventoryDomainService } from './services/inventory-domain.service';
import { InventoryValidationService } from './services/inventory-validation.service';
import { AdjustStockDto, CreateInventoryItemDto } from './dto/inventory.dto';
import { MANAGEMENT_ROLES } from '../auth/role-sets';
import { Roles } from '../auth/roles.decorator';

@Controller('inventory-domain')
export class InventoryDomainController {
  constructor(
    private readonly inventoryDomain: InventoryDomainService,
    private readonly inventoryValidation: InventoryValidationService,
  ) {}

  @Get()
  @PagedList()
  async findAll(@Query() query: ListQueryDto) {
    return this.inventoryDomain.findAll(query);
  }

  @Get('alerts')
  @PagedList()
  async getAlerts(@Query() query: ListQueryDto) {
    return this.inventoryDomain.getAlerts(query);
  }

  @Get('health')
  async getHealth() {
    return this.inventoryDomain.getHealth();
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    return this.inventoryDomain.findOne(id);
  }

  @Get(':id/history')
  async getHistory(@Param('id') id: string) {
    return this.inventoryDomain.getAdjustmentHistory(id);
  }

  @Roles(...MANAGEMENT_ROLES)
  @Post()
  async create(@Body() dto: CreateInventoryItemDto) {
    await this.inventoryValidation.validateProductOwnership(dto.productId);
    return this.inventoryDomain.ensureInventoryItem(dto.productId, dto.variantId, dto.locationId);
  }

  @Roles(...MANAGEMENT_ROLES)
  @Post(':id/adjust')
  async adjustStock(
    @Param('id') id: string,
    @Body() dto: AdjustStockDto,
    @Req() req: any
  ) {
    return this.inventoryDomain.adjustStock(
      id,
      dto.reason,
      dto.quantityChange,
      req.user?.id || 'system',
      { notes: dto.notes, correlationId: dto.correlationId }
    );
  }
}
