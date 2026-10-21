import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class PurchaseValidationService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Validates vendor/supplier conditions.
   */
  async validateSupplier(shopId: string, supplierId: string): Promise<void> {
    const supplier = await this.prisma.supplier.findUnique({
      where: { id: supplierId }
    });

    // A foreign or deleted supplier does not exist for this shop (release audit S21).
    if (!supplier || supplier.shopId !== shopId || supplier.isDeleted) {
      throw new NotFoundException({ message: 'Supplier not found.', code: 'SUPPLIER_NOT_FOUND' });
    }

    if (!supplier.isActive) {
      throw new BadRequestException({ message: 'Cannot raise a Purchase Order for an inactive supplier.', code: 'SUPPLIER_INACTIVE' });
    }
  }

  /**
   * Validates product items against procurement policies (e.g. valid variants, restricted catalog).
   */
  async validateItems(shopId: string, items: any[]): Promise<void> {
    if (!items || items.length === 0) {
      throw new BadRequestException('Purchase Order must contain at least one item.');
    }

    const productIds = items.map(i => i.productId);
    const products = await this.prisma.product.findMany({
      where: { id: { in: productIds }, shopId, isDeleted: false }
    });

    if (products.length !== productIds.length) {
      throw new BadRequestException('One or more products are invalid, deleted, or do not belong to this shop.');
    }
  }

  /**
   * Evaluates organization budget or PO limits.
   */
  validateLimits(totalAmount: number): void {
    if (totalAmount <= 0) {
      throw new BadRequestException('Total purchase amount must be strictly greater than zero.');
    }
    // Future enterprise rules: e.g. if (totalAmount > config.maxPoLimit) requires VP approval, etc.
  }
}
