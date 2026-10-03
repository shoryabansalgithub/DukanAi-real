import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ListQueryDto, PagedList } from '../common/pagination';
import { ExpensesService } from './expenses.service';
import { CreateExpenseDto, UpdateExpenseDto } from './dto/expense.dto';
import { MANAGEMENT_ROLES } from '../auth/role-sets';
import { Roles } from '../auth/roles.decorator';

@Controller('expenses')
export class ExpensesController {
  constructor(private readonly expensesService: ExpensesService) {}

  @Get()
  @PagedList()
  findAll(@Query() query: ListQueryDto) {
    return this.expensesService.findAll(query);
  }

  /** This month's figures over every expense of the shop, not over the loaded page (roadmap 6.7). */
  @Get('summary')
  summary() {
    return this.expensesService.summary();
  }

  @Roles(...MANAGEMENT_ROLES)
  @Post()
  create(@Body() dto: CreateExpenseDto) {
    return this.expensesService.create(dto);
  }

  @Roles(...MANAGEMENT_ROLES)
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateExpenseDto) {
    return this.expensesService.update(id, dto);
  }

  @Roles(...MANAGEMENT_ROLES)
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.expensesService.softDelete(id);
  }
}
