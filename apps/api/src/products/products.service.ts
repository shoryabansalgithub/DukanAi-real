import { Injectable, NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { rethrowUniqueViolation } from '../common/db/unique-violation';
import { Prisma, ProductType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TenantContextService } from '../iam/tenant-context/tenant-context.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/create-product.dto';
import { ProductEventPublisher } from '../product-events/services/product-event-publisher.service';
import { clampSearchQuery } from '../product-search/search-term';
import { clampSkip, clampTake, MAX_LIST_TAKE, PagedResult } from '../common/pagination';
import { NumberSequenceService } from '../common/numbering/number-sequence.service';
import { ProductStockFilter } from './dto/product-list-query.dto';

export const PRODUCT_LIST_DEFAULT_LIMIT = 50;
export const PRODUCT_LIST_MAX_LIMIT = MAX_LIST_TAKE;

const PRODUCT_LIST_INCLUDE = { category: { select: { id: true, name: true } }, brand: { select: { id: true, name: true } } } as const;

/** Fields whose change on PATCH is recorded as `PRODUCT_PRICE_CHANGED` in AuditLog. */
const PRICE_FIELDS = ['sellingPrice', 'costPrice', 'mrp', 'wholesalePrice', 'gstRate', 'cessRate'] as const;
type PriceField = (typeof PRICE_FIELDS)[number];

type PriceSnapshot = Record<PriceField, string>;

interface ProductPriceRow {
  sellingPrice: Prisma.Decimal;
  costPrice: Prisma.Decimal;
  mrp: Prisma.Decimal;
  wholesalePrice: Prisma.Decimal;
  gstRate: string;
  cessRate: Prisma.Decimal;
}

export interface ProductListQuery {
  q?: unknown;
  limit?: number;
  offset?: number;
  categoryId?: string;
  stock?: ProductStockFilter;
}

/** Products the stock filters and the dashboard's stock alerts consider (services and digital goods carry no stock). */
const STOCKLESS_TYPES: ProductType[] = ['SERVICE', 'DIGITAL'];

/** Sequence key of the server-generated SKU (`SKU-000001`, one counter per shop). */
export const SKU_SEQUENCE = { entityType: 'PRODUCT_SKU', prefix: 'SKU-' } as const;

/** Normalises a barcode from a DTO: trimmed string, or null when absent/blank. */
export function normalizeBarcode(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function snapshotPrices(row: ProductPriceRow): PriceSnapshot {
  return {
    sellingPrice: new Prisma.Decimal(row.sellingPrice).toFixed(2),
    costPrice: new Prisma.Decimal(row.costPrice).toFixed(2),
    mrp: new Prisma.Decimal(row.mrp).toFixed(2),
    wholesalePrice: new Prisma.Decimal(row.wholesalePrice).toFixed(2),
    gstRate: row.gstRate,
    cessRate: new Prisma.Decimal(row.cessRate).toFixed(2),
  };
}

@Injectable()
export class ProductsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
    private readonly eventPublisher: ProductEventPublisher,
    private readonly numberSequence: NumberSequenceService,
  ) {}

  async create(createProductDto: CreateProductDto) {
    const shopId = this.tenantContext.getShopId();
    const userId = this.tenantContext.getUserId();
    const barcode = normalizeBarcode(createProductDto.barcode);
    const requestedSku = createProductDto.sku?.trim() || undefined;

    // MySQL allows multiple NULL values in a composite unique key, so a
    // findUnique lookup with deletedAt: null is invalid and can throw before
    // creation. Check the active record explicitly instead.
    if (requestedSku) {
      const activeExisting = await this.prisma.product.findFirst({
        where: { shopId, sku: requestedSku, isDeleted: false, isActive: true },
        select: { id: true },
      });
      if (activeExisting) {
        throw new BadRequestException(`Product with SKU ${requestedSku} already exists.`);
      }
    }

    if (barcode) await this.assertBarcodeAvailable(shopId, barcode);

    let product;
    try {
      product = await this.prisma.$transaction(async (tx) => {
        // Roadmap 6.2: the SKU is never invented by a client. Without one the
        // shop's sequence numbers it under the same row lock as every other
        // document number, so two concurrent creates cannot collide.
        const sku = requestedSku ?? (await this.numberSequence.next(tx, shopId, SKU_SEQUENCE.entityType, SKU_SEQUENCE.prefix)).number;
        const newProduct = await tx.product.create({
          data: {
            ...createProductDto,
            sku,
            barcode,
            shopId,
            createdBy: userId,
          },
        });

        await this.eventPublisher.publish(tx, {
          shopId,
          eventType: 'ProductCreated',
          entityId: newProduct.id,
          entityType: 'Product',
          payload: newProduct,
        });

        return newProduct;
      });
    } catch (error) {
      rethrowUniqueViolation(error, [
        { index: 'Product_shopId_sku', code: 'PRODUCT_SKU_IN_USE', message: `Product with SKU ${requestedSku ?? '(generated)'} already exists.` },
        { index: 'Product_shopId_barcode', code: 'BARCODE_IN_USE', message: `Barcode ${barcode} is already assigned to another product` },
      ]);
    }

    return product;
  }

  /**
   * `GET /products?q&limit&offset&categoryId&stock` — active, non-deleted
   * products with category, as a page (contract §5, roadmap 6.2). The stock
   * filter shares the dashboard's definitions (`stockAlertProductFilter`):
   * `out` is no stock, `low` is at or below the reorder point.
   */
  async findAll(query: ProductListQuery = {}): Promise<PagedResult<Prisma.ProductGetPayload<{ include: typeof PRODUCT_LIST_INCLUDE }>>> {
    const shopId = this.tenantContext.getShopId();
    const take = clampTake(query.limit, PRODUCT_LIST_DEFAULT_LIMIT);
    const skip = clampSkip(query.offset);
    // Same cap as the search box (roadmap 5.3): a repeated or over-long `q` is cut, never a 500 or an unbounded contains.
    const q = clampSearchQuery(query.q);

    const where: Prisma.ProductWhereInput = { shopId, isDeleted: false, isActive: true };
    if (q) {
      where.OR = [{ name: { contains: q } }, { sku: { contains: q } }, { barcode: { contains: q } }];
    }
    if (query.categoryId) where.categoryId = query.categoryId;
    if (query.stock) where.AND = [this.stockCondition(query.stock)];

    const [items, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        include: PRODUCT_LIST_INCLUDE,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        take,
        skip,
      }),
      this.prisma.product.count({ where }),
    ]);
    return { items, total, skip, take };
  }

  private stockCondition(stock: ProductStockFilter): Prisma.ProductWhereInput {
    const reorderPoint = this.prisma.product.fields.reorderPoint;
    switch (stock) {
      case 'out':
        return { type: { notIn: STOCKLESS_TYPES }, currentStock: { lte: 0 } };
      case 'low':
        return { type: { notIn: STOCKLESS_TYPES }, currentStock: { gt: 0, lte: reorderPoint } };
      case 'in':
        return { OR: [{ type: { in: STOCKLESS_TYPES } }, { currentStock: { gt: reorderPoint } }] };
    }
  }

  async findOne(id: string) {
    const shopId = this.tenantContext.getShopId();
    const product = await this.prisma.product.findFirst({
      where: { id, shopId, isDeleted: false },
      // Nested lists are capped too (roadmap 5.6); variants are bounded by the matrix cap (5.2).
      include: { category: true, brand: true, variants: true, images: { take: MAX_LIST_TAKE }, attributes: { take: MAX_LIST_TAKE } }
    });
    if (!product) throw new NotFoundException('Product not found');
    return product;
  }

  async update(id: string, updateProductDto: UpdateProductDto) {
    const shopId = this.tenantContext.getShopId();
    const userId = this.tenantContext.getUserId();

    const product = await this.prisma.product.findFirst({
      where: { id, shopId, isDeleted: false }
    });
    if (!product) throw new NotFoundException('Product not found');

    const data: Prisma.ProductUncheckedUpdateInput = { ...updateProductDto, updatedBy: userId };
    if (updateProductDto.barcode !== undefined) {
      const barcode = normalizeBarcode(updateProductDto.barcode);
      data.barcode = barcode;
      if (barcode && barcode !== product.barcode) {
        await this.assertBarcodeAvailable(shopId, barcode, id);
      }
    }

    const before = snapshotPrices(product);
    const after = snapshotPrices({
      sellingPrice: updateProductDto.sellingPrice !== undefined ? new Prisma.Decimal(updateProductDto.sellingPrice) : product.sellingPrice,
      costPrice: updateProductDto.costPrice !== undefined ? new Prisma.Decimal(updateProductDto.costPrice) : product.costPrice,
      mrp: updateProductDto.mrp !== undefined ? new Prisma.Decimal(updateProductDto.mrp) : product.mrp,
      wholesalePrice: updateProductDto.wholesalePrice !== undefined ? new Prisma.Decimal(updateProductDto.wholesalePrice) : product.wholesalePrice,
      gstRate: updateProductDto.gstRate ?? product.gstRate,
      cessRate: updateProductDto.cessRate !== undefined ? new Prisma.Decimal(updateProductDto.cessRate) : product.cessRate,
    });
    const priceChanged = PRICE_FIELDS.some((field) => before[field] !== after[field]);

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.product.update({ where: { id }, data });

      if (priceChanged) {
        // AuditLog is tenant-owned; shopId must equal the context shopId (it does).
        await tx.auditLog.create({
          data: {
            shopId,
            userId,
            action: 'PRODUCT_PRICE_CHANGED',
            entity: 'Product',
            entityId: id,
            beforeData: before,
            afterData: after,
          },
        });
      }

      return updated;
    });
  }

  async softDelete(id: string) {
    const shopId = this.tenantContext.getShopId();
    const userId = this.tenantContext.getUserId();
    const product = await this.prisma.product.findFirst({
      where: { id, shopId, isDeleted: false },
      select: { id: true },
    });
    if (!product) throw new NotFoundException('Product not found');

    return this.prisma.product.update({
      where: { id },
      data: {
        isDeleted: true,
        isActive: false,
        deletedAt: new Date(),
        status: 'SOFT_DELETED',
        updatedBy: userId,
      }
    });
  }

  /**
   * Barcodes are unique per shop across active products, ProductBarcode rows
   * and variant barcodes. Throws 409 `BARCODE_IN_USE` with the owning product.
   */
  private async assertBarcodeAvailable(shopId: string, barcode: string, excludeProductId?: string): Promise<void> {
    const notSelf = excludeProductId ? { not: excludeProductId } : undefined;

    const [product, extraBarcode, variant] = await Promise.all([
      this.prisma.product.findFirst({
        where: { shopId, barcode, isDeleted: false, isActive: true, ...(notSelf ? { id: notSelf } : {}) },
        select: { id: true },
      }),
      // ProductBarcode / ProductVariant are not tenant-scoped by the Prisma extension.
      this.prisma.productBarcode.findFirst({
        where: { shopId, barcode, isActive: true, ...(notSelf ? { productId: notSelf } : {}) },
        select: { productId: true },
      }),
      this.prisma.productVariant.findFirst({
        where: { shopId, barcode, isDeleted: false, isActive: true, ...(notSelf ? { productId: notSelf } : {}) },
        select: { productId: true },
      }),
    ]);

    const owner = product?.id ?? extraBarcode?.productId ?? variant?.productId;
    if (owner) {
      throw new ConflictException({
        message: `Barcode ${barcode} is already assigned to another product`,
        code: 'BARCODE_IN_USE',
        details: { productId: owner },
      });
    }
  }
}
