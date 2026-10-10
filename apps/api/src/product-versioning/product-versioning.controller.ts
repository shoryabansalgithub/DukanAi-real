import { Controller, Post, Body, Param, Get, Patch } from '@nestjs/common';
import { ProductVersioningService } from './product-versioning.service';
import { Roles } from '../auth/roles.decorator';
import { Role } from '@prisma/client';
import type { JsonObject } from '../common/pipes/json-object.pipe';
import { JsonObjectPipe } from '../common/pipes/json-object.pipe';

@Controller('products/:productId/revisions')
export class ProductVersioningController {
  constructor(private readonly versioningService: ProductVersioningService) {}

  @Post('draft')
  @Roles(Role.ADMIN, Role.MANAGER, Role.OWNER)
  createDraft(@Param('productId') productId: string, @Body('branchName') branchName?: string) {
    return this.versioningService.createDraft(productId, branchName);
  }

  @Patch(':revId')
  @Roles(Role.ADMIN, Role.MANAGER, Role.OWNER)
  saveDraft(@Param('revId') revId: string, @Body(JsonObjectPipe) data: JsonObject) {
    return this.versioningService.saveDraft(revId, data);
  }

  @Post(':revId/submit')
  @Roles(Role.ADMIN, Role.MANAGER, Role.OWNER)
  submitForReview(@Param('revId') revId: string) {
    return this.versioningService.submitForReview(revId);
  }

  @Post(':revId/approve')
  @Roles(Role.ADMIN, Role.OWNER)
  approve(@Param('revId') revId: string, @Body('comments') comments?: string) {
    return this.versioningService.approve(revId, comments);
  }

  @Post(':revId/publish')
  @Roles(Role.ADMIN, Role.OWNER)
  publish(@Param('revId') revId: string) {
    return this.versioningService.publish(revId);
  }

  @Get('compare/:revA/:revB')
  @Roles(Role.ADMIN, Role.MANAGER, Role.OWNER, Role.CASHIER, Role.VIEWER)
  getDiff(@Param('revA') revA: string, @Param('revB') revB: string) {
    return this.versioningService.getDiff(revA, revB);
  }
}
