import { Controller, Post, Get, Body, Param, BadRequestException, UseInterceptors, UploadedFile, NotFoundException } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { UploadCleanupInterceptor } from '../common/upload/upload-cleanup.interceptor';
import { FileStorageService } from './file-storage.service';
import { PrismaService } from '../prisma/prisma.service';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { CurrentShop } from '../iam/decorators';
import { ImportExportFeatureConfig } from '../config/domains/features/import-export-feature.config';
import { MANAGEMENT_ROLES } from '../auth/role-sets';
import { Roles } from '../auth/roles.decorator';
import { UploadImportDto } from './dto/upload-import.dto';
import { IMPORT_JOB_QUEUE, ImportJobData, PROCESS_IMPORT_JOB } from './import.worker';
import { assertImportFileContent, importFormatOf } from './import-upload';

/** Product imports (roadmap 4.1): the shop comes from the verified session, the job carries it to the worker. */
@Controller('imports')
export class ImportExportController {
  constructor(
    private readonly storageService: FileStorageService,
    private readonly prisma: PrismaService,
    @InjectQueue(IMPORT_JOB_QUEUE) private readonly importQueue: Queue<ImportJobData>,
    private readonly importExportFeatureConfig: ImportExportFeatureConfig,
  ) {}

  @Roles(...MANAGEMENT_ROLES)
  @Post('products/upload')
  @UseInterceptors(UploadCleanupInterceptor, FileInterceptor('file'))
  async uploadImportFile(@UploadedFile() file: Express.Multer.File | undefined, @Body() body: UploadImportDto, @CurrentShop() shopId: string) {
    if (!file) throw new BadRequestException('No file uploaded');
    // The bytes must be text the parser can read (a binary renamed .csv is refused and discarded).
    await assertImportFileContent(file);

    const filePath = await this.storageService.saveImportFile(shopId, file);

    const job = await this.prisma.importJob.create({
      data: {
        shopId,
        fileName: file.originalname,
        fileSize: file.size,
        fileUrl: filePath,
        format: importFormatOf(file.originalname),
        mode: body.mode ?? 'UPSERT',
        status: 'PENDING',
      },
    });

    // Queue for background execution; the worker runs under this shop's tenant context.
    await this.importQueue.add(PROCESS_IMPORT_JOB, { jobId: job.id, shopId });

    return { message: 'Import queued successfully', jobId: job.id };
  }

  @Get('jobs/:id')
  async getJobStatus(@Param('id') id: string, @CurrentShop() shopId: string) {
    const job = await this.prisma.importJob.findFirst({ where: { id, shopId } });
    if (!job) throw new NotFoundException({ message: 'Import job not found', code: 'IMPORT_JOB_NOT_FOUND' });
    return job;
  }

  @Get('jobs/:id/errors')
  async getJobErrors(@Param('id') id: string, @CurrentShop() shopId: string) {
    const job = await this.prisma.importJob.findFirst({ where: { id, shopId }, select: { id: true } });
    if (!job) throw new NotFoundException({ message: 'Import job not found', code: 'IMPORT_JOB_NOT_FOUND' });
    return this.prisma.importJobRow.findMany({
      where: { importJobId: id, status: 'ERROR' },
      orderBy: { createdAt: 'desc' },
      take: this.importExportFeatureConfig.exportListLimit,
    });
  }
}
