import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

/** `PATCH /users/:id/suspend`: false suspends the account, true reinstates it. Required (audit A7). */
export class SuspendUserDto {
  @ApiProperty({ description: 'false suspends the account, true reinstates it' })
  @IsBoolean()
  isActive!: boolean;
}
