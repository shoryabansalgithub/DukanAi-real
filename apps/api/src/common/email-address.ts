import { domainToASCII } from 'url';

/**
 * The one comparable form of an email address (audit P0-1). `User.email` is
 * stored under `utf8mb4_unicode_ci`, which compares case- AND accent-
 * insensitively (`test.local` = `tést.local`, `gmail` = `gmàil`, `ss` = `ß`)
 * on MySQL 8 and MariaDB alike, while those are different, separately
 * registrable domains once encoded for delivery (`tést.local` is
 * `xn--tst-dma.local`). A lookup by email therefore answers for addresses the
 * account does not own; every lookup re-checks the row it got with
 * `sameEmailAddress`, and every outgoing message goes to the stored address,
 * never to the one a request typed.
 *
 * Canonical form: trimmed, Unicode NFC, lower case, domain in its ASCII
 * (punycode) form. An address whose domain cannot be encoded keeps its
 * lower-cased form, so it can only ever equal itself.
 */
export function canonicalEmail(raw: string): string {
  const value = raw.trim().normalize('NFC').toLowerCase();
  const at = value.lastIndexOf('@');
  if (at <= 0 || at === value.length - 1) return value;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  const ascii = domainToASCII(domain);
  return `${local}@${ascii === '' ? domain : ascii.toLowerCase()}`;
}

/** True only when both addresses are the same mailbox in canonical form. */
export function sameEmailAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return canonicalEmail(a) === canonicalEmail(b);
}
