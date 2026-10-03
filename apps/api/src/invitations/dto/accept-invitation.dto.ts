import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length, Matches, MaxLength, MinLength } from 'class-validator';

export class AcceptInvitationDto {
  @ApiProperty({ description: 'The invitation code from the email (64 hex characters)' })
  @IsString()
  @Length(64, 64)
  @Matches(/^[0-9a-f]+$/, { message: 'token must be a hex string' })
  token: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name: string;

  /** bcrypt hashes the first 72 bytes only, so longer passwords are refused rather than silently truncated. */
  @ApiProperty({ minLength: 8, maxLength: 72 })
  @IsString()
  @MinLength(8)
  @MaxLength(72)
  password: string;
}
