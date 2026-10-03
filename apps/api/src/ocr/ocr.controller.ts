import { Controller, Post, UseInterceptors, UploadedFile, Body, BadRequestException } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { OcrService } from './ocr.service';
import { Roles } from '../auth/roles.decorator';
import { MANAGEMENT_ROLES } from '../auth/role-sets';
import { CurrentShop } from '../iam/decorators/current-shop.decorator';
import { ScanBillDto } from './dto/scan-bill.dto';

@ApiTags('ocr')
@ApiBearerAuth()
@Controller('ocr')
export class OcrController {
  constructor(private readonly ocrService: OcrService) {}

  /** Upload limits and the image-only filter come from `OcrModule`'s multer registration (roadmap 4.4). */
  @Roles(...MANAGEMENT_ROLES)
  @Post('scan-bill')
  @UseInterceptors(FileInterceptor('file'))
  async scanHandwrittenBill(@CurrentShop() shopId: string, @UploadedFile() file: Express.Multer.File | undefined, @Body() body: ScanBillDto) {
    if (!file) {
      throw new BadRequestException({ message: 'No file provided; send the image as the "file" part.', code: 'OCR_FILE_MISSING' });
    }
    return this.ocrService.processDocument(shopId, file.buffer, body.documentType ?? 'BILL');
  }
}
