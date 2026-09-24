import { Injectable, NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TenantContextService } from '../iam/tenant-context/tenant-context.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/create-product.dto';
import { ProductEventPublisher } from '../product-events/services/product-event-publisher.service';

export const PRODUCT_LIST_DEFAULT_LIMIT = 50;
export const PRODUCT_LIST_MAX_LIMIT = 200;

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
  q?: string;
  limit?: number;
  offset?: number;
}

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
  ) {}

  async create(createProductDto: CreateProductDto) {
    const shopId = this.tenantContext.getShopId();
    const userId = this.tenantContext.getUserId();
    const barcode = normalizeBarcode(createProductDto.barcode);

    // MySQL allows multiple NULL values in a composite unique key, so a
    // findUnique lookup with deletedAt: null is invalid and can throw before
    // creation. Check the active record explicitly instead.
    const activeExisting = await this.prisma.product.findFirst({
      where: { shopId, sku: createProductDto.sku, isDeleted: false, isActive: true },
      select: { id: true },
    });
    if (activeExisting) {
      throw new BadRequestException(`Product with SKU ${createProductDto.sku} already exists.`);
    }

    if (barcode) await this.assertBarcodeAvailable(shopId, barcode);

    const product = await this.prisma.$transaction(async (tx) => {
      const newProduct = await tx.product.create({
        data: {
          ...createProductDto,
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

    return product;
  }

  /** `GET /products?q&limit&offset` — active, non-deleted products with category (contract §5). */
  async findAll(query: ProductListQuery = {}) {
    const shopId = this.tenantContext.getShopId();
    const take = Math.min(
      Math.max(Number.isFinite(query.limit) ? Math.floor(query.limit as number) : PRODUCT_LIST_DEFAULT_LIMIT, 1),
      PRODUCT_LIST_MAX_LIMIT,
    );
    const skip = Math.max(Number.isFinite(query.offset) ? Math.floor(query.offset as number) : 0, 0);
    const q = query.q?.trim();

    const where: Prisma.ProductWhereInput = { shopId, isDeleted: false, isActive: true };
    if (q) {
      where.OR = [{ name: { contains: q } }, { sku: { contains: q } }, { barcode: { contains: q } }];
    }

    return this.prisma.product.findMany({
      where,
      include: { category: { select: { id: true, name: true } }, brand: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
      take,
      skip,
    });
  }

  async findOne(id: string) {
    const shopId = this.tenantContext.getShopId();
    const product = await this.prisma.product.findFirst({
      where: { id, shopId, isDeleted: false },
      include: { category: true, brand: true, variants: true, images: true, attributes: true }
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
