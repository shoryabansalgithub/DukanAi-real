import { sanitizeCustomerName } from './storage-path.util';

/**
 * Matching a pre-tenant customer folder (`<root>/Customers/<folder>`) to a
 * customer (roadmap 8.4, audit P3), for `scripts/migrate-storage.ts`. The
 * legacy layout named a folder `sanitizeCustomerName(customer.name)`
 * ("Ramesh Kumar" -> "Ramesh_Kumar"), and carried no shop. So a folder
 * matches a customer whose sanitised name is the folder name, and only when
 * exactly one live customer of the shop being migrated has it AND no
 * customer of another shop does: the folder may hold another shop's
 * documents, and a guess would hand them to the wrong shop.
 */
export interface LegacyCandidate {
  id: string;
  shopId: string;
  name: string;
}

export type LegacyMatch =
  | { kind: 'match'; customerId: string }
  | { kind: 'none' }
  | { kind: 'ambiguous'; reason: string };

/** The legacy folder name of a customer name, or null when the name has none (it could not have had a folder). */
export function legacyFolderName(name: string): string | null {
  try {
    return sanitizeCustomerName(name);
  } catch {
    return null;
  }
}

/**
 * A `LIKE` pattern every name that sanitises to `folder` satisfies (a
 * superset: the exact comparison is `legacyFolderName`). The folder holds
 * letters, digits and `_` only; each `_` stood for one or more replaced
 * characters, and leading or trailing ones were trimmed.
 */
export function legacyNamePattern(folder: string): string {
  return `%${folder.split('_').filter(Boolean).join('%')}%`;
}

export function matchLegacyFolder(folder: string, shopId: string, candidates: LegacyCandidate[]): LegacyMatch {
  const exact = candidates.filter((c) => legacyFolderName(c.name) === folder);
  const own = exact.filter((c) => c.shopId === shopId);
  const otherShops = new Set(exact.filter((c) => c.shopId !== shopId).map((c) => c.shopId));
  if (own.length === 0) return { kind: 'none' };
  if (own.length > 1) return { kind: 'ambiguous', reason: `${own.length} customers of this shop have a name that maps to this folder; move it by hand` };
  if (otherShops.size > 0) {
    return { kind: 'ambiguous', reason: `customers of ${otherShops.size} other shop(s) have a name that maps to this folder: it may be theirs; move it by hand` };
  }
  return { kind: 'match', customerId: own[0].id };
}
