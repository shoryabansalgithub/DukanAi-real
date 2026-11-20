import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { WorkflowEngineService } from './workflow-engine.service';
import { PrismaService } from '../../prisma/prisma.service';
import { OnEvent } from '@nestjs/event-emitter';
import { TenantContextService } from '../../iam/tenant-context/tenant-context.service';

@Injectable()
export class WorkflowEventListener implements OnModuleInit {
  private readonly logger = new Logger(WorkflowEventListener.name);

  constructor(
    private readonly engine: WorkflowEngineService,
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  onModuleInit() {
    this.logger.log('Initializing Workflow Event Listeners...');
  }
  
  @OnEvent('PurchaseOrderSubmitted')
  async handlePurchaseOrderSubmitted(event: any) {
    return this.tenantContext.runWithContext(
      { shopId: event.shopId, correlationId: event.correlationId ?? 'event', requestId: event.aggregateId ?? 'event' },
      async () => {
    this.logger.log(`Received PurchaseOrderSubmitted for ${event.aggregateId}, spawning workflow`);
    await this.prisma.$transaction(async (tx) => {
       await this.engine.spawnWorkflow(tx, event.shopId, 'PURCHASE_ORDER', event.aggregateId, event.payload);
    });
      },
    );
  }

  @OnEvent('VendorBillSubmitted')
  async handleVendorBillSubmitted(event: any) {
    return this.tenantContext.runWithContext(
      { shopId: event.shopId, correlationId: event.correlationId ?? 'event', requestId: event.aggregateId ?? 'event' },
      async () => {
    this.logger.log(`Received VendorBillSubmitted for ${event.aggregateId}, spawning workflow`);
    await this.prisma.$transaction(async (tx) => {
       await this.engine.spawnWorkflow(tx, event.shopId, 'VENDOR_BILL', event.aggregateId, event.payload);
    });
      },
    );
  }
    
  @OnEvent('PurchaseReturnSubmitted')
  async handlePurchaseReturnSubmitted(event: any) {
    return this.tenantContext.runWithContext(
      { shopId: event.shopId, correlationId: event.correlationId ?? 'event', requestId: event.aggregateId ?? 'event' },
      async () => {
    this.logger.log(`Received PurchaseReturnSubmitted for ${event.aggregateId}`);
    await this.prisma.$transaction(async (tx) => {
       await this.engine.spawnWorkflow(tx, event.shopId, 'PURCHASE_RETURN', event.aggregateId, event.payload);
    });
      },
    );
  }
    
  @OnEvent('SupplierCreditSubmitted')
  async handleSupplierCreditSubmitted(event: any) {
    return this.tenantContext.runWithContext(
      { shopId: event.shopId, correlationId: event.correlationId ?? 'event', requestId: event.aggregateId ?? 'event' },
      async () => {
    this.logger.log(`Received SupplierCreditSubmitted for ${event.aggregateId}`);
    await this.prisma.$transaction(async (tx) => {
       await this.engine.spawnWorkflow(tx, event.shopId, 'SUPPLIER_CREDIT', event.aggregateId, event.payload);
    });
      },
    );
  }
}
