import { Injectable, NotFoundException, Inject } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SalesEventPublisher } from '../../sales-events-domain/services/sales-event-publisher.service';
import { GrnLifecycleService } from '../services/grn-lifecycle.service';
import { GrnApprovalService } from '../services/grn-approval.service';
import { GrnInspectionService } from '../services/grn-inspection.service';
import { GrnVarianceService } from '../services/grn-variance.service';
import { GrnIntegrationService } from '../services/grn-integration.service';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { Prisma } from '@prisma/client';
import { CacheConfig } from '../../config/domains/cache.config';

@Injectable()
export class GrnRepository {
  constructor(private readonly prisma: PrismaService,
    private readonly lifecycle: GrnLifecycleService,
    private readonly approval: GrnApprovalService,
    private readonly inspection: GrnInspectionService,
    private readonly variance: GrnVarianceService,
    private readonly integration: GrnIntegrationService,
    private readonly eventPublisher: SalesEventPublisher,
    @Inject(CACHE_MANAGER) private cacheManager: Cache,
    private readonly cacheConfig: CacheConfig
  ) {}

  async createGoodsReceipt(shopId: string, payload: any, actorId: string, ipAddress?: string) {
    const { purchaseOrderId, supplierId, warehouseId, lines, ...metadata } = payload;
    
    return this.prisma.$transaction(async (tx) => {
      // Basic PO existence check
      const po = await tx.purchaseOrder.findUnique({ where: { id: purchaseOrderId } });
      if (!po || po.shopId !== shopId) throw new NotFoundException('Purchase Order not found');

      const grnNumber = `GRN-${Date.now()}`; // Or use a NumberEngine
      
      const grn = await tx.goodsReceipt.create({
        data: {
          shopId,
          purchaseOrderId,
          supplierId,
          warehouseId,
          grnNumber,
          status: 'DRAFT',
          expectedDate: metadata.expectedDate ? new Date(metadata.expectedDate) : null,
          vehicleNumber: metadata.vehicleNumber,
          transporter: metadata.transporter,
          trackingNumber: metadata.trackingNumber,
          notes: metadata.notes,
          createdBy: actorId,
          lines: {
            create: lines.map((line: any) => ({
              productId: line.productId,
              variantId: line.variantId,
              orderedQuantity: line.orderedQuantity || 0,
              receivedQuantity: line.receivedQuantity || 0,
              pendingQuantity: line.orderedQuantity || 0,
              unit: line.unit,
              unitPrice: line.unitPrice || 0,
              remarks: line.remarks
            }))
          }
        },
        include: { lines: true }
      });

      await tx.goodsReceiptAudit.create({
        data: {
          goodsReceiptId: grn.id,
          shopId,
          actorId,
          action: 'CREATED',
          newPayload: grn as any,
          ipAddress
        }
      });

      await this.eventPublisher.publish(tx, shopId, {
        eventType: 'GRNCreated',
        aggregateId: grn.id,
        aggregateType: 'GoodsReceipt',
        payload: { grnNumber },
        actorId,
      });

      return grn;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async getGoodsReceipt(shopId: string, id: string) {
    const cacheKey = `grn:${shopId}:${id}`;
    const cached = await this.cacheManager.get(cacheKey);
    if (cached) return cached;

    const grn = await this.prisma.goodsReceipt.findUnique({
      where: { id },
      include: { 
        lines: true, 
        attachments: true, 
        statusHistory: { orderBy: { createdAt: 'desc' } },
        inspections: true,
        approvals: true,
        comments: true 
      }
    });

    if (!grn || grn.shopId !== shopId || grn.isDeleted) {
      throw new NotFoundException(`Goods Receipt ${id} not found.`);
    }

    await this.cacheManager.set(cacheKey, grn, this.cacheConfig.grnTtlMs); 
    return grn;
  }

  async listGoodsReceipts(shopId: string, limit: number = 50, offset: number = 0) {
    return this.prisma.goodsReceipt.findMany({
      where: { shopId, isDeleted: false },
      include: { supplier: true, warehouse: true },
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset
    });
  }

  async receiveGoods(shopId: string, id: string, payload: any, actorId: string, ipAddress?: string) {
    return this.prisma.$transaction(async (tx) => {
      const grn = await tx.goodsReceipt.findUnique({ where: { id, shopId }, include: { lines: true } });
      if (!grn) throw new NotFoundException();

      await this.lifecycle.transitionStatus(tx, id, shopId, grn.status, 'RECEIVING', actorId, 'Started receiving');

      // Process line updates for receiving
      for (const lineUpdate of payload.lines) {
        await tx.goodsReceiptLine.update({
          where: { id: lineUpdate.id },
          data: {
            receivedQuantity: lineUpdate.receivedQuantity,
            batchId: lineUpdate.batchId,
            serialId: lineUpdate.serialId,
            binId: lineUpdate.binId
          }
        });
      }

      const updatedGrn = await tx.goodsReceipt.findUnique({ where: { id }, include: { lines: true } });
      
      await this.eventPublisher.publish(tx, shopId, {
        eventType: 'GRNReceived',
        aggregateId: id,
        aggregateType: 'GoodsReceipt',
        payload: { id },
        actorId,
      });

      await this.cacheManager.del(`grn:${shopId}:${id}`);
      return updatedGrn;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async inspectGoods(shopId: string, id: string, payload: any, actorId: string, ipAddress?: string) {
    return this.prisma.$transaction(async (tx) => {
      const grn = await tx.goodsReceipt.findUnique({ where: { id, shopId } });
      if (!grn) throw new NotFoundException();
      
      // Move to QUALITY_INSPECTION
      await this.lifecycle.transitionStatus(tx, id, shopId, grn.status, 'QUALITY_INSPECTION', actorId, 'Inspection phase');

      // Record Inspection
      await this.inspection.processInspection(tx, shopId, id, payload, actorId);

      await this.eventPublisher.publish(tx, shopId, {
        eventType: 'InspectionCompleted',
        aggregateId: id,
        aggregateType: 'GoodsReceipt',
        payload: { status: payload.status },
        actorId,
      });

      await this.cacheManager.del(`grn:${shopId}:${id}`);
      return { success: true };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async acceptGoods(shopId: string, id: string, actorId: string, ipAddress?: string) {
    return this.prisma.$transaction(async (tx) => {
      const grn = await tx.goodsReceipt.findUnique({ where: { id, shopId }, include: { lines: true } });
      if (!grn) throw new NotFoundException();

      // Calculate variances dynamically
      const variances = this.variance.calculateVariances(grn.lines);
      for (const v of variances) {
        await tx.goodsReceiptLine.update({
          where: { id: v.id },
          data: {
            acceptedQuantity: v.receivedQuantity, // Assume accepting all received for this simple wrapper
            pendingQuantity: v.pendingQuantity
          }
        });
      }

      // Transition to ACCEPTED
      await this.lifecycle.transitionStatus(tx, id, shopId, grn.status, 'ACCEPTED', actorId);

      // Safe Inventory Engine Integration
      const updatedGrn = await tx.goodsReceipt.findUnique({ where: { id }, include: { lines: true } });
      if (!updatedGrn) throw new NotFoundException();
      await this.integration.updateInventoryFromGrn(tx, shopId, updatedGrn);

      await this.eventPublisher.publish(tx, shopId, {
        eventType: 'GoodsAccepted',
        aggregateId: id,
        aggregateType: 'GoodsReceipt',
        payload: { id },
        actorId,
      });

      await this.cacheManager.del(`grn:${shopId}:${id}`);
      return updatedGrn;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async approveGrn(shopId: string, id: string, actorId: string, ipAddress?: string, comments?: string, signature?: string) {
    return this.prisma.$transaction(async (tx) => {
      const status = await this.approval.processApproval(tx, shopId, id, actorId, 'APPROVE', comments, signature);
      
      const grn = await tx.goodsReceipt.findUnique({ where: { id } });
      
      await this.eventPublisher.publish(tx, shopId, {
        eventType: 'GRNCompleted', // Example event for final approval
        aggregateId: id,
        aggregateType: 'GoodsReceipt',
        payload: { id, approvalStatus: status },
        actorId,
      });
      
      await this.cacheManager.del(`grn:${shopId}:${id}`);
      return grn;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }
}
