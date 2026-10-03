import { Injectable, NotFoundException, Inject } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PurchaseNumberEngine } from '../services/purchase-number-engine.service';
import { PurchaseLifecycleService } from '../services/purchase-lifecycle.service';
import { PurchaseValidationService } from '../services/purchase-validation.service';
import { PurchaseAuditService } from '../services/purchase-audit.service';
import { SalesEventPublisher } from '../../sales-events-domain/services/sales-event-publisher.service';
import { PurchaseDraftService } from '../services/purchase-draft.service';
import { PurchaseApprovalService } from '../services/purchase-approval.service';
import { PurchasePricingService } from '../services/purchase-pricing.service';
import { PurchaseTaxService } from '../services/purchase-tax.service';
import { Prisma } from '@prisma/client';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { CacheConfig } from '../../config/domains/cache.config';
import { CreatePurchaseOrderDto, UpdatePurchaseDraftDto } from '../dto/purchase-order.dto';
import { assertOwnedMany } from '../../prisma/tenant-ownership';
import { procurementTransaction } from '../../common/db/procurement-transaction';

@Injectable()
export class PurchaseRepository {
  constructor(private readonly prisma: PrismaService,
    private readonly numberEngine: PurchaseNumberEngine,
    private readonly lifecycle: PurchaseLifecycleService,
    private readonly validation: PurchaseValidationService,
    private readonly audit: PurchaseAuditService,
    private readonly draft: PurchaseDraftService,
    private readonly approval: PurchaseApprovalService,
    private readonly pricing: PurchasePricingService,
    private readonly tax: PurchaseTaxService,
    private readonly eventPublisher: SalesEventPublisher,
    @Inject(CACHE_MANAGER) private cacheManager: Cache,
    private readonly cacheConfig: CacheConfig
  ) {}

  async createPurchaseOrder(shopId: string, payload: CreatePurchaseOrderDto, actorId: string, ipAddress?: string) {
    const { supplierId, items, ...metadata } = payload;
    
    await this.validation.validateSupplier(shopId, supplierId);
    await this.validation.validateItems(shopId, items);
    await this.assertItemReferencesOwned(shopId, items);

    // Line math is server-side: the order total is the sum of its taxed lines, never the client's figure.
    const taxedItems = this.tax.calculateTaxes(items, metadata.taxMode || 'EXCLUSIVE', metadata.currency || 'INR', metadata.exchangeRate || 1);
    const totalAmount = taxedItems.reduce((sum: Prisma.Decimal, item: { totalCost: number }) => sum.plus(new Prisma.Decimal(item.totalCost || 0)), new Prisma.Decimal(0)).toDecimalPlaces(2);

    return procurementTransaction(this.prisma, async (tx) => {
      const orderNumber = await this.numberEngine.generateNextOrderNumber(tx, shopId, 'PO');

      const purchaseOrder = await tx.purchaseOrder.create({
        data: {
          shopId,
          supplierId,
          orderNumber,
          status: 'DRAFT',
          totalAmount,
          notes: metadata.notes,
          department: metadata.department,
          costCenter: metadata.costCenter,
          priority: metadata.priority,
          expectedDelivery: metadata.expectedDelivery ? new Date(metadata.expectedDelivery) : null,
          deliveryTerms: metadata.deliveryTerms,
          paymentTerms: metadata.paymentTerms,
          currency: metadata.currency || 'INR',
          exchangeRate: metadata.exchangeRate || 1.0,
          remarks: metadata.remarks,
          taxMode: metadata.taxMode || 'EXCLUSIVE',
          shippingInstructions: metadata.shippingInstructions,
          items: {
            create: taxedItems.map((item: any) => ({
              shopId,
              productId: item.productId,
              variantId: item.variantId,
              quantity: item.quantity,
              unit: item.unit,
              unitCost: item.unitCost,
              discount: item.discount || 0,
              cgstAmount: item.cgstAmount || 0,
              sgstAmount: item.sgstAmount || 0,
              igstAmount: item.igstAmount || 0,
              cessAmount: item.cessAmount || 0,
              totalCost: item.totalCost,
              price: item.price || 0,
              tax: item.tax || 0,
              hsnSac: item.hsnSac,
              warehouseId: item.warehouseId,
              binId: item.binId,
              expectedDate: item.expectedDate ? new Date(item.expectedDate) : null,
              remarks: item.remarks
            }))
          }
        },
        include: { items: true }
      });

      await this.audit.recordAudit(tx, purchaseOrder.id, shopId, 'CREATED', actorId, null, purchaseOrder as any, ipAddress);
      // The first timeline row is the initial status, not a transition (DRAFT -> DRAFT used to roll the create back).
      await this.lifecycle.recordInitialStatus(tx, purchaseOrder.id, shopId, 'DRAFT', actorId, 'Initial PO Creation');

      await this.eventPublisher.publish(tx, shopId, {
        eventType: 'PurchaseOrderCreated',
        aggregateId: purchaseOrder.id,
        aggregateType: 'PurchaseOrder',
        payload: { id: purchaseOrder.id, orderNumber, status: 'DRAFT', supplierId, totalAmount: totalAmount.toFixed(2), department: metadata.department ?? null },
        actorId,
      });

      return purchaseOrder;
    });
  }

