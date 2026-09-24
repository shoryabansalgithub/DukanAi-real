import { Injectable, BadRequestException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { OrderCalculationEngine } from './order-calculation-engine';
import { OrderValidationEngine } from '../services/order-validation-engine';
import { CreateSalesOrderDto, CreateSalesOrderLineDto } from '../dto/create-sales-order.dto';
import { Prisma } from '@prisma/client';

@Injectable()
export class OrderModificationEngine {
  constructor(
    private readonly prisma: PrismaService,
    private readonly calculationEngine: OrderCalculationEngine,
    private readonly validationEngine: OrderValidationEngine
  ) {}

  /**
   * Modifies an existing order while enforcing Optimistic Locking via the 'version' field.
   * Throws 409 Conflict if version mismatch is detected.
   */
  async modifyOrderLines(
    shopId: string, 
    orderId: string, 
    expectedVersion: number, 
    newLines: CreateSalesOrderLineDto[]
  ) {
    const order = await this.prisma.salesOrder.findUnique({
      where: { id: orderId }
    });

    if (!order || order.shopId !== shopId) {
      throw new BadRequestException('Order not found');
    }

    if (order.version !== expectedVersion) {
      throw new ConflictException(`Optimistic Locking Failure: Expected version ${expectedVersion}, but found ${order.version}`);
    }

    // Convert newLines into the format expected by CalculationEngine
    const mockDto: CreateSalesOrderDto = {
      customerId: order.customerId ?? undefined,
      lines: newLines
    };

    // 1. Validate Business Rules (Cross-Tenant Product Verification)
    await this.validationEngine.validateOrder(shopId, mockDto);

    // Fetch server-side pricing to prevent client manipulation
    const productIds = newLines.map(l => l.productId);
    const products = await this.prisma.product.findMany({
      where: { id: { in: productIds }, shopId },
      include: { variants: true }
    });
    const productMap = new Map(products.map(p => [p.id, p]));

    // Override client pricing with server pricing
    mockDto.lines = mockDto.lines.map(l => {
      const product = productMap.get(l.productId);
      if (!product) throw new Error(`Product ${l.productId} not found`);
      const variant = l.variantId ? product.variants.find(v => v.id === l.variantId) : null;
      const unitPrice = variant ? Number(variant.sellingPrice) : Number(product.sellingPrice);
      
      return {
        ...l,
        unitPrice,
        discount: 0,
        taxRate: 0,
      };
    });

    const financials = this.calculationEngine.calculateFinancials(mockDto);

    return this.prisma.$transaction(async (tx) => {
      // 1. Delete old lines
      await tx.salesOrderLine.deleteMany({
        where: { orderId }
      });

      // 2. Insert new lines
      const linesData = financials.lines.map(l => ({
        orderId,
        shopId,
        productId: l.productId,
        variantId: l.variantId,
        sku: null,
        productName: 'Modified Item', // Would fetch real name via SnapshotEngine in prod
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        discount: l.discount,
        taxRate: l.taxRate,
        lineTotal: l.lineTotal
      }));
      
      await tx.salesOrderLine.createMany({
        data: linesData
      });

      // Money math stays in Decimal. The order's own outstandingAmount is clamped at
      // zero; an overpayment is NOT pushed onto Customer.outstandingBalance here:
      // that column is the POS udhar balance and only moves with a UdharTransaction
      // (customers/billing). The overpayment is recorded on the order timeline.
      const grandTotal = new Prisma.Decimal(financials.grandTotal);
      const paidAmount = new Prisma.Decimal(order.paidAmount);
      let newOutstanding = grandTotal.minus(paidAmount);
      let overpayment = new Prisma.Decimal(0);
      if (newOutstanding.lt(0)) {
        overpayment = newOutstanding.abs();
        newOutstanding = new Prisma.Decimal(0);
      }

      // 3. Update Order Totals and Bump Version atomically
      const updatedOrder = await tx.salesOrder.update({
        where: { id: orderId },
        data: {
          subTotal: financials.subTotal,
          taxTotal: financials.taxTotal,
          cgstTotal: financials.cgstTotal,
          sgstTotal: financials.sgstTotal,
          igstTotal: financials.igstTotal,
          cessTotal: financials.cessTotal,
          discountTotal: financials.discountTotal,
          grandTotal: financials.grandTotal,
          outstandingAmount: newOutstanding,
          version: { increment: 1 }
        }
      });

      // 4. Record Timeline Event (with an overpayment note when the new total is below what was paid)
      await tx.salesOrderTimeline.create({
        data: {
          orderId,
          shopId,
          action: 'Lines Modified',
          ...(overpayment.gt(0)
            ? {
                metadata: {
                  overpayment: overpayment.toFixed(2),
                  paidAmount: paidAmount.toFixed(2),
                  grandTotal: grandTotal.toFixed(2),
                  customerId: order.customerId ?? null,
                  note: 'Paid amount exceeds the modified order total; settle the difference through a UdharTransaction or refund. Customer.outstandingBalance was not changed.',
                },
              }
            : {}),
        }
      });

      return updatedOrder;
    });
  }
}
