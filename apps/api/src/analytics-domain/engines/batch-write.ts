/** Rows per multi-row INSERT of the nightly analytics writers: well under MySQL's packet limit for these row shapes. */
export const ANALYTICS_WRITE_BATCH = 500;

export function chunk<T>(items: ReadonlyArray<T>, size: number = ANALYTICS_WRITE_BATCH): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size));
  return batches;
}
