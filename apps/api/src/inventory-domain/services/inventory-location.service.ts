import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

type Db = Prisma.TransactionClient | PrismaService;

export const DEFAULT_WAREHOUSE_CODE = 'DEFAULT';
export const DEFAULT_BIN_CODE = 'DEFAULT_BIN';

/**
 * Single authority for "where does stock live" in the POS.
 *
 * `InventoryItem.locationId` is a foreign key to `Location.id`. Every caller
 * of the mutation engine must pass a real Location id; this service resolves
 * (and lazily creates) the shop's default warehouse + bin, or the default bin
 * of an explicit warehouse, so the sale path, the goods-receipt path and the
 * manual-adjustment path all read and write the same InventoryItem row.
 *
 * Creation is serialised under a `SELECT ... FOR UPDATE` on the Shop row:
 * the unique keys on Warehouse and Location include the nullable `deletedAt`
 * column, which MySQL treats as distinct in unique indexes, so the database
 * alone does not stop two concurrent first requests from each creating a
 * "DEFAULT" warehouse. The lock does. Lookups are deterministic (oldest row
 * wins) so every process resolves the same location.
 *
 * Warehouse and Location are not covered by the tenant Prisma extension, so
 * every query here filters `shopId` explicitly.
 */
@Injectable()
export class InventoryLocationService {
  private readonly logger = new Logger(InventoryLocationService.name);
  private readonly saleLocationCache = new Map<string, string>();
  private readonly warehouseBinCache = new Map<string, string>();

  constructor(private readonly prisma: PrismaService) {}

  /** Location used by POS sales and returns for the shop. */
  async resolveSaleLocation(db: Db, shopId: string): Promise<string> {
    const cached = this.saleLocationCache.get(shopId);
    if (cached) {
      const stillThere = await db.location.findFirst({ where: { id: cached, shopId, isDeleted: false }, select: { id: true } });
      if (stillThere) return cached;
      this.saleLocationCache.delete(shopId);
    }

    // Fast path: both rows exist (the common case after the first request).
    const existing = await this.findDefaultBin(db, shopId);
    if (existing) {
      this.saleLocationCache.set(shopId, existing);
      return existing;
    }

    const locationId = await this.withShopLock(db, shopId, async (tx) => {
      const again = await this.findDefaultBin(tx, shopId);
      if (again) return again;
      const warehouseId = await this.ensureDefaultWarehouse(tx, shopId);
      return this.ensureBin(tx, shopId, warehouseId, DEFAULT_BIN_CODE);
    });
    this.saleLocationCache.set(shopId, locationId);
    return locationId;
  }

  /** Default bin of an explicit warehouse (goods receipts, purchase returns). */
  async resolveWarehouseBin(db: Db, shopId: string, warehouseId?: string | null): Promise<string> {
    if (!warehouseId) return this.resolveSaleLocation(db, shopId);

    const key = `${shopId}:${warehouseId}`;
    const cached = this.warehouseBinCache.get(key);
    if (cached) return cached;

    const warehouse = await db.warehouse.findFirst({ where: { id: warehouseId, shopId, isDeleted: false }, select: { id: true } });
    if (!warehouse) {
      this.logger.warn(`Warehouse ${warehouseId} not found for shop ${shopId}; falling back to the sale location`);
      return this.resolveSaleLocation(db, shopId);
    }
    const found = await this.findBin(db, shopId, warehouse.id, DEFAULT_BIN_CODE);
    const locationId = found ?? (await this.withShopLock(db, shopId, (tx) => this.ensureBin(tx, shopId, warehouse.id, DEFAULT_BIN_CODE)));
    this.warehouseBinCache.set(key, locationId);
    return locationId;
  }

  /** True when `locationId` is a real Location of this shop. */
  async isValidLocation(db: Db, shopId: string, locationId: string): Promise<boolean> {
    const row = await db.location.findFirst({ where: { id: locationId, shopId, isDeleted: false }, select: { id: true } });
    return !!row;
  }

  /**
   * Runs `fn` while holding the Shop row lock. Inside a caller's transaction
   * the lock joins that transaction; otherwise a short transaction is opened
   * for the bootstrap alone.
   */
  private async withShopLock<T>(db: Db, shopId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    const run = async (tx: Prisma.TransactionClient) => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM Shop WHERE id = ${shopId} FOR UPDATE`;
      if (rows.length === 0) throw new Error(`Shop ${shopId} not found while resolving its inventory location`);
      return fn(tx);
    };
    if (isTransactionClient(db)) return run(db);
    return this.prisma.$transaction(run, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  }

  private async findDefaultBin(db: Db, shopId: string): Promise<string | null> {
    const warehouse = await db.warehouse.findFirst({
      where: { shopId, code: DEFAULT_WAREHOUSE_CODE, isDeleted: false },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });
    if (!warehouse) return null;
    return this.findBin(db, shopId, warehouse.id, DEFAULT_BIN_CODE);
  }

  private async findBin(db: Db, shopId: string, warehouseId: string, code: string): Promise<string | null> {
    const bin = await db.location.findFirst({
      where: { shopId, warehouseId, code, isDeleted: false },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });
    return bin?.id ?? null;
  }

  private async ensureDefaultWarehouse(tx: Prisma.TransactionClient, shopId: string): Promise<string> {
    const existing = await tx.warehouse.findFirst({
      where: { shopId, code: DEFAULT_WAREHOUSE_CODE, isDeleted: false },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });
    if (existing) return existing.id;
    const created = await tx.warehouse.create({
      data: { shopId, code: DEFAULT_WAREHOUSE_CODE, name: 'Main Store', type: 'RETAIL_STORE' },
      select: { id: true },
    });
    this.logger.log(`Created default warehouse ${created.id} for shop ${shopId}`);
    return created.id;
  }

  private async ensureBin(tx: Prisma.TransactionClient, shopId: string, warehouseId: string, code: string): Promise<string> {
    const existing = await this.findBin(tx, shopId, warehouseId, code);
    if (existing) return existing;
    const created = await tx.location.create({
      data: { shopId, warehouseId, type: 'BIN', code, path: `/${warehouseId}/${code}`, depth: 0 },
      select: { id: true },
    });
    return created.id;
  }
}

function isTransactionClient(db: Db): db is Prisma.TransactionClient {
  return typeof (db as { $transaction?: unknown }).$transaction !== 'function';
}
