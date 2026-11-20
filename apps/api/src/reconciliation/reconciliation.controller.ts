import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ReconciliationTrigger } from '@prisma/client';
import { ADMIN_ROLES } from '../auth/role-sets';
import { Roles } from '../auth/roles.decorator';
import { ListQueryDto, PagedList } from '../common/pagination';
import { CurrentShop } from '../iam/decorators/current-shop.decorator';
import { RunReconciliationDto } from './dto/run-reconciliation.dto';
import { ReconciliationService } from './reconciliation.service';

/**
 * Financial reconciliation (roadmap 9.5), owner-level: the newest run, the
 * run history, one run with its checks, and an on-demand run of a business
 * day. Every read is the caller's shop (tenant context); a run id of another
 * shop is 404.
 */
@ApiTags('reconciliation')
@ApiBearerAuth()
@Controller('reconciliation')
export class ReconciliationController {
  constructor(private readonly reconciliation: ReconciliationService) {}

  @Get('latest')
  @Roles(...ADMIN_ROLES)
  latest(@CurrentShop() shopId: string) {
    return this.reconciliation.latest(shopId);
  }

  @Get('runs')
  @Roles(...ADMIN_ROLES)
  @PagedList()
  list(@CurrentShop() shopId: string, @Query() query: ListQueryDto) {
    return this.reconciliation.list(shopId, query);
  }

  @Get('runs/:id')
  @Roles(...ADMIN_ROLES)
  get(@CurrentShop() shopId: string, @Param('id') id: string) {
    return this.reconciliation.get(shopId, id);
  }

  @Post('run')
  @Roles(...ADMIN_ROLES)
  @HttpCode(HttpStatus.CREATED)
  run(@CurrentShop() shopId: string, @Body() dto: RunReconciliationDto) {
    return this.reconciliation.runForShop(shopId, { trigger: ReconciliationTrigger.MANUAL, date: dto.date });
  }
}