  async getPurchaseOrder(shopId: string, id: string) {
    const cacheKey = `po:${shopId}:${id}`;
    const cached = await this.cacheManager.get(cacheKey);
    if (cached) return cached;

    const po = await this.prisma.purchaseOrder.findUnique({
      where: { id },
      include: { 
        items: true, 
        timelines: { orderBy: { createdAt: 'desc' } },
        attachments: { where: { isDeleted: false } },
        revisions: true,
        approvals: true,
        comments: true,
        pricingSnapshot: true
      }
    });

    if (!po || po.shopId !== shopId || po.isDeleted) {
      throw new NotFoundException(`Purchase Order ${id} not found.`);
    }

    await this.cacheManager.set(cacheKey, po, this.cacheConfig.purchaseTtlMs); // 1 minute cache
    return po;
  }

  async listPurchaseOrders(shopId: string, limit: number = 50, offset: number = 0) {
    return this.prisma.purchaseOrder.findMany({
      where: { shopId, isDeleted: false },
      include: { supplier: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: limit,
      skip: offset
    });
  }

  async submitPurchaseOrder(shopId: string, id: string, actorId: string, comments?: string) {
    return procurementTransaction(this.prisma, async (tx) => {
      const po = await this.approval.submitForApproval(tx, shopId, id, actorId, comments);

      // The workflow engine's budget check reads totalAmount and department from this payload.
      await this.eventPublisher.publish(tx, shopId, {
        eventType: 'PurchaseOrderSubmitted',
        aggregateId: id,
        aggregateType: 'PurchaseOrder',
        payload: { id, status: 'SUBMITTED', totalAmount: po?.totalAmount?.toFixed(2) ?? '0.00', department: po?.department ?? null, supplierId: po?.supplierId ?? null },
        actorId,
      });

      await this.cacheManager.del(`po:${shopId}:${id}`);
      return po;
    });
  }

  async approvePurchaseOrder(shopId: string, id: string, actorId: string, _ipAddress?: string, comments?: string, signature?: string) {
    return procurementTransaction(this.prisma, async (tx) => {
      const po = await this.approval.processApproval(tx, shopId, id, actorId, 'APPROVE', comments, signature);

      // Store immutable pricing snapshot upon approval
      await this.pricing.createSnapshot(tx, shopId, id);

      // Named like the other order events; the analytics listener subscribes to this name.
      await this.eventPublisher.publish(tx, shopId, {
        eventType: 'PurchaseOrderApproved',
        aggregateId: po!.id,
        aggregateType: 'PurchaseOrder',
        payload: { id: po!.id, status: 'APPROVED', totalAmount: po!.totalAmount.toFixed(2), supplierId: po!.supplierId },
        actorId,
      });

      await this.cacheManager.del(`po:${shopId}:${id}`);
      return po;
    });
  }

  async rejectPurchaseOrder(shopId: string, id: string, actorId: string, comments?: string) {
    return procurementTransaction(this.prisma, async (tx) => {
      const po = await this.approval.processApproval(tx, shopId, id, actorId, 'REJECT', comments);

      await this.eventPublisher.publish(tx, shopId, {
        eventType: 'PurchaseOrderRejected',
        aggregateId: po!.id,
        aggregateType: 'PurchaseOrder',
        payload: { id: po!.id, status: 'REJECTED' },
        actorId,
      });

      await this.cacheManager.del(`po:${shopId}:${id}`);
      return po;
    });
  }

  async updateDraft(shopId: string, id: string, payload: UpdatePurchaseDraftDto, actorId: string) {
    if (payload.items) {
      await this.validation.validateItems(shopId, payload.items);
      await this.assertItemReferencesOwned(shopId, payload.items);
    }
    return procurementTransaction(this.prisma, async (tx) => {
      const updatedPo = await this.draft.saveDraft(tx, shopId, id, payload, actorId);

      await this.eventPublisher.publish(tx, shopId, {
        eventType: 'PurchaseOrderVersionCreated',
        aggregateId: id,
        aggregateType: 'PurchaseOrder',
        payload: { id, revisionNumber: updatedPo.revisionNumber },
        actorId,
      });

      await this.cacheManager.del(`po:${shopId}:${id}`);
      return updatedPo;
    });
  }

  /** Every ID an order line names must belong to this shop (roadmap 1.5). */
  private async assertItemReferencesOwned(shopId: string, items: Array<{ variantId?: string; warehouseId?: string; binId?: string }>): Promise<void> {
    await assertOwnedMany(this.prisma, 'productVariant', items.map((i) => i.variantId), shopId);
    await assertOwnedMany(this.prisma, 'warehouse', items.map((i) => i.warehouseId), shopId);
    await assertOwnedMany(this.prisma, 'location', items.map((i) => i.binId), shopId);
  }
}
