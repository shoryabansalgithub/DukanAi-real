import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length, Matches } from 'class-validator';

/** Refresh tokens are 40 random bytes in hex (`AuthService.login`). */
export const REFRESH_TOKEN_LENGTH = 80;

export class RefreshTokenDto {
  @ApiProperty({ description: 'The refresh token issued by login or the previous refresh', minLength: REFRESH_TOKEN_LENGTH, maxLength: REFRESH_TOKEN_LENGTH })
  @IsString()
  @Length(REFRESH_TOKEN_LENGTH, REFRESH_TOKEN_LENGTH)
  @Matches(/^[0-9a-f]+$/, { message: 'refresh_token must be a hex string' })
  refresh_token: string;
}
