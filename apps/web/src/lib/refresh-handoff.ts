/**
 * Hand-off of a rotated refresh token to the callers that still hold it
 * (roadmap 9.17; found by the simulated business day).
 *
 * The API rotates refresh tokens: every exchange consumes the token and
 * issues a successor, and a consumed token presented again is treated as
 * theft and ends every session of the account. On this server the exchange
 * runs inside NextAuth's `jwt` callback, which several requests of one
 * browser invoke at once (the dashboard's polls, the session endpoint, a
 * page load). Sharing the exchange only while it is in flight is not enough:
 * a request that arrives a moment after the first exchange finished still
 * carries the browser's old cookie, so it presents the consumed token and
 * the account is signed out of everything after exactly one token lifetime.
 *
 * So the outcome of an exchange is kept, keyed by the token it consumed,
 * for a grace window: every later caller with that token receives the same
 * successor pair (which its own response cookie then carries) instead of a
 * second exchange. A failed exchange is not kept, so a caller may try again.
 */
export interface RefreshHandoffOptions {
  /** How long a successful exchange answers for its consumed token (ms). */
  graceMs: number;
  /** Entries kept at most; the oldest are evicted first. */
  maxEntries?: number;
  now?: () => number;
}

interface Entry<T> {
  promise: Promise<T>;
  at: number;
}

export class RefreshHandoff<T extends { ok: boolean }> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly graceMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: RefreshHandoffOptions) {
    this.graceMs = options.graceMs;
    this.maxEntries = options.maxEntries ?? 1000;
    this.now = options.now ?? (() => Date.now());
  }

  /** The exchange for `token`: started now, or the one started within the grace window. */
  once(token: string, exchange: () => Promise<T>): Promise<T> {
    this.evict();
    const existing = this.entries.get(token);
    if (existing) return existing.promise;
    const at = this.now();
    const promise = exchange().then(
      (outcome) => {
        if (!outcome.ok) this.entries.delete(token);
        return outcome;
      },
      (error: unknown) => {
        this.entries.delete(token);
        throw error;
      },
    );
    this.entries.set(token, { promise, at });
    return promise;
  }

  /** Number of tokens currently answered from memory (tests and diagnostics). */
  get size(): number {
    this.evict();
    return this.entries.size;
  }

  private evict(): void {
    const cutoff = this.now() - this.graceMs;
    for (const [token, entry] of this.entries) {
      if (entry.at < cutoff) this.entries.delete(token);
    }
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}
