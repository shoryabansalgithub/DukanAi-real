import { Controller, Get, Post, Body, Param, Query } from '@nestjs/common';
import { WarehouseService } from './services/warehouse.service';
import { LocationHierarchyService } from './services/location-hierarchy.service';
import { CreateWarehouseDto, CreateLocationDto } from './dto/warehouse.dto';
import { MANAGEMENT_ROLES } from '../auth/role-sets';
import { Roles } from '../auth/roles.decorator';
import { ListQueryDto, PagedList } from '../common/pagination';
import { SubtreeQueryDto } from './dto/warehouse.dto';

@Controller('warehouse-domain')
export class WarehouseDomainController {
  constructor(
    private readonly warehouseService: WarehouseService,
    private readonly locationHierarchy: LocationHierarchyService
  ) {}

  @Roles(...MANAGEMENT_ROLES)
  @Post('warehouses')
  async createWarehouse(@Body() dto: CreateWarehouseDto) {
    return this.warehouseService.create(dto);
  }

  @Get('warehouses')
  @PagedList()
  async listWarehouses(@Query() query: ListQueryDto) {
    return this.warehouseService.findAll(query);
  }

  @Get('warehouses/:id')
  async getWarehouse(@Param('id') id: string) {
    return this.warehouseService.findOne(id);
  }

  @Roles(...MANAGEMENT_ROLES)
  @Post('locations')
  async createLocation(@Body() dto: CreateLocationDto) {
    return this.locationHierarchy.createLocation(dto);
  }

  @Get('warehouses/:warehouseId/locations/subtree')
  @PagedList()
  async getSubtree(@Param('warehouseId') warehouseId: string, @Query() query: SubtreeQueryDto) {
    return this.locationHierarchy.getSubtree(warehouseId, query.path, query);
  }
}
