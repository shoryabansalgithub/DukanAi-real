import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { MulterModule } from '@nestjs/platform-express';
import { UploadConfig } from '../config/domains/upload.config';
import { buildUploadOptions } from '../common/upload/upload-options';
import { importUploadPolicy } from './import-upload';
import { PrismaModule } from '../prisma/prisma.module';
import { ProductValidationModule } from '../product-validation/product-validation.module';
import { ImportExportService } from './import-export.service';
import { ImportExportController } from './import-export.controller';
import { FileStorageService } from './file-storage.service';
import { ParsingEngineService } from './parsing-engine.service';
import { ImportExecutionService } from './import-execution.service';
import { ImportWorker } from './import.worker';

@Module({
  imports: [
    PrismaModule,
    ProductValidationModule,
    BullModule.registerQueue({
      name: 'import-job',
    }),
    // Roadmap 5.1: import files stream to the temp directory under a hard size cap; only CSV / JSON pass the filter.
    MulterModule.registerAsync({
      useFactory: (upload: UploadConfig) => buildUploadOptions(importUploadPolicy(upload.maxImportBytes), upload.tempDir),
      inject: [UploadConfig],
    }),
  ],
  controllers: [ImportExportController],
  providers: [
    ImportExportService,
    FileStorageService,
    ParsingEngineService,
    ImportExecutionService,
    ImportWorker,
  ],
  exports: [ImportExecutionService],
})
export class ImportExportModule {}
