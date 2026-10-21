import { IsOptional, IsString, MaxLength } from 'class-validator';

/** Body of every approve / reject / submit step: an optional comment and an optional digital signature. */
export class ApprovalDecisionDto {
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  comments?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4096)
  signature?: string;
}
