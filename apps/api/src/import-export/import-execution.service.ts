import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ParsingEngineService } from './parsing-engine.service';
import { JobStatus, ProductUnit } from '@prisma/client';
import { ProductValidationService } from '../product-validation/product-validation.service';

@Injectable()
export class ImportExecutionService {
  private readonly logger = new Logger(ImportExecutionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly parsingEngine: ParsingEngineService,
    private readonly validationService: ProductValidationService,
  ) {}

  /**
   * Processes the import job sequentially in chunks to prevent memory bloat.
   */
  async processJob(jobId: string) {
    const job = await this.prisma.importJob.findUnique({ where: { id: jobId } });
    if (!job) return;

    await this.updateJobStatus(jobId, 'PROCESSING');
    
    try {
      const rows = await this.parsingEngine.parseFile(job.fileUrl, job.format);
      
      // Update total rows
      await this.prisma.importJob.update({
        where: { id: jobId },
        data: { totalRows: rows.length, startedAt: new Date() }
      });

      let validCount = 0;
      let errorCount = 0;
      let createdCount = 0;
      let updatedCount = 0;
      let skippedCount = 0;

      // Processing rows sequentially for safe transactional boundary
      for (let i = 0; i < rows.length; i++) {
        const rawRow = rows[i];
        
        // Ensure SKU is present
        const sku = rawRow['SKU'] || rawRow['sku'];
        if (!sku) {
          errorCount++;
          await this.logRowError(jobId, i + 1, rawRow, 'SKU is strictly required');
          continue;
        }

        const name = rawRow['Name'] || rawRow['name'];
        if (!name) {
          errorCount++;
          await this.logRowError(jobId, i + 1, rawRow, 'Name is required');
          continue;
        }

        try {
          // Wrap in a transaction to handle optimistic rollbacks
          await this.prisma.$transaction(async (tx) => {
            const existingProduct = await tx.product.findFirst({
              where: { shopId: job.shopId, sku, isDeleted: false },
              include: { variants: true } // Need to check variant SKUs too in real logic
            });

            // Handle Import Modes
            if (job.mode === 'CREATE_ONLY' && existingProduct) {
              skippedCount++;
              throw new Error(`SKU ${sku} already exists and mode is CREATE_ONLY`);
            }
            if (job.mode === 'UPDATE_ONLY' && !existingProduct) {
              skippedCount++;
              throw new Error(`SKU ${sku} not found and mode is UPDATE_ONLY`);
            }

            if (existingProduct) {
              // Rollback snapshot
              await tx.rollbackRecord.create({
                data: {
                  shopId: job.shopId,
                  entityId: existingProduct.id,
                  entityType: 'PRODUCT',
                  action: 'IMPORT_UPDATE',
                  jobId: job.id,
                  previousData: JSON.stringify(existingProduct)
                }
              });

              // Apply Update
              await tx.product.update({
                where: { id: existingProduct.id },
                data: {
                  name: name || existingProduct.name,
                  sellingPrice: rawRow['Price'] || existingProduct.sellingPrice,
                }
              });
              updatedCount++;
            } else {
              // Create New
              const newProduct = await tx.product.create({
                data: {
                  shopId: job.shopId,
                  sku: sku,
                  name: name,
                  sellingPrice: rawRow['Price'] || 0,
                  costPrice: rawRow['Cost'] || 0,
                  mrp: rawRow['MRP'] || 0,
                  wholesalePrice: rawRow['WholesalePrice'] || rawRow['Price'] || 0,
                  unit: ProductUnit.PCS, // default
                  categoryId: rawRow['CategoryId'] || undefined
                }
              });
              
              await tx.productVariant.create({
                data: {
                  shopId: job.shopId,
                  productId: newProduct.id,
                  sku: sku,
                  sellingPrice: newProduct.sellingPrice,
                  costPrice: newProduct.costPrice,
                  mrp: newProduct.mrp
                }
              });

              // Add Rollback entry for creation deletion
              await tx.rollbackRecord.create({
                data: {
                  shopId: job.shopId,
                  entityId: newProduct.id,
                  entityType: 'PRODUCT',
                  action: 'IMPORT_CREATE',
                  jobId: job.id,
                }
              });
              createdCount++;
            }

            validCount++;
            await this.logRowSuccess(jobId, i + 1, rawRow, existingProduct ? 'UPDATED' : 'CREATED');
          });

        } catch (err) {
          errorCount++;
          await this.logRowError(jobId, i + 1, rawRow, (err as Error).message);
        }
      }

      // Finish Job
      const finalStatus = errorCount > 0 ? (validCount > 0 ? 'PARTIAL_SUCCESS' : 'FAILED') : 'COMPLETED';
      
      await this.prisma.importJob.update({
        where: { id: jobId },
        data: {
          status: finalStatus,
          validRows: validCount,
          errorRows: errorCount,
          createdCount,
          updatedCount,
          skippedCount,
          completedAt: new Date()
        }
      });
      
    } catch (err) {
      this.logger.error(`Import processing failed: ${(err as Error).message}`);
      await this.updateJobStatus(jobId, 'FAILED');
    }
  }

  private async updateJobStatus(jobId: string, status: JobStatus) {
    await this.prisma.importJob.update({ where: { id: jobId }, data: { status } });
  }

  private async logRowError(jobId: string, rowNumber: number, data: any, message: string) {
    await this.prisma.importJobRow.create({
      data: {
        importJobId: jobId,
        rowNumber,
        rawData: JSON.stringify(data),
        status: 'ERROR',
        errors: JSON.stringify([{ message }])
      }
    });
  }

  private async logRowSuccess(jobId: string, rowNumber: number, data: any, actionTaken: string) {
    await this.prisma.importJobRow.create({
      data: {
        importJobId: jobId,
        rowNumber,
        rawData: JSON.stringify(data),
        status: 'SUCCESS',
        actionTaken
      }
    });
  }
}
