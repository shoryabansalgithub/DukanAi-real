import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length, Matches, MaxLength, MinLength } from 'class-validator';
import { IsAcceptablePassword, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from '../../auth/password-policy';

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

  /** The one password policy (src/auth/password-policy.ts): 12-72 characters, not a common password. */
  @ApiProperty({ minLength: MIN_PASSWORD_LENGTH, maxLength: MAX_PASSWORD_LENGTH })
  @IsString()
  @IsAcceptablePassword()
  password: string;
}
