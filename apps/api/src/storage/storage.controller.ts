import {
  Body,
  Controller,
  Delete,
  Param,
  Post,
  Request,
  UploadedFiles,
  UseInterceptors,
  BadRequestException,
} from '@nestjs/common';
import { AnyFilesInterceptor } from '@nestjs/platform-express';
import { Role } from '@prisma/client';
import { Roles } from '../auth/roles.decorator';
import {
  MAX_CLOUD_UPLOAD_BYTES,
  MAX_BILLING_DOCUMENT_BYTES,
  MAX_FILES_PER_REQUEST,
} from './storage-security.constants';
import {
  assertImageFile,
  assertOptionalImageFile,
  assertOptionalPdfFile,
  assertPdfFile,
  cloudUploadPolicy,
  secureFileFilter,
  validateUploadedFile,
} from './storage-upload.util';
import {
  BackupStorageDto,
  CloudUploadDto,
  CreateCustomerFolderDto,
  DeleteStorageFileDto,
  StoreCapturedBillBodyDto,
  StoreInvoiceBodyDto,
  StorePaymentDto,
} from './dto/storage.dto';

import { StorageService } from './storage.service';

// Roadmap 5.1: hard limits on every part of the request, not only the file size.
const billingUploadInterceptor = AnyFilesInterceptor({
  fileFilter: secureFileFilter,
  limits: {
    fileSize: MAX_BILLING_DOCUMENT_BYTES,
    files: MAX_FILES_PER_REQUEST,
    fields: 8,
    parts: MAX_FILES_PER_REQUEST + 8,
    fieldSize: 16 * 1024,
  },
});

const cloudUploadInterceptor = AnyFilesInterceptor({
  fileFilter: secureFileFilter,
  limits: {
    fileSize: MAX_CLOUD_UPLOAD_BYTES,
    files: 1,
    fields: 8,
    parts: 9,
    fieldSize: 16 * 1024,
  },
});

function findFile(
  files: Express.Multer.File[] | undefined,
  fieldName: string,
): Express.Multer.File | undefined {
  return files?.find((file) => file.fieldname === fieldName);
}

function parseJsonObject(rawJson: string | undefined): Record<string, unknown> {
  if (!rawJson) return {};

  try {
    const parsed: unknown = JSON.parse(rawJson);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new BadRequestException('Invalid JSON payload');
  }
}

/**
 * Every storage endpoint is authenticated and role-checked. Authentication alone
 * is not enough for storage APIs: a valid CASHIER should be able to upload
 * billing evidence, but must never be able to delete files or trigger backups.
 *
 * Rate limiting recommendation: wire ThrottlerModule globally and apply a
 * stricter @Throttle policy here, especially for upload, backup, and delete.
 */
@Controller('storage')
export class StorageController {
  constructor(private readonly storageService: StorageService) {}

  @Post('customers')
  @Roles(Role.OWNER, Role.ADMIN, Role.SUPER_ADMIN, Role.MANAGER)
  async createCustomerFolder(
    @Body() body: CreateCustomerFolderDto,
  ) {
    const folderPath = await this.storageService.createCustomerFolder(
      body.customerId,
    );

    if (body.customerData) {
      await this.storageService.updateCustomerIndex(body.customerData);
    }

    return { success: true, path: folderPath };
  }

  @Post('invoices/:customerId/:invoiceId')
  @Roles(Role.CASHIER, Role.MANAGER, Role.ADMIN, Role.OWNER, Role.SUPER_ADMIN)
  @UseInterceptors(billingUploadInterceptor)
  async storeInvoice(
    @Param('customerId') customerId: string,
    @Param('invoiceId') invoiceId: string,
    @UploadedFiles() files: Express.Multer.File[] | undefined,
    @Body() body: StoreInvoiceBodyDto,
  ) {
    const pdfFile = assertPdfFile(findFile(files, 'pdf'));
    const thumbnailFile = assertOptionalImageFile(findFile(files, 'thumbnail'));
    const jsonContent = parseJsonObject(body.jsonContent);

    await this.storageService.storeInvoice(
      customerId,
      invoiceId,
      pdfFile,
      jsonContent,
      thumbnailFile,
    );

    return { success: true };
  }

  @Post('bills/:customerId/:billId')
  @Roles(Role.CASHIER, Role.MANAGER, Role.ADMIN, Role.OWNER, Role.SUPER_ADMIN)
  @UseInterceptors(billingUploadInterceptor)
  async storeCapturedBill(
    @Param('customerId') customerId: string,
    @Param('billId') billId: string,
    @UploadedFiles() files: Express.Multer.File[] | undefined,
    @Body() body: StoreCapturedBillBodyDto,
  ) {
    const imageFile = assertImageFile(findFile(files, 'image'));
    const pdfFile = assertOptionalPdfFile(findFile(files, 'pdf'));
    const thumbnailFile = assertOptionalImageFile(findFile(files, 'thumbnail'));

    await this.storageService.storeCapturedBill(
      customerId,
      billId,
      imageFile,
      pdfFile,
      body.ocrText,
      thumbnailFile,
    );

    return { success: true };
  }

  @Post('payments/:customerId')
  @Roles(Role.CASHIER, Role.MANAGER, Role.ADMIN, Role.OWNER, Role.SUPER_ADMIN)
  async storePayment(
    @Param('customerId') customerId: string,
    @Body() body: StorePaymentDto,
  ) {
    await this.storageService.storePayment(customerId, body.paymentData);
    return { success: true };
  }

  @Post('statements/:customerId')
  @Roles(Role.CASHIER, Role.MANAGER, Role.ADMIN, Role.OWNER, Role.SUPER_ADMIN)
  @UseInterceptors(billingUploadInterceptor)
  async storeStatement(
    @Param('customerId') customerId: string,
    @UploadedFiles() files: Express.Multer.File[] | undefined,
  ) {
    const pdfFile = assertPdfFile(findFile(files, 'pdf'));
    await this.storageService.storeStatement(customerId, pdfFile);
    return { success: true };
  }

  @Delete('files/:customerId')
  @Roles(Role.OWNER, Role.ADMIN, Role.SUPER_ADMIN)
  async deleteFile(
    @Param('customerId') customerId: string,
    @Body() body: DeleteStorageFileDto,
  ) {
    return this.storageService.softDeleteFile(customerId, body);
  }

  @Post('backup')
  @Roles(Role.OWNER, Role.ADMIN, Role.SUPER_ADMIN)
  async triggerBackup(
    @Body() body: BackupStorageDto,
  ) {
    return this.storageService.createBackup(body.type);
  }

  @Post('cloud/upload')
  @Roles(Role.OWNER, Role.ADMIN, Role.SUPER_ADMIN)
  @UseInterceptors(cloudUploadInterceptor)
  async uploadToCloud(
    @UploadedFiles() files: Express.Multer.File[] | undefined,
    @Body() body: CloudUploadDto,
  ) {
    const file = validateUploadedFile(files?.[0], cloudUploadPolicy);

    const url = await this.storageService.uploadFileToCloud(
      file,
      body.folder,
    );

    return { success: true, url };
  }
}
