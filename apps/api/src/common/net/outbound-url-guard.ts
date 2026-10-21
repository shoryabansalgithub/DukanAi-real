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
  if (a === 192 && b === 88 && parts[2] === 99) return true; // 6to4 relay anycast (deprecated, RFC 7526)
  if (a === 192 && b === 168) return true; // private
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && parts[2] === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && parts[2] === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

/**
 * The eight 16-bit groups of an IPv6 address (`::` expanded, a trailing
 * dotted quad folded into the last two groups), or null when it is not one.
 */
export function ipv6Groups(address: string): number[] | null {
  let text = address.toLowerCase().split('%')[0];
  const quad = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (quad) {
    const octets = quad.slice(1).map(Number);
    if (octets.some((o) => o > 255)) return null;
    text = `${text.slice(0, quad.index)}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string) => (part === '' ? [] : part.split(':'));
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  if (groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

/**
 * IPv6 address inside a range that must never receive a webhook (audit R11).
 * Only global unicast (2000::/3) may be called, minus its special-purpose
 * blocks; an IPv4-mapped address (::ffff:a.b.c.d) defers to the IPv4 rule.
 * Everything else is refused, including the forms that embed an IPv4
 * address a resolver or a translator could hand to the kernel:
 * IPv4-compatible ::/96 ([::7f00:1], [::a9fe:a9fe]), SIIT ::ffff:0:0:0/96
 * ([::ffff:0:7f00:1]), NAT64 64:ff9b::/96 and 64:ff9b:1::/48, the
 * discard-only 100::/64, site-local fec0::/10, link-local, unique-local and
 * multicast; inside 2000::/3: Teredo and the other IETF assignments of
 * 2001::/23, documentation 2001:db8::/32 and 3fff::/20, and 6to4 2002::/16.
 */
export function isPrivateIpv6(address: string): boolean {
  const g = ipv6Groups(address);
  if (!g) return true;
  // IPv4-mapped ::ffff:a.b.c.d (in any spelling): the IPv4 rule decides.
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff) {
    return isPrivateIpv4(`${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`);
  }
  // Global unicast is 2000::/3; nothing outside it is a public destination.
  if ((g[0] & 0xe000) !== 0x2000) return true;
  if (g[0] === 0x2001 && g[1] < 0x0200) return true; // 2001::/23: Teredo 2001::/32, benchmarking, ORCHID, AMT ...
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  if (g[0] === 0x2002) return true; // 6to4 (embeds an IPv4 address)
  if (g[0] === 0x3fff && g[1] < 0x1000) return true; // documentation 3fff::/20 (RFC 9637)
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
