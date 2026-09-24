import { Controller, Get, Post, Body, Patch, Param, Delete, UseGuards, HttpCode, Query } from '@nestjs/common';
import { ProductsService } from './products.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/create-product.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { TenantGuard } from '../iam/guards/tenant.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { Role } from '@prisma/client';

function parseIntParam(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

@Controller('products')
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Post()
  @Roles(Role.ADMIN, Role.MANAGER, Role.OWNER)
  create(@Body() createProductDto: CreateProductDto) {
    return this.productsService.create(createProductDto);
  }

  /** `GET /products?q&limit&offset` (limit max 200) — returns an array (contract §5). */
  @Get()
  @Roles(Role.ADMIN, Role.MANAGER, Role.OWNER, Role.CASHIER, Role.VIEWER)
  findAll(
    @Query('q') q?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.productsService.findAll({
      q,
      limit: parseIntParam(limit),
      offset: parseIntParam(offset),
    });
  }

  @Get(':id')
  @Roles(Role.ADMIN, Role.MANAGER, Role.OWNER, Role.CASHIER, Role.VIEWER)
  findOne(@Param('id') id: string) {
    return this.productsService.findOne(id);
  }

  @Patch(':id')
  @Roles(Role.ADMIN, Role.MANAGER, Role.OWNER)
  update(@Param('id') id: string, @Body() updateProductDto: UpdateProductDto) {
    return this.productsService.update(id, updateProductDto);
  }

  @Delete(':id')
  @HttpCode(204)
  @Roles(Role.ADMIN, Role.OWNER)
  remove(@Param('id') id: string) {
    return this.productsService.softDelete(id);
  }
}
