import { Controller, Get, Post, Body, Patch, Param, Delete, HttpCode, Query } from '@nestjs/common';
import { ListQueryDto, PagedList } from '../common/pagination';
import { CategoriesService } from './categories.service';
import { CreateCategoryDto, UpdateCategoryDto } from './dto/create-category.dto';
import { Roles } from '../auth/roles.decorator';
import { Role } from '@prisma/client';

@Controller('categories')
export class CategoriesController {
  constructor(private readonly categoriesService: CategoriesService) {}

  @Post()
  @Roles(Role.ADMIN, Role.MANAGER, Role.OWNER)
  create(@Body() dto: CreateCategoryDto) {
    return this.categoriesService.create(dto);
  }

  @Get()
  @PagedList()
  @Roles(Role.ADMIN, Role.MANAGER, Role.OWNER, Role.CASHIER, Role.VIEWER)
  findAll(@Query() query: ListQueryDto) {
    return this.categoriesService.findAll(query);
  }

  @Get(':id')
  @Roles(Role.ADMIN, Role.MANAGER, Role.OWNER, Role.CASHIER, Role.VIEWER)
  findOne(@Param('id') id: string) {
    return this.categoriesService.findOne(id);
  }

  @Patch(':id')
  @Roles(Role.ADMIN, Role.MANAGER, Role.OWNER)
  update(@Param('id') id: string, @Body() dto: UpdateCategoryDto) {
    return this.categoriesService.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  @Roles(Role.ADMIN, Role.OWNER)
  remove(@Param('id') id: string) {
    return this.categoriesService.softDelete(id);
  }
}
