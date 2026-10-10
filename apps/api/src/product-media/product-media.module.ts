import { Module } from '@nestjs/common';
import { ProductMediaService } from './product-media.service';
import { ProductMediaController } from './product-media.controller';
import { UploadEngineService } from './upload-engine.service';
import { DeduplicationService } from './deduplication.service';
import { CdnManagerService } from './cdn-manager.service';
import { CompressionEngineService } from './compression-engine.service';
import { MediaProcessorWorker } from './media-processor.worker';
import { BullModule } from '@nestjs/bullmq';
import { MulterModule } from '@nestjs/platform-express';
import { PrismaModule } from '../prisma/prisma.module';
import { UploadConfig } from '../config/domains/upload.config';
import { buildUploadOptions } from '../common/upload/upload-options';
import { mediaUploadPolicy } from './upload-engine.service';

@Module({
  imports: [
    PrismaModule,
    BullModule.registerQueue({
      name: 'media-processing',
    }),
    // Roadmap 5.1: every media upload streams to the temp directory under a hard size cap and a declared-type filter.
    MulterModule.registerAsync({
      useFactory: (upload: UploadConfig) => buildUploadOptions(mediaUploadPolicy(upload.maxMediaBytes), upload.tempDir),
      inject: [UploadConfig],
    }),
  ],
  controllers: [ProductMediaController],
  providers: [
    ProductMediaService,
    UploadEngineService,
    DeduplicationService,
    CdnManagerService,
    CompressionEngineService,
    MediaProcessorWorker,
  ],
  exports: [ProductMediaService],
})
export class ProductMediaModule {}
