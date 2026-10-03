import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { OcrService } from './ocr.service';
import { OcrController } from './ocr.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { OcrFeatureConfig } from '../config/domains/features/ocr-feature.config';
import { ocrImageFileFilter } from './ocr-upload';

/**
 * The upload limits of `POST /ocr/scan-bill` come from the validated OCR
 * configuration (`OCR_MAX_IMAGE_BYTES`), so the module registers multer
 * asynchronously and the controller's `FileInterceptor` inherits them.
 */
@Module({
  imports: [
    PrismaModule,
    MulterModule.registerAsync({
      useFactory: (ocr: OcrFeatureConfig) => ({
        fileFilter: ocrImageFileFilter,
        limits: { fileSize: ocr.maxImageBytes, files: 1, fields: 4, parts: 5 },
      }),
      inject: [OcrFeatureConfig],
    }),
  ],
  controllers: [OcrController],
  providers: [OcrService],
  exports: [OcrService],
})
export class OcrModule {}
