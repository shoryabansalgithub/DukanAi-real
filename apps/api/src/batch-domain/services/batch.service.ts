import { Injectable, Logger, ConflictException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateBatchDto, AddBatchStockDto } from '../dto/batch.dto';
import { BatchStatus } from '@prisma/client';
import { assertOwned } from '../../prisma/tenant-ownership';
import { ListQueryDto, pageArgs } from '../../common/pagination';

@Injectable()
export class BatchService {
  private readonly logger = new Logger(BatchService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Returns only batches that belong to the requesting shop. Batch quantities
   * are derived from their physical-bin allocations rather than client data.
   */
  async listBatches(shopId: string, query?: ListQueryDto) {
    const { skip, take } = pageArgs(query);
    const where = { shopId };
    const [batches, total] = await Promise.all([
      this.prisma.batch.findMany({
        where,
        include: {
          product: { select: { name: true, sku: true } },
          batchStocks: { select: { quantity: true, reservedQuantity: true } },
        },
        orderBy: [{ expiryDate: 'asc' }, { createdAt: 'desc' }, { id: 'asc' }],
        skip,
        take,
      }),
      this.prisma.batch.count({ where }),
    ]);

    const items = batches.map((batch) => ({
      id: batch.id,
      product: batch.product.name,
      sku: batch.product.sku,
      batchNo: batch.batchNumber,
      mfgDate: batch.mfgDate,
      expDate: batch.expiryDate,
      quantity: batch.batchStocks.reduce(
        (total, stock) => total + Number(stock.quantity) - Number(stock.reservedQuantity),
        0,
      ),
      supplierLotNumber: batch.supplierLotNumber,
      status: batch.status,
    }));
    return { items, total, skip, take };
  }

  /**
   * Registers a new Batch (Lot) in the system.
   */
  async createBatch(shopId: string, dto: CreateBatchDto) {
    await assertOwned(this.prisma, 'product', dto.productId, shopId);
    await assertOwned(this.prisma, 'productVariant', dto.variantId, shopId);
    const existing = await this.prisma.batch.findUnique({
      where: { shopId_batchNumber: { shopId, batchNumber: dto.batchNumber } }
    });

    if (existing) {
      throw new ConflictException(`Batch number ${dto.batchNumber} already exists.`);
    }

    const batch = await this.prisma.batch.create({
      data: {
        shopId,
        productId: dto.productId,
        variantId: dto.variantId,
        batchNumber: dto.batchNumber,
        supplierLotNumber: dto.supplierLotNumber,
        mfgDate: dto.mfgDate ? new Date(dto.mfgDate) : null,
        expiryDate: dto.expiryDate ? new Date(dto.expiryDate) : null,
        type: dto.type,
        status: BatchStatus.AVAILABLE
      }
    });

    this.logger.log(`Created new batch ${batch.batchNumber} for product ${batch.productId}`);
    return batch;
  }

  /**
   * Links a batch to a specific physical InventoryItem (Bin)
   */
  async addBatchStock(shopId: string, batchId: string, dto: AddBatchStockDto) {
    return this.prisma.$transaction(async (tx) => {
      await assertOwned(tx, 'batch', batchId, shopId);
      await assertOwned(tx, 'inventoryItem', dto.inventoryItemId, shopId);

      const batchStock = await tx.batchStock.upsert({
        where: {
          shopId_batchId_inventoryItemId: {
            shopId,
            batchId,
            inventoryItemId: dto.inventoryItemId
          }
        },
        update: {
          quantity: { increment: dto.quantity }
        },
        create: {
          shopId,
          batchId,
          inventoryItemId: dto.inventoryItemId,
          quantity: dto.quantity
        }
      });

      // We DO NOT update `InventoryItem.onHand` here. 
      // Physical on-hand is managed strictly by the Stock Ledger (Phase 3.2.3).
      // BatchStock is merely a traceability layer layered ON TOP of the physical bin.
      
      return batchStock;
    });
  }
}
