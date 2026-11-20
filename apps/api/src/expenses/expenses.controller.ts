import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req, Res, StreamableFile, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { createReadStream } from 'fs';
import type { Request, Response } from 'express';
import { ListQueryDto, PagedList } from '../common/pagination';
import { ExpenseActor, ExpensesService } from './expenses.service';
import { CreateExpenseDto, UpdateExpenseDto } from './dto/expense.dto';
import { FINANCE_ROLES, MANAGEMENT_ROLES } from '../auth/role-sets';
import { Roles } from '../auth/roles.decorator';
import { TenantContextService } from '../iam/tenant-context/tenant-context.service';
import { SafeUserDto } from '../users/dto/safe-user.dto';
import { FeatureGate } from '../common/features/feature-gate';
import { MAX_BILLING_DOCUMENT_BYTES } from '../storage/storage-security.constants';
import { expenseReceiptFileFilter, expenseReceiptUploadPolicy, validateUploadedFile } from '../storage/storage-upload.util';

/**
 * One receipt per request, held in memory (it is written once, under the
 * shop's storage root): the declared type and extension are filtered before
 * a byte arrives, a file over the cap is 413, and the handler checks the
 * bytes against the declared type (400 STORAGE_CONTENT_MISMATCH).
 */
const receiptUploadInterceptor = FileInterceptor('file', {
  fileFilter: expenseReceiptFileFilter,
  limits: { fileSize: MAX_BILLING_DOCUMENT_BYTES, files: 1, fields: 4, parts: 5, fieldSize: 1024 },
});

@Controller('expenses')
export class ExpensesController {
  constructor(
    private readonly expensesService: ExpensesService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** The recorder: a cash expense leaves their open drawer, and the audit row names them. */
  private actor(req: Request): ExpenseActor {
    const user = req.user as SafeUserDto;
    return { shopId: this.tenantContext.getShopId(), userId: user.id, ipAddress: req.ip ?? null };
  }

  @Roles(...FINANCE_ROLES)
  @Get()
  @PagedList()
  findAll(@Query() query: ListQueryDto) {
    return this.expensesService.findAll(query);
  }

  /** This month's figures over every expense of the shop, not over the loaded page (roadmap 6.7). */
  @Roles(...FINANCE_ROLES)
  @Get('summary')
  summary() {
    return this.expensesService.summary();
  }

  @Roles(...MANAGEMENT_ROLES)
  @Post()
  create(@Req() req: Request, @Body() dto: CreateExpenseDto) {
    return this.expensesService.create(dto, this.actor(req));
  }

  @Roles(...MANAGEMENT_ROLES)
  @Patch(':id')
  update(@Req() req: Request, @Param('id') id: string, @Body() dto: UpdateExpenseDto) {
    return this.expensesService.update(id, dto, this.actor(req));
  }

  /**
   * Attaches the expense's receipt (JPEG, PNG or PDF, field `file`), or
   * replaces the one attached: the earlier file is kept in `Deleted/`.
   */
  @Roles(...MANAGEMENT_ROLES)
  @FeatureGate('documents')
  @Post(':id/receipt')
  @HttpCode(200)
  @UseInterceptors(receiptUploadInterceptor)
  attachReceipt(@Req() req: Request, @Param('id') id: string, @UploadedFile() file: Express.Multer.File | undefined) {
    return this.expensesService.attachReceipt(id, validateUploadedFile(file, expenseReceiptUploadPolicy), this.actor(req));
  }

  /** The attached receipt's bytes under their stored type; 404 without one or for another shop's expense. */
  @Roles(...FINANCE_ROLES)
  @Get(':id/receipt')
  async receipt(@Param('id') id: string, @Res({ passthrough: true }) res: Response): Promise<StreamableFile> {
    const file = await this.expensesService.receipt(id);
    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('Content-Length', String(file.size));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Content-Disposition', `${file.mimeType.startsWith('image/') ? 'inline' : 'attachment'}; filename="${file.fileName}"`);
    return new StreamableFile(createReadStream(file.absolutePath));
  }

  @Roles(...MANAGEMENT_ROLES)
  @Delete(':id')
  remove(@Req() req: Request, @Param('id') id: string) {
    return this.expensesService.softDelete(id, this.actor(req));
  }
}
