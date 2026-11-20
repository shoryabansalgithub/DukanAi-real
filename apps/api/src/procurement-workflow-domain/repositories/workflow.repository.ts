import { Injectable, NotFoundException, Inject, ConflictException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SalesEventPublisher } from '../../sales-events-domain/services/sales-event-publisher.service';
import { WorkflowEngineService } from '../services/workflow-engine.service';
import { WorkflowApprovalService } from '../services/workflow-approval.service';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { Prisma, Role } from '@prisma/client';
import { withSerializationRetry } from '../../common/db/serialization-retry';
import { CreateWorkflowDefinitionDto } from '../dto/workflow.dto';
import { assertOwnedMany } from '../../prisma/tenant-ownership';
import { ListQueryDto, MAX_LIST_TAKE, pageArgs } from '../../common/pagination';

@Injectable()
export class WorkflowRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly engine: WorkflowEngineService,
    private readonly approval: WorkflowApprovalService,
    private readonly eventPublisher: SalesEventPublisher,
    @Inject(CACHE_MANAGER) private cacheManager: Cache
  ) {}

  async listDefinitions(shopId: string, query?: ListQueryDto) {
    const { skip, take } = pageArgs(query);
    const where = { shopId, isActive: true };
    const [items, total] = await Promise.all([
      this.prisma.workflowDefinition.findMany({
        where,
        include: { steps: { orderBy: { stepOrder: 'asc' }, take: MAX_LIST_TAKE } },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip,
        take,
      }),
      this.prisma.workflowDefinition.count({ where }),
    ]);
    return { items, total, skip, take };
  }

  async createDefinition(shopId: string, payload: CreateWorkflowDefinitionDto) {
    return this.prisma.$transaction(async (tx) => {
      await assertOwnedMany(tx, 'user', payload.steps.map((s) => s.approverId), shopId, { isDeleted: false });
      await assertOwnedMany(tx, 'user', payload.steps.map((s) => s.approverId), shopId, { isDeleted: false });
      const def = await tx.workflowDefinition.create({
        data: {
          shopId,
          name: payload.name,
          documentType: payload.documentType,
          conditions: payload.conditions as Prisma.InputJsonValue | undefined,
          steps: {
            create: payload.steps.map((s, idx) => ({
              stepOrder: idx + 1,
              name: s.name,
              approverRole: s.approverRole,
              approverId: s.approverId,
              departmentId: s.departmentId,
              isParallel: s.isParallel || false,
              conditions: s.conditions as Prisma.InputJsonValue | undefined,
              slaMinutes: s.slaMinutes
            }))
          }
        }
      });
      return def;
    });
  }

  async getUserTasks(shopId: string, userId: string, query?: ListQueryDto) {
    const { skip, take } = pageArgs(query);
    const where = {
      shopId,
      status: 'PENDING' as const,
      OR: [{ assignedUserId: userId }, { delegatedToUserId: userId }],
    };
    const [items, total] = await Promise.all([
      this.prisma.workflowTask.findMany({ where, include: { workflowInstance: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], skip, take }),
      this.prisma.workflowTask.count({ where }),
    ]);
    return { items, total, skip, take };
  }

  /**
   * Decides one workflow task (release audit T4). The actor must be the
   * task's assigned user, its delegate (the task's own delegate or an active
   * delegation from the assigned user), or hold the assigned role; and never
   * the person who raised the document. The task moves PENDING -> decision by
   * compare-and-set, inside a SERIALIZABLE transaction that is retried on a
   * serialization failure.
   */
  async processTaskDecision(shopId: string, taskId: string, actor: string | { id: string; role?: Role | null }, decision: 'APPROVE' | 'REJECT', comments?: string, signature?: string) {
    const { id: actorId, role } = typeof actor === 'string' ? { id: actor, role: null } : actor;
    return withSerializationRetry(() => this.prisma.$transaction(async (tx) => {
      const task = await tx.workflowTask.findFirst({
        where: { id: taskId, shopId },
        include: { workflowInstance: true }
      });

      if (!task || task.status !== 'PENDING') throw new NotFoundException({ message: 'Pending Task not found', code: 'WORKFLOW_TASK_NOT_FOUND' });
      if (task.workflowInstance.status !== 'ACTIVE') throw new NotFoundException({ message: 'Workflow is not active', code: 'WORKFLOW_NOT_ACTIVE' });

      await this.assertMayDecide(tx, shopId, task, actorId, role ?? null);

      // 1. Process Individual Task (compare-and-set on PENDING)
      const nextTaskStatus = decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
      const moved = await tx.workflowTask.updateMany({
        where: { id: taskId, shopId, status: 'PENDING' },
        data: {
          status: nextTaskStatus,
          comments,
          digitalSignature: signature,
          completedAt: new Date()
        }
      });
      if (moved.count === 0) throw new ConflictException({ message: 'The task was decided concurrently.', code: 'WORKFLOW_TASK_STATE_CONFLICT' });

      await tx.workflowTimeline.create({
        data: {
          workflowInstanceId: task.workflowInstanceId,
          shopId,
          actorId,
          action: `TASK_${nextTaskStatus}`,
          notes: comments,
          metadata: { taskId }
        }
      });

      // 2. Evaluate Step & Instance State Machine
      await this.approval.evaluateWorkflowState(tx, shopId, task.workflowInstanceId, actorId);

      const updatedInstance = await tx.workflowInstance.findUnique({ where: { id: task.workflowInstanceId } });

      if (updatedInstance?.status === 'COMPLETED') {
         await this.eventPublisher.publish(tx, shopId, {
           eventType: 'WorkflowCompleted',
           aggregateId: updatedInstance.id,
           aggregateType: 'WorkflowInstance',
           payload: { documentId: this.extractDocumentId(updatedInstance) },
           actorId
         });
      }

      return true;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
  }

  private async assertMayDecide(
    tx: Prisma.TransactionClient,
    shopId: string,
    task: { assignedUserId: string | null; assignedRoleId: string | null; delegatedToUserId: string | null; workflowInstance: { purchaseOrderId: string | null; goodsReceiptId: string | null; vendorBillId: string | null; purchaseReturnId: string | null; supplierCreditId: string | null } },
    actorId: string,
    role: Role | null,
  ): Promise<void> {
    const now = new Date();
    let allowed = !task.assignedUserId && !task.assignedRoleId; // an unassigned step: any manager (the route's role gate)
    if (task.assignedUserId === actorId || task.delegatedToUserId === actorId) allowed = true;
    if (!allowed && task.assignedRoleId && role && task.assignedRoleId === role) allowed = true;
    if (!allowed && task.assignedUserId) {
      const delegation = await tx.workflowDelegation.findFirst({
        where: { shopId, delegatorUserId: task.assignedUserId, delegateUserId: actorId, isActive: true, startDate: { lte: now }, endDate: { gte: now } },
        select: { id: true },
      });
      allowed = !!delegation;
    }
    if (!allowed) throw new ForbiddenException({ message: 'This task is assigned to someone else.', code: 'WORKFLOW_TASK_NOT_ASSIGNED' });

    const creators = await this.documentCreators(tx, shopId, task.workflowInstance);
    if (creators.has(actorId)) throw new ForbiddenException({ message: 'The person who raised a document cannot decide its approval.', code: 'SEPARATION_OF_DUTIES' });
  }

  /** Who raised the document a workflow is bound to (its creator, and for an order whoever created, edited or submitted it). */
  private async documentCreators(tx: Prisma.TransactionClient, shopId: string, doc: { purchaseOrderId: string | null; goodsReceiptId: string | null; vendorBillId: string | null; purchaseReturnId: string | null; supplierCreditId: string | null }): Promise<Set<string>> {
    const ids = new Set<string>();
    const add = (id: string | null | undefined) => { if (id) ids.add(id); };
    if (doc.purchaseOrderId) {
      const audits = await tx.purchaseOrderAudit.findMany({ where: { purchaseOrderId: doc.purchaseOrderId, shopId, action: { in: ['CREATED', 'DRAFT_UPDATED', 'SUBMITTED'] } }, select: { actorId: true } });
      audits.forEach((a) => add(a.actorId));
    }
    if (doc.goodsReceiptId) add((await tx.goodsReceipt.findFirst({ where: { id: doc.goodsReceiptId, shopId }, select: { createdBy: true } }))?.createdBy);
    if (doc.vendorBillId) add((await tx.vendorBill.findFirst({ where: { id: doc.vendorBillId, shopId }, select: { createdBy: true } }))?.createdBy);
    if (doc.purchaseReturnId) add((await tx.purchaseReturn.findFirst({ where: { id: doc.purchaseReturnId, shopId }, select: { createdBy: true } }))?.createdBy);
    if (doc.supplierCreditId) add((await tx.supplierCreditNote.findFirst({ where: { id: doc.supplierCreditId, shopId }, select: { createdBy: true } }))?.createdBy);
    return ids;
  }

  private extractDocumentId(instance: any): string | null {
    return instance.purchaseOrderId || instance.goodsReceiptId || instance.vendorBillId || instance.purchaseReturnId || instance.supplierCreditId || null;
  }
}
