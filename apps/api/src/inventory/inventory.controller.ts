import { Controller, Get, Query } from '@nestjs/common';
import { InventoryService } from './inventory.service';
import { ListQueryDto, PagedList } from '../common/pagination';

@Controller('inventory')
export class InventoryController {
  constructor(private readonly inventoryService: InventoryService) {}

  @Get('products')
  @PagedList()
  async getProducts(@Query() query: ListQueryDto) {
    return this.inventoryService.getProducts(query);
  }
}
