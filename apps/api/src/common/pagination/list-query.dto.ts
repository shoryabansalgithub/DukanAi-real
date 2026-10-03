import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * Hard cap on every list endpoint (roadmap 5.6). A list answers at most
 * `MAX_LIST_TAKE` rows whatever the caller asks for, and `DEFAULT_LIST_TAKE`
 * when it asks for nothing. A caller that wants more pages through `skip`.
 */
export const DEFAULT_LIST_TAKE = 100;
export const MAX_LIST_TAKE = 200;

/** `?skip=&take=` for lists that were unpaged (validated: a bad value is 400, never 500). */
export class ListQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @ApiPropertyOptional({ default: 0 }) skip?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(MAX_LIST_TAKE) @ApiPropertyOptional({ default: DEFAULT_LIST_TAKE, maximum: MAX_LIST_TAKE }) take?: number;
}

/** `?limit=&offset=` for the procurement lists that already used those names (same cap). */
export class LimitOffsetQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @ApiPropertyOptional({ default: 0 }) offset?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(MAX_LIST_TAKE) @ApiPropertyOptional({ default: 50, maximum: MAX_LIST_TAKE }) limit?: number;
}

export interface PageArgs {
  skip: number;
  take: number;
}

/** Clamps a requested page size into `1..MAX_LIST_TAKE`, falling back to `fallback` when absent or not a number. */
export function clampTake(requested: number | undefined, fallback: number = DEFAULT_LIST_TAKE): number {
  const value = typeof requested === 'number' && Number.isFinite(requested) ? Math.floor(requested) : fallback;
  return Math.max(1, Math.min(value, MAX_LIST_TAKE));
}

export function clampSkip(requested: number | undefined): number {
  return typeof requested === 'number' && Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : 0;
}

/**
 * The Prisma `skip`/`take` for a validated query. The DTO already refused
 * out-of-range values; the clamp is defence in depth for a direct caller.
 */
export function pageArgs(query: ListQueryDto | undefined, defaultTake: number = DEFAULT_LIST_TAKE): PageArgs {
  return { skip: clampSkip(query?.skip), take: clampTake(query?.take, defaultTake) };
}

/** The same for the `limit`/`offset` spelling. */
export function limitOffsetArgs(query: LimitOffsetQueryDto | undefined, defaultLimit: number = 50): { limit: number; offset: number } {
  return { limit: clampTake(query?.limit, defaultLimit), offset: clampSkip(query?.offset) };
}
