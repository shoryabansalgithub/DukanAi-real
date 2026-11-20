import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PurchaseAuditService } from './purchase-audit.service';
import { Prisma } from '@prisma/client';
import { PurchaseTaxService } from './purchase-tax.service';
import { UpdatePurchaseDraftDto } from '../dto/purchase-order.dto';
import { lockDocument } from '../procurement-support';

/**
 * The PurchaseOrder columns a draft edit may change; the request body is
 * never spread into Prisma data. `totalAmount` is not one of them: the
 * order is worth the sum of its taxed lines, computed here (release audit S22).
 */
const DRAFT_FIELDS = ['notes', 'department', 'costCenter', 'priority', 'deliveryTerms', 'paymentTerms', 'currency', 'exchangeRate', 'remarks', 'taxMode', 'shippingInstructions'] as const;

function pickDraftFields(updates: Omit<UpdatePurchaseDraftDto, 'items'>): Prisma.PurchaseOrderUpdateInput {
  const data: Prisma.PurchaseOrderUpdateInput = {};
  for (const field of DRAFT_FIELDS) {
    if (updates[field] !== undefined) (data as Record<string, unknown>)[field] = updates[field];
  }
  if (updates.expectedDelivery !== undefined) data.expectedDelivery = new Date(updates.expectedDelivery);
  // Checked by the caller (`PurchaseRepository.updateDraft`): the shop's own active supplier.
  if (updates.supplierId !== undefined) data.supplier = { connect: { id: updates.supplierId } };
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

    // The order row is locked before its state is read: two edits (or an edit and a submission) are decided one after the other.
    await lockDocument(tx, 'PurchaseOrder', purchaseOrderId, shopId, 'PURCHASE_ORDER_NOT_FOUND');
    const currentPo = await tx.purchaseOrder.findFirstOrThrow({ where: { id: purchaseOrderId, shopId } });

    if (currentPo.status !== 'DRAFT') {
      throw new ConflictException({
        message: `Only a DRAFT purchase order can be edited; this one is ${currentPo.status}.`,
        code: 'PURCHASE_ORDER_STATE_CONFLICT',
        details: { status: currentPo.status },
      });
    }
    const taxModeChanged = poUpdates.taxMode !== undefined && poUpdates.taxMode !== currentPo.taxMode;
    if (taxModeChanged && !items) {
      throw new BadRequestException({ message: 'Changing the tax mode re-taxes every line: send the lines with it.', code: 'PURCHASE_ORDER_ITEMS_REQUIRED' });
    }

    // Replacing the lines re-taxes them; the order's total is always the sum of its lines.
    let totalAmount: Prisma.Decimal;
    if (items && Array.isArray(items)) {
      await tx.purchaseOrderItem.deleteMany({
        where: { purchaseOrderId, shopId }
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
      totalAmount = taxedItems.reduce((sum, item) => sum.plus(new Prisma.Decimal(item.totalCost || 0)), new Prisma.Decimal(0));
    } else {
      const existing = await tx.purchaseOrderItem.aggregate({ where: { purchaseOrderId, shopId, isDeleted: false }, _sum: { totalCost: true } });
      totalAmount = existing._sum.totalCost ?? new Prisma.Decimal(0);
    }

    const updatedPo = await tx.purchaseOrder.update({
      where: { id: purchaseOrderId },
      data: {
        ...pickDraftFields(poUpdates),
        totalAmount: totalAmount.toDecimalPlaces(2),
        revisionNumber: currentPo.revisionNumber + 1
      },
      include: { items: true }
    });

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
