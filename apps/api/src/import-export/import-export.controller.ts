import { Controller, Post, Get, Body, Param, BadRequestException, UseInterceptors, UploadedFile, NotFoundException, Query, Header, Res } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { ImportKind, ImportMode } from '@prisma/client';
import { UploadCleanupInterceptor } from '../common/upload/upload-cleanup.interceptor';
import { CurrentShop, CurrentUser } from '../iam/decorators';
import { ImportExportFeatureConfig } from '../config/domains/features/import-export-feature.config';
import { MANAGEMENT_ROLES } from '../auth/role-sets';
import { Roles } from '../auth/roles.decorator';
import { ListQueryDto, PagedList } from '../common/pagination';
import { ImportRowsQueryDto, UploadImportDto } from './dto/upload-import.dto';
import { assertImportFileContent } from './import-upload';
import { importKindFromSlug, IMPORT_KIND_SLUGS, templateCsv } from './import-columns';
import { ImportExportService } from './import-export.service';

/**
 * Onboarding imports (roadmap 4.1, 9.20): products, customers with their
 * opening udhar, and opening stock. The shop comes from the verified
 * session and the job carries it, and the uploading user, to the worker.
 * `dryRun=true` validates and plans every row and writes only the report;
 * `POST /imports/jobs/:id/apply` then runs that file for real.
 */
@Controller('imports')
export class ImportExportController {
  constructor(
    private readonly imports: ImportExportService,
    private readonly importExportFeatureConfig: ImportExportFeatureConfig,
  ) {}

  @Roles(...MANAGEMENT_ROLES)
  @Post('products/upload')
  @UseInterceptors(UploadCleanupInterceptor, FileInterceptor('file'))
  async uploadImportFile(@UploadedFile() file: Express.Multer.File | undefined, @Body() body: UploadImportDto, @CurrentShop() shopId: string, @CurrentUser('id') userId: string) {
    return this.upload(ImportKind.PRODUCTS, file, body, shopId, userId);
  }

  @Roles(...MANAGEMENT_ROLES)
  @Post('customers/upload')
  @UseInterceptors(UploadCleanupInterceptor, FileInterceptor('file'))
  async uploadCustomers(@UploadedFile() file: Express.Multer.File | undefined, @Body() body: UploadImportDto, @CurrentShop() shopId: string, @CurrentUser('id') userId: string) {
    return this.upload(ImportKind.CUSTOMERS, file, body, shopId, userId);
  }

  @Roles(...MANAGEMENT_ROLES)
  @Post('opening-stock/upload')
  @UseInterceptors(UploadCleanupInterceptor, FileInterceptor('file'))
  async uploadOpeningStock(@UploadedFile() file: Express.Multer.File | undefined, @Body() body: UploadImportDto, @CurrentShop() shopId: string, @CurrentUser('id') userId: string) {
    return this.upload(ImportKind.OPENING_STOCK, file, body, shopId, userId);
  }

  /** The template a shop fills in: the header row and two sample rows (`docs/onboarding/<kind>.csv`). */
  @Get('templates/:kind')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  template(@Param('kind') slug: string, @Res({ passthrough: true }) res: Response): string {
    const kind = importKindFromSlug(slug);
    if (!kind) throw new NotFoundException({ message: `No import template "${slug}"; use ${Object.values(IMPORT_KIND_SLUGS).join(', ')}.`, code: 'IMPORT_TEMPLATE_NOT_FOUND' });
    res.setHeader('Content-Disposition', `attachment; filename="${IMPORT_KIND_SLUGS[kind]}.csv"`);
    return templateCsv(kind);
  }

  @Get('jobs')
  @PagedList()
  async listJobs(@Query() query: ListQueryDto, @CurrentShop() shopId: string) {
    return this.imports.list(shopId, query);
  }

  @Get('jobs/:id')
  async getJobStatus(@Param('id') id: string, @CurrentShop() shopId: string) {
    return this.imports.get(shopId, id);
  }

  /** The per-row report: action, what changes, errors and warnings (`?status=ERROR|SUCCESS|SKIPPED`). */
  @Get('jobs/:id/rows')
  @PagedList()
  async getJobRows(@Param('id') id: string, @Query() query: ImportRowsQueryDto, @CurrentShop() shopId: string) {
    return this.imports.rows(shopId, id, query);
  }

  @Get('jobs/:id/errors')
  async getJobErrors(@Param('id') id: string, @CurrentShop() shopId: string) {
    return this.imports.errors(shopId, id, this.importExportFeatureConfig.exportListLimit);
  }

  /** The whole report as a CSV download. */
  @Get('jobs/:id/report')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  async getJobReport(@Param('id') id: string, @CurrentShop() shopId: string, @Res({ passthrough: true }) res: Response): Promise<string> {
    const report = await this.imports.reportCsv(shopId, id);
    res.setHeader('Content-Disposition', `attachment; filename="${report.fileName}"`);
    return report.csv;
  }

  /** Runs a finished dry run for real (a new job on the same file). */
  @Roles(...MANAGEMENT_ROLES)
  @Post('jobs/:id/apply')
  async applyDryRun(@Param('id') id: string, @CurrentShop() shopId: string, @CurrentUser('id') userId: string) {
    return this.imports.applyDryRun(shopId, id, userId);
  }

  private async upload(kind: ImportKind, file: Express.Multer.File | undefined, body: UploadImportDto, shopId: string, userId: string) {
    if (!file) throw new BadRequestException('No file uploaded');
    // The bytes must be text the parser can read (a binary renamed .csv is refused and discarded).
    await assertImportFileContent(file);
    return this.imports.queueUpload(kind, file, { mode: body.mode ?? ImportMode.UPSERT, dryRun: body.dryRun === 'true' }, shopId, userId);
  }
}
