import { IsString, MaxLength } from 'class-validator';

export class ReplayAggregateDto {
  @IsString()
  @MaxLength(191)
  aggregateId: string;
}
