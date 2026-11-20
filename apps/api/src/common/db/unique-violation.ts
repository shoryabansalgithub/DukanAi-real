import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/**
 * Prisma P2002 helpers (roadmap 3.10). The unique indexes are the duplicate
 * guard; a service may still pre-check for a friendlier message, but the
 * index decides under concurrency, and its rejection is mapped here to the
 * same 409 code the pre-check would have produced.
 */
export function uniqueViolationTarget(error: unknown): string | null {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') return null;
  const target = (error.meta as { target?: unknown } | undefined)?.target;
  return Array.isArray(target) ? target.join(',') : target === undefined ? '' : String(target);
}

/** True when `error` is a P2002 whose index name (or column list) contains `fragment`. */
export function isUniqueViolation(error: unknown, fragment?: string): boolean {
  const target = uniqueViolationTarget(error);
  return target !== null && (fragment === undefined || target.includes(fragment));
}

/**
 * Rethrows a P2002 as a domain 409 when its index matches one of `mappings`
 * (first match wins); any other error is rethrown untouched.
 */
export function rethrowUniqueViolation(error: unknown, mappings: Array<{ index: string; code: string; message: string; details?: Record<string, unknown> }>): never {
  const target = uniqueViolationTarget(error);
  if (target !== null) {
    const hit = mappings.find((m) => target.includes(m.index));
    if (hit) throw new ConflictException({ message: hit.message, code: hit.code, details: hit.details });
  }
  throw error;
}
