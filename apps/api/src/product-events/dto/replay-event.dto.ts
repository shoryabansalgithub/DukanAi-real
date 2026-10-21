import { IsString, MaxLength } from 'class-validator';

export class ReplayEventDto {
  @IsString()
  @MaxLength(191)
  eventId: string;
}
