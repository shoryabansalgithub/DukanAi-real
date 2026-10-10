import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Inject
} from '@nestjs/common';
import { StorageConfig } from '../config/domains/storage.config';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { S3_CLIENT } from './storage.constants';
import archiver from 'archiver';
import * as crypto from 'crypto';
import * as fs from 'fs-extra';
import * as path from 'path';
import { StorageCustomerDirectory } from './storage-security.constants';
import { DeleteStorageFileDto } from './dto/storage.dto';
import { StoragePathBuilder } from './storage-path.builder';
import { PrismaService } from '../prisma/prisma.service';
import { assertOwned } from '../prisma/tenant-ownership';

type AuditLevel = 'info' | 'error';

/** `path` is shop-relative (`Backups/Daily/backup_2026_10_03.zip`); responses never carry an absolute path (roadmap 7.5). */
export interface BackupResult {
  success: true;
  path: string;
  size: number;
}

/** Walk-in customers have no row; their evidence is filed under this id. */
export const WALK_IN_CUSTOMER_ID = 'Walk-in';

import { TenantContextService } from '../iam/tenant-context/tenant-context.service';

@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  constructor(
    private readonly storageConfig: StorageConfig,
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
    private readonly storagePathBuilder: StoragePathBuilder,
    @Inject(S3_CLIENT) private readonly s3Client: S3Client,
  ) {}

  private async ensureJsonFile(
    filePath: string,
    defaultData: Record<string, unknown> | unknown[],
  ): Promise<void> {
    if (!(await fs.pathExists(filePath))) {
      await fs.ensureDir(path.dirname(filePath));
      await this.writeJsonAtomic(filePath, defaultData);
    }
  }

  private getActor(): string {
    return this.tenantContext.getUserId();
  }

  /**
   * The customer named in the route must belong to the caller's shop
   * (roadmap 7.5): a foreign or unknown id is 404 like every other lookup of
   * another shop's row (`assertOwned`), so other shops' ids are never
   * confirmed. `Walk-in` names the no-row customer of counter sales.
   */
  private async validateCustomerOwnership(customerId: string): Promise<void> {
    if (customerId === WALK_IN_CUSTOMER_ID) return;
    await assertOwned(this.prisma, 'customer', customerId, this.tenantContext.getShopId());
  }

  /**
   * Billing evidence is written once (roadmap 7.5): the file is created
   * exclusively (`wx`), so a second upload for the same invoice or bill
   * cannot replace what was stored. Every target of a request is checked
   * before the first byte is written, so a duplicate leaves nothing behind;
   * the exclusive flag is the final guard against a concurrent write.
   */
  private async assertNoneExist(targets: string[]): Promise<void> {
    for (const target of targets) {
      if (await fs.pathExists(target)) {
        throw new ConflictException({
          message: `${path.basename(target)} is already stored; billing evidence is never overwritten`,
          code: 'STORAGE_EVIDENCE_EXISTS',
          details: { file: path.basename(target) },
        });
      }
    }
  }

  private async writeEvidence(target: string, data: Buffer | string): Promise<void> {
    try {
      await fs.writeFile(target, data, { flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new ConflictException({
          message: `${path.basename(target)} is already stored; billing evidence is never overwritten`,
          code: 'STORAGE_EVIDENCE_EXISTS',
          details: { file: path.basename(target) },
        });
      }
      // `wx` created the file before the write failed (a full volume: roadmap
      // 9.18). A truncated file left behind would answer every retry 409
      // STORAGE_EVIDENCE_EXISTS for good; it is ours, so it goes.
      await fs.remove(target).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Every file of one request, or none: the targets were checked absent
   * before the first byte, so a failure part-way (a full volume) removes the
   * files this request already wrote and the same request can be repeated.
   */
  private async writeAllEvidence(writes: Array<[string, Buffer | string]>): Promise<void> {
    const written: string[] = [];
    try {
      for (const [target, data] of writes) {
        await fs.ensureDir(path.dirname(target));
        await this.writeEvidence(target, data);
        written.push(target);
      }
    } catch (error) {
      await Promise.all(written.map((target) => fs.remove(target).catch(() => undefined)));
      throw error;
    }
  }

  /**
   * JSON indexes are replaced whole through a temporary file and a rename,
   * so a failed write (a full volume) leaves the previous index intact
   * instead of a truncated file that the next reader takes for empty.
   */
  private async writeJsonAtomic(target: string, data: unknown): Promise<void> {
    const temp = `${target}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
      await fs.writeFile(temp, JSON.stringify(data, null, 2));
      await fs.rename(temp, target);
    } catch (error) {
      await fs.remove(temp).catch(() => undefined);
      throw error;
    }
  }

  async logAction(
    action: string,
    level: AuditLevel = 'info',
  ): Promise<void> {
    const shopId = this.tenantContext.getShopId();
    const fileName = `${level}_${new Date().toISOString().split('T')[0]}.log`;
    const logFile = this.storagePathBuilder.getLogFile(shopId, fileName);
    await fs.ensureDir(path.dirname(logFile)).catch(() => undefined);

    const timestamp = new Date().toISOString();
    const actorInfo = ` actor=${this.getActor()}`;
    const logEntry = `[${timestamp}]${actorInfo} ${action}\n`;

    this.logger[level === 'info' ? 'log' : 'error'](`[Shop:${shopId}] ${action}${actorInfo}`);
    // The shop's action log is a convenience copy of the line above (which
    // reaches the log store): a full volume must not turn a document that
    // was stored into an error (roadmap 9.18).
    try {
      await fs.appendFile(logFile, logEntry);
    } catch (error) {
      this.logger.warn(`[Shop:${shopId}] storage action log not written: ${(error as Error).message}`);
    }
  }

  async createCustomerFolder(
    customerId: string,
  ): Promise<string> {
    const shopId = this.tenantContext.getShopId();
    await this.validateCustomerOwnership(customerId);
    const customerPath = this.storagePathBuilder.getCustomerDirectory(shopId, customerId, 'Profile');
    
    await fs.ensureDir(customerPath);

    const metaPath = path.join(customerPath, 'customer.meta.json');
    if (!(await fs.pathExists(metaPath))) {
      await this.writeJsonAtomic(metaPath, {
        customerId,
        createdAt: new Date().toISOString().split('T')[0],
        totalInvoices: 0,
      });
    }

    await this.logAction(`Created customer folder customer=${customerId}`, 'info');
    return this.storagePathBuilder.relativeToShop(shopId, customerPath);
  }

  async updateCustomerIndex(
    customerData: Record<string, unknown>,
  ): Promise<void> {
    const shopId = this.tenantContext.getShopId();
    const indexPath = this.storagePathBuilder.getSystemFile(shopId, 'customer_index.json');
    await fs.ensureDir(path.dirname(indexPath));
    
    const index = (await fs.readJson(indexPath).catch(() => [])) as Array<Record<string, unknown>>;
    const customerId = customerData.customerId as string;
    
    const existingIndex = index.findIndex((c) => c.customerId === customerId);
    
    const safeCustomerData = {
      ...customerData,
      updatedAt: new Date().toISOString(),
    };

    if (existingIndex >= 0) {
      index[existingIndex] = { ...index[existingIndex], ...safeCustomerData };
    } else {
      index.push({
        ...safeCustomerData,
        createdAt: new Date().toISOString(),
      });
    }

    await this.writeJsonAtomic(indexPath, index);
    await this.logAction(`Updated customer index customer=${customerId}`, 'info');
  }

  async storeInvoice(
    customerId: string,
    invoiceId: string,
    pdfFile: Express.Multer.File,
    jsonContent: Record<string, unknown>,
    thumbnailFile: Express.Multer.File | undefined,
  ): Promise<void> {
    const shopId = this.tenantContext.getShopId();
    await this.validateCustomerOwnership(customerId);

    const invoiceDir = this.storagePathBuilder.getCustomerDirectory(shopId, customerId, StorageCustomerDirectory.Invoices);
    await fs.ensureDir(invoiceDir);

    const baseName = `INV-${invoiceId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
    const pdfPath = path.join(invoiceDir, `${baseName}.pdf`);
    const jsonPath = path.join(invoiceDir, `${baseName}.json`);
    const previewPath = path.join(invoiceDir, `${baseName}-preview.jpg`);
    await this.assertNoneExist([pdfPath, jsonPath, ...(thumbnailFile ? [previewPath] : [])]);
    await this.writeAllEvidence([
      [pdfPath, pdfFile.buffer],
      [jsonPath, JSON.stringify(jsonContent, null, 2)],
      ...(thumbnailFile ? [[previewPath, thumbnailFile.buffer] as [string, Buffer]] : []),
    ]);

    const registryPath = this.storagePathBuilder.getSystemFile(shopId, 'invoice_registry.json');
    await fs.ensureDir(path.dirname(registryPath));
    const registry = (await fs.readJson(registryPath).catch(() => [])) as Array<Record<string, unknown>>;

    registry.push({
      invoiceId,
      customerId,
      status: typeof jsonContent.status === 'string' ? jsonContent.status : 'Generated',
      timestamp: new Date().toISOString(),
    });
    
    await this.writeJsonAtomic(registryPath, registry);
    await this.logAction(`Stored invoice invoice=${invoiceId} customer=${customerId}`, 'info');
  }

  async storeCapturedBill(
    customerId: string,
    billId: string,
    imageFile: Express.Multer.File,
    pdfFile: Express.Multer.File | undefined,
    ocrText: string | undefined,
    thumbnailFile: Express.Multer.File | undefined,
  ): Promise<void> {
    const shopId = this.tenantContext.getShopId();
    await this.validateCustomerOwnership(customerId);

    const baseName = `BILL-${billId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
    
    const photoDir = this.storagePathBuilder.getCustomerDirectory(shopId, customerId, StorageCustomerDirectory.OriginalPhotos);
    const billsDir = this.storagePathBuilder.getCustomerDirectory(shopId, customerId, StorageCustomerDirectory.Bills);
    const pdfDir = this.storagePathBuilder.getCustomerDirectory(shopId, customerId, StorageCustomerDirectory.PDFs);
    const ocrDir = this.storagePathBuilder.getCustomerDirectory(shopId, customerId, StorageCustomerDirectory.OCR);

    // Every file of this bill, checked before the first write (roadmap 7.5).
    const writes: Array<[string, Buffer | string]> = [
      [path.join(photoDir, `${baseName}.jpg`), imageFile.buffer],
      [path.join(billsDir, `${baseName}.jpg`), imageFile.buffer],
    ];
    if (thumbnailFile) writes.push([path.join(billsDir, `${baseName}-thumb.jpg`), thumbnailFile.buffer]);
    if (pdfFile) writes.push([path.join(pdfDir, `${baseName}.pdf`), pdfFile.buffer], [path.join(billsDir, `${baseName}.pdf`), pdfFile.buffer]);
    if (ocrText) writes.push([path.join(ocrDir, `${baseName}.txt`), ocrText], [path.join(billsDir, `${baseName}.txt`), ocrText]);

    await this.assertNoneExist(writes.map(([target]) => target));
    await this.writeAllEvidence(writes);

    await this.logAction(`Stored captured bill bill=${billId} customer=${customerId}`, 'info');
  }

  async storePayment(
    customerId: string,
    paymentData: Record<string, unknown>,
  ): Promise<void> {
    const shopId = this.tenantContext.getShopId();
    await this.validateCustomerOwnership(customerId);

    const paymentsDir = this.storagePathBuilder.getCustomerDirectory(shopId, customerId, StorageCustomerDirectory.Payments);
    await fs.ensureDir(paymentsDir);

    const dateStr = new Date().toISOString().split('T')[0].replace(/-/g, '_');
    const paymentId = crypto.randomBytes(8).toString('hex');
    const fileName = `PAYMENT-${dateStr}-${paymentId}.json`;

    await this.writeAllEvidence([[path.join(paymentsDir, fileName), JSON.stringify(paymentData, null, 2)]]);
    await this.logAction(`Stored payment customer=${customerId} file=${fileName}`, 'info');
  }

  async storeStatement(
    customerId: string,
    pdfFile: Express.Multer.File,
  ): Promise<void> {
    const shopId = this.tenantContext.getShopId();
    await this.validateCustomerOwnership(customerId);

    const statementsDir = this.storagePathBuilder.getCustomerDirectory(shopId, customerId, StorageCustomerDirectory.Statements);
    await fs.ensureDir(statementsDir);

    // One file per generated statement: a statement regenerated for the same
    // month lands beside the earlier one instead of replacing it (roadmap 7.5).
    const month = new Date().toLocaleString('default', { month: 'short', year: 'numeric' }).toUpperCase().replace(' ', '-');
    const fileName = `STATEMENT-${month}-${new Date().toISOString().replace(/[:.]/g, '').replace('T', '-').slice(0, 15)}-${crypto.randomBytes(4).toString('hex')}.pdf`;

    await this.writeEvidence(path.join(statementsDir, fileName), pdfFile.buffer);
    await this.logAction(`Stored statement customer=${customerId} file=${fileName}`, 'info');
  }

  async softDeleteFile(
    customerId: string,
    dto: DeleteStorageFileDto,
  ): Promise<{ success: true; newPath: string }> {
    const shopId = this.tenantContext.getShopId();
    await this.validateCustomerOwnership(customerId);

    // Reconstruct the datePath if needed, or if we removed datePath from DB logic, we just find it.
    // Assuming the DTO still passes datePath for now if it exists, or we search inside the folder.
    // For extreme safety, we will just use the builder to get the base category folder, then append the filename.
    const originalDir = this.storagePathBuilder.getCustomerDirectory(shopId, customerId, dto.category);
    
    // Anti-traversal check on filename
    const safeFileName = dto.fileName.replace(/[^a-zA-Z0-9_.-]/g, '');
    const originalFilePath = path.join(originalDir, safeFileName); // Note: we are ignoring datePath to prevent traversal if it existed.

    if (!(await fs.pathExists(originalFilePath))) {
      throw new NotFoundException('File was not found in allowed storage scope');
    }

    const stat = await fs.stat(originalFilePath);
    if (!stat.isFile()) {
      throw new BadRequestException('Only files can be deleted');
    }

    const deletedFilePath = this.storagePathBuilder.getDeletedFileTarget(shopId, safeFileName);
    await fs.ensureDir(path.dirname(deletedFilePath));

    try {
      await fs.move(originalFilePath, deletedFilePath, { overwrite: false });
      await this.logAction(`Soft deleted file customer=${customerId} category=${dto.category} file=${safeFileName}`, 'info');
      return { success: true, newPath: this.storagePathBuilder.relativeToShop(shopId, deletedFilePath) };
    } catch (error) {
      await this.logAction(`Failed to delete file customer=${customerId} file=${safeFileName}`, 'error');
      throw error;
    }
  }

  async createBackup(
    type: string = 'Daily',
  ): Promise<BackupResult> {
    const shopId = this.tenantContext.getShopId();
    const backupDir = this.storagePathBuilder.getBackupDirectory(shopId, type);
    await fs.ensureDir(backupDir);

    const dateStr = new Date().toISOString().split('T')[0].replace(/-/g, '_');
    const backupPath = path.join(backupDir, `backup_${dateStr}.zip`);
    const shopRoot = this.storagePathBuilder.getShopRoot(shopId);

    return new Promise<BackupResult>((resolve, reject) => {
      const output = fs.createWriteStream(backupPath);
      const archive = archiver('zip', { zlib: { level: 9 } });

      output.on('close', () => {
        const size = archive.pointer();
        this.logAction(`Created backup type=${type} file=${path.basename(backupPath)} size=${size}`, 'info')
          .then(() => resolve({ success: true, path: this.storagePathBuilder.relativeToShop(shopId, backupPath), size }))
          .catch(reject);
      });

      // A failed archive (a full volume) leaves no partial zip that looks like a backup.
      const fail = (error: Error) => {
        output.destroy();
        void fs.remove(backupPath).catch(() => undefined);
        void this.logAction(`Backup error type=${type}: ${error.message}`, 'error').finally(() => reject(error));
      };
      output.on('error', fail);
      archive.on('error', fail);

      archive.pipe(output);

      // Only zip the specific shop's data
      for (const dir of ['Customers', 'System', 'Logs']) {
        const dirPath = path.join(shopRoot, dir);
        if (fs.existsSync(dirPath)) {
          archive.directory(dirPath, dir);
        }
      }

      archive.finalize().catch(reject);
    });
  }

  async uploadFileToCloud(
    file: Express.Multer.File,
    folder: string = 'general',
  ): Promise<string> {
    const shopId = this.tenantContext.getShopId();
    const bucketName = this.storageConfig.s3Bucket;
    if (!bucketName) {
      throw new InternalServerErrorException('Cloud storage is not configured');
    }

    const safeOriginalName = file.originalname.replace(/[^a-zA-Z0-9_.-]/g, '');
    const uniqueId = crypto.randomBytes(8).toString('hex');
    const parsed = path.parse(safeOriginalName);
    const sanitizedName = parsed.name;
    const ext = parsed.ext.toLowerCase();
    
    const prefix = this.storagePathBuilder.getS3Prefix(shopId, folder);
    const objectKey = `${prefix}/${sanitizedName}-${uniqueId}${ext}`;

    const command = new PutObjectCommand({
      Bucket: bucketName,
      Key: objectKey,
      Body: file.buffer,
      ContentType: file.mimetype,
    });

    try {
      await this.s3Client.send(command);
      await this.logAction(`Uploaded file to cloud key=${objectKey}`, 'info');

      const endpoint = this.storageConfig.s3Endpoint;
      const publicUrlBase = this.storageConfig.s3PublicUrl;

      if (publicUrlBase) {
        return `${publicUrlBase}/${objectKey}`;
      }

      const domain = endpoint ? new URL(endpoint).hostname : 's3.amazonaws.com';
      return `https://${bucketName}.${domain}/${objectKey}`;
    } catch (error) {
      await this.logAction(`Cloud upload failed key=${objectKey}`, 'error');
      throw error;
    }
  }
}
