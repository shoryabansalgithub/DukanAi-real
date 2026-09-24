import { Controller, Get, Post, Param, Body, UseGuards, Req } from '@nestjs/common';
import { InventoryDomainService } from './services/inventory-domain.service';
import { InventoryValidationService } from './services/inventory-validation.service';
import { AdjustStockDto, CreateInventoryItemDto } from './dto/inventory.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { TenantGuard } from '../iam/guards/tenant.guard';

@UseGuards(JwtAuthGuard, TenantGuard)
@Controller('inventory-domain')
export class InventoryDomainController {
  constructor(
    private readonly inventoryDomain: InventoryDomainService,
    private readonly inventoryValidation: InventoryValidationService,
  ) {}

  @Get()
  async findAll() {
    return this.inventoryDomain.findAll();
  }

  @Get('alerts')
  async getAlerts() {
    return this.inventoryDomain.getAlerts();
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

  @Post()
  async create(@Body() dto: CreateInventoryItemDto) {
    await this.inventoryValidation.validateProductOwnership(dto.productId);
    return this.inventoryDomain.ensureInventoryItem(dto.productId, dto.variantId, dto.locationId);
  }

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
