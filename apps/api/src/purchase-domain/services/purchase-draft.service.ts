import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PurchaseAuditService } from './purchase-audit.service';
import { Prisma } from '@prisma/client';
import { PurchaseTaxService } from './purchase-tax.service';
import { UpdatePurchaseDraftDto } from '../dto/purchase-order.dto';

/** The PurchaseOrder columns a draft edit may change; the request body is never spread into Prisma data. */
const DRAFT_FIELDS = ['totalAmount', 'notes', 'department', 'costCenter', 'priority', 'deliveryTerms', 'paymentTerms', 'currency', 'exchangeRate', 'remarks', 'taxMode', 'shippingInstructions'] as const;

function pickDraftFields(updates: Omit<UpdatePurchaseDraftDto, 'items'>): Prisma.PurchaseOrderUpdateInput {
  const data: Prisma.PurchaseOrderUpdateInput = {};
  for (const field of DRAFT_FIELDS) {
    if (updates[field] !== undefined) (data as Record<string, unknown>)[field] = updates[field];
  }
  if (updates.expectedDelivery !== undefined) data.expectedDelivery = new Date(updates.expectedDelivery);
  return data;
}

@Injectable()
export class PurchaseDraftService {
  private readonly logger = new Logger(PurchaseDraftService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: PurchaseAuditService,
    private readonly tax: PurchaseTaxService,
  ) {}

  async saveDraft(
    tx: Prisma.TransactionClient,
    shopId: string,
    purchaseOrderId: string,
    updates: UpdatePurchaseDraftDto,
    actorId: string
  ) {
    this.logger.debug(`Saving draft for PO ${purchaseOrderId}`);
    
    // Process main updates
    const { items, ...poUpdates } = updates;

    const currentPo = await tx.purchaseOrder.findUnique({ where: { id: purchaseOrderId } });
    if (!currentPo || currentPo.shopId !== shopId) {
      throw new NotFoundException({ message: 'Purchase order not found', code: 'PURCHASE_ORDER_NOT_FOUND' });
    }

    if (currentPo.status !== 'DRAFT') {
      throw new ConflictException({
        message: `Only a DRAFT purchase order can be edited; this one is ${currentPo.status}.`,
        code: 'PURCHASE_ORDER_STATE_CONFLICT',
        details: { status: currentPo.status },
      });
    }

    const updatedPo = await tx.purchaseOrder.update({
      where: { id: purchaseOrderId },
      data: {
        ...pickDraftFields(poUpdates),
        revisionNumber: currentPo.revisionNumber + 1
      },
      include: { items: true }
    });

    // Handle item updates (simplified, full implementation would diff items)
    if (items && Array.isArray(items)) {
      await tx.purchaseOrderItem.deleteMany({
        where: { purchaseOrderId }
      });
      const taxMode = (poUpdates.taxMode ?? currentPo.taxMode) === 'INCLUSIVE' ? 'INCLUSIVE' : 'EXCLUSIVE';
      const taxedItems = this.tax.calculateTaxes(items, taxMode, poUpdates.currency ?? currentPo.currency ?? 'INR', poUpdates.exchangeRate ?? Number(currentPo.exchangeRate ?? 1));
      await tx.purchaseOrderItem.createMany({
        data: taxedItems.map((item) => ({
          shopId,
          purchaseOrderId,
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
      });
    }

    // Save revision snapshot
    const snapshotData = await tx.purchaseOrder.findUnique({
      where: { id: purchaseOrderId },
      include: { items: true }
    });

    await tx.purchaseOrderRevision.create({
      data: {
        purchaseOrderId,
        shopId,
        revisionNumber: updatedPo.revisionNumber,
        snapshotData: snapshotData as any,
        createdBy: actorId,
        commitMessage: 'Draft autosave'
      }
    });

    await this.audit.recordAudit(tx, purchaseOrderId, shopId, 'DRAFT_UPDATED', actorId, currentPo as any, updatedPo as any, undefined);

    return updatedPo;
  }
}
