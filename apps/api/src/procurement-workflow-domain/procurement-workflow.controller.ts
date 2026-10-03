import { Controller, Get, Post, Param, Body, Query } from '@nestjs/common';
import { ListQueryDto, PagedList } from '../common/pagination';
import { CurrentShop } from '../iam/decorators/current-shop.decorator';
import { CurrentUser } from '../iam/decorators/current-user.decorator';
import { WorkflowRepository } from './repositories/workflow.repository';
import { WorkflowDelegationService } from './services/workflow-delegation.service';
import type { Request } from 'express';
import { ADMIN_ROLES, MANAGEMENT_ROLES } from '../auth/role-sets';
import { Roles } from '../auth/roles.decorator';
import { ApprovalDecisionDto } from '../common/dto/approval-decision.dto';
import { CreateDelegationDto, CreateWorkflowDefinitionDto } from './dto/workflow.dto';

@Controller('procurement-workflows')
export class ProcurementWorkflowController {
  constructor(
    private readonly repository: WorkflowRepository,
    private readonly delegation: WorkflowDelegationService
  ) {}

  @Get('tasks/pending')
  @PagedList()
  async getPendingTasks(@CurrentShop() shopId: string, @CurrentUser('id') actorId: string, @Query() query: ListQueryDto) {
    return this.repository.getUserTasks(shopId, actorId, query);
  }

  @Roles(...MANAGEMENT_ROLES)
  @Post('tasks/:taskId/approve')
  async approveTask(@CurrentShop() shopId: string, @Param('taskId') taskId: string, @CurrentUser('id') actorId: string, @Body() body: ApprovalDecisionDto) {
    return this.repository.processTaskDecision(shopId, taskId, actorId, 'APPROVE', body.comments, body.signature);
  }

  @Roles(...MANAGEMENT_ROLES)
  @Post('tasks/:taskId/reject')
  async rejectTask(@CurrentShop() shopId: string, @Param('taskId') taskId: string, @CurrentUser('id') actorId: string, @Body() body: ApprovalDecisionDto) {
    return this.repository.processTaskDecision(shopId, taskId, actorId, 'REJECT', body.comments);
  }

  @Roles(...MANAGEMENT_ROLES)
  @Post('delegations')
  async createDelegation(@CurrentShop() shopId: string, @CurrentUser('id') actorId: string, @Body() body: CreateDelegationDto) {
    return this.delegation.createDelegation(shopId, actorId, body.delegateUserId, new Date(body.startDate), new Date(body.endDate), body.notes);
  }

  @Get('definitions')
  @PagedList()
  async listDefinitions(@CurrentShop() shopId: string, @Query() query: ListQueryDto) {
    return this.repository.listDefinitions(shopId, query);
  }

  @Roles(...ADMIN_ROLES)
  @Post('definitions')
  async createDefinition(@CurrentShop() shopId: string, @Body() body: CreateWorkflowDefinitionDto) {
    return this.repository.createDefinition(shopId, body);
  }
}
