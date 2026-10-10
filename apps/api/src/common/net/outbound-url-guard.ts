import { Inject, Injectable, Optional } from '@nestjs/common';
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

/** Injection token for a replacement resolver (tests); production resolves through the system DNS. */
export const OUTBOUND_RESOLVER = Symbol('OUTBOUND_RESOLVER');

export interface ResolvedTarget {
  url: URL;
  /** The vetted address every connection for this delivery must use. */
  address: string;
  family: 4 | 6;
}

export class OutboundUrlBlockedError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'OutboundUrlBlockedError';
  }
}

export type OutboundResolver = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

/** System DNS, every address (tests override the `OUTBOUND_RESOLVER` provider instead). */
export const defaultOutboundResolver: OutboundResolver = (hostname) => lookup(hostname, { all: true, verbatim: true });

/** IPv4 address (dotted quad) inside a range that must never receive a webhook. */
export function isPrivateIpv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return true;
  const [a, b] = parts;
  if (a === 0) return true; // "this" network
  if (a === 10) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local, cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 0 && parts[2] === 0) return true; // IETF protocol assignments
  if (a === 192 && b === 0 && parts[2] === 2) return true; // TEST-NET-1
  if (a === 192 && b === 168) return true; // private
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && parts[2] === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && parts[2] === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

/** IPv6 address inside a range that must never receive a webhook (IPv4-mapped addresses defer to the IPv4 rule). */
export function isPrivateIpv6(address: string): boolean {
  const lower = address.toLowerCase().split('%')[0];
  const mapped = lower.match(/^(?:0*:)*ffff:(\d+\.\d+\.\d+\.\d+)$/) ?? lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mapped) {
    if (mapped[2]) {
      const hi = parseInt(mapped[1], 16);
      const lo = parseInt(mapped[2], 16);
      return isPrivateIpv4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    return isPrivateIpv4(mapped[1]);
  }
  if (lower === '::' || lower === '::1') return true; // unspecified, loopback
  if (/^fe[89ab]/.test(lower)) return true; // link-local
  if (/^f[cd]/.test(lower)) return true; // unique local
  if (/^ff/.test(lower)) return true; // multicast
  if (lower.startsWith('64:ff9b:')) return true; // NAT64 (could map to private)
  if (lower.startsWith('2001:db8:')) return true; // documentation
  if (lower.startsWith('2002:')) return true; // 6to4 (embeds an IPv4 address)
  return false;
}

export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPrivateIpv4(address);
  if (family === 6) return isPrivateIpv6(address);
  return true;
}

/**
 * Decides whether an outbound URL may be called (roadmap 4.8, audit P2-18).
 * The check happens at send time and resolves the host through DNS first, so
 * a hostname that points at 127.0.0.1, 169.254.169.254 or a private range is
 * refused whatever it looked like when it was registered; the vetted address
 * is what the connection must then use (DNS rebinding cannot swap it).
 */
@Injectable()
export class OutboundUrlGuard {
  private readonly resolver: OutboundResolver;

  constructor(@Optional() @Inject(OUTBOUND_RESOLVER) resolver?: OutboundResolver) {
    this.resolver = resolver ?? defaultOutboundResolver;
  }

  /** Parses and vets the URL without touching the network (scheme, credentials, literal addresses). */
  parse(rawUrl: string, allowHttp: boolean): URL {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new OutboundUrlBlockedError('Webhook URL is not a valid absolute URL.', 'WEBHOOK_URL_INVALID');
    }
    if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) {
      throw new OutboundUrlBlockedError('Webhook URL must use https.', 'WEBHOOK_URL_SCHEME');
    }
    if (url.username || url.password) {
      throw new OutboundUrlBlockedError('Webhook URL must not carry credentials.', 'WEBHOOK_URL_CREDENTIALS');
    }
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
      throw new OutboundUrlBlockedError('Webhook URL must point at a public host.', 'WEBHOOK_URL_PRIVATE');
    }
    if (isIP(host) && isPrivateAddress(host)) {
      throw new OutboundUrlBlockedError('Webhook URL must point at a public address.', 'WEBHOOK_URL_PRIVATE');
    }
    return url;
  }

  /** Vets the URL and resolves its host; every returned address must be public. */
  async resolve(rawUrl: string, allowHttp: boolean): Promise<ResolvedTarget> {
    const url = this.parse(rawUrl, allowHttp);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(host)) return { url, address: host, family: isIP(host) as 4 | 6 };

    let addresses: Array<{ address: string; family: number }>;
    try {
      addresses = await this.resolver(host);
    } catch {
      throw new OutboundUrlBlockedError(`Webhook host ${host} does not resolve.`, 'WEBHOOK_URL_UNRESOLVABLE');
    }
    if (addresses.length === 0) throw new OutboundUrlBlockedError(`Webhook host ${host} does not resolve.`, 'WEBHOOK_URL_UNRESOLVABLE');
    // One private answer poisons the whole set: a resolver could hand the private one to the connection.
    const offender = addresses.find((a) => isPrivateAddress(a.address));
    if (offender) throw new OutboundUrlBlockedError(`Webhook host ${host} resolves to a private address.`, 'WEBHOOK_URL_PRIVATE');
    const first = addresses[0];
    return { url, address: first.address, family: (isIP(first.address) || 4) as 4 | 6 };
  }
}
