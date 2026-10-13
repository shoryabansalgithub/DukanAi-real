import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, MaxLength } from 'class-validator';

export class TransferOwnershipDto {
  @ApiProperty({ description: 'The ID of the new owner (must be an existing user in the shop)' })
  @IsString()
  @IsNotEmpty()
  newOwnerId: string;

  @ApiProperty({ description: 'The current owner password for security verification', maxLength: 72 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(72)
  currentPassword: string;
}
