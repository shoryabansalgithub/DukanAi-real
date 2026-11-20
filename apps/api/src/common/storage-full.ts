/**
 * A write that failed because the volume (ENOSPC) or the user's quota (EDQUOT)
 * is full (roadmap 9.18, "fill the storage volume"). The global filter answers
 * it 507 STORAGE_FULL instead of 500; writers that create files remove what
 * they created before it reaches the client, so the same request succeeds once
 * space is freed.
 */
const FULL_CODES = new Set(['ENOSPC', 'EDQUOT']);

export function isStorageFull(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 3; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && FULL_CODES.has(code)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
