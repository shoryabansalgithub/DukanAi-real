import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsObject, IsOptional, IsString, MaxLength, Min, ValidateNested } from 'class-validator';

export class CreateDelegationDto {
  @IsString()
  delegateUserId: string;

  @IsDateString()
  startDate: string;

  @IsDateString()
  endDate: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export const WORKFLOW_DOCUMENT_TYPES = ['PURCHASE_ORDER', 'VENDOR_BILL', 'GRN', 'PURCHASE_RETURN', 'SUPPLIER_CREDIT'] as const;

export class WorkflowStepDto {
  @IsString()
  @MaxLength(191)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  approverRole?: string;

  @IsOptional()
  @IsString()
  approverId?: string;

  @IsOptional()
  @IsString()
  departmentId?: string;

  @IsOptional()
  @IsBoolean()
  isParallel?: boolean;

  @IsOptional()
  @IsObject()
  conditions?: Record<string, unknown>;

  @IsOptional()
  @IsInt()
  @Min(1)
  slaMinutes?: number;
}

export class CreateWorkflowDefinitionDto {
  @IsString()
  @MaxLength(191)
  name: string;

  @IsIn(WORKFLOW_DOCUMENT_TYPES)
  documentType: (typeof WORKFLOW_DOCUMENT_TYPES)[number];

  @IsOptional()
  @IsObject()
  conditions?: Record<string, unknown>;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => WorkflowStepDto)
  steps: WorkflowStepDto[];
}
