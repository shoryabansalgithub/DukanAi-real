import { isPrivateAddress, isPrivateIpv4, isPrivateIpv6, OutboundUrlBlockedError, OutboundUrlGuard } from './outbound-url-guard';

describe('OutboundUrlGuard (roadmap 4.8)', () => {
  describe('address classification', () => {
    it('blocks loopback, private, link-local, CGNAT, documentation, multicast and malformed IPv4', () => {
      for (const ip of ['127.0.0.1', '127.255.255.254', '10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '192.0.2.10', '198.51.100.7', '203.0.113.9', '224.0.0.1', '255.255.255.255', '1.2.3', '300.1.1.1']) {
        expect({ ip, blocked: isPrivateIpv4(ip) }).toEqual({ ip, blocked: true });
      }
    });

    it('allows public IPv4', () => {
      for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '172.15.255.255', '100.128.0.1', '203.0.114.1', '52.1.2.3']) {
        expect({ ip, blocked: isPrivateIpv4(ip) }).toEqual({ ip, blocked: false });
      }
    });

    it('blocks IPv6 loopback, unique-local, link-local, multicast, mapped-private and documentation ranges', () => {
      for (const ip of ['::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:10.1.2.3', '::ffff:7f00:1', '2001:db8::1', '64:ff9b::a00:1', '2002:c0a8:101::1']) {
        expect({ ip, blocked: isPrivateIpv6(ip) }).toEqual({ ip, blocked: true });
      }
      expect(isPrivateIpv6('2606:4700:4700::1111')).toBe(false);
      expect(isPrivateIpv6('::ffff:8.8.8.8')).toBe(false);
      expect(isPrivateAddress('not-an-ip')).toBe(true);
    });
  
  });

  describe('the IPv6 forms that embed or reach an internal address (audit R11)', () => {
    it.each([
      ['::7f00:1', 'IPv4-compatible 127.0.0.1 (::/96)'],
      ['::a9fe:a9fe', 'IPv4-compatible 169.254.169.254 (::/96)'],
      ['::127.0.0.1', 'IPv4-compatible, dotted'],
      ['::8.8.8.8', 'IPv4-compatible is deprecated even for a public address'],
      ['::ffff:0:7f00:1', 'SIIT ::ffff:0:0:0/96'],
      ['::ffff:0:a9fe:a9fe', 'SIIT to the metadata address'],
      ['0:0:0:0:0:ffff:a9fe:a9fe', 'IPv4-mapped, long form'],
      ['fec0::1', 'site-local fec0::/10'],
      ['feff::1', 'the rest of fe80::/9'],
      ['100::1', 'discard-only 100::/64'],
      ['2001::1', 'Teredo 2001::/32'],
      ['2001:0:4136:e378:8000:63bf:3fff:fdd2', 'a Teredo address'],
      ['2001:10::1', 'ORCHID 2001:10::/28'],
      ['64:ff9b:1::a9fe:a9fe', 'local-use NAT64 64:ff9b:1::/48'],
      ['3fff::1', 'documentation 3fff::/20'],
      ['::ffff:192.88.99.1', '6to4 relay anycast, mapped'],
      ['fe80::1%eth0', 'link-local with a zone'],
      ['1::2::3', 'malformed'],
      ['12345::1', 'malformed group'],
    ])('blocks %s (%s)', (ip) => {
      expect(isPrivateIpv6(ip)).toBe(true);
    });

    it('still allows global unicast and public mapped addresses', () => {
      for (const ip of ['2606:4700:4700::1111', '2a00:1450:4001:80b::200e', '2400:cb00::1', '::ffff:8.8.8.8', '2001:4860:4860::8888']) {
        expect({ ip, blocked: isPrivateIpv6(ip) }).toEqual({ ip, blocked: false });
      }
    });

    it('blocks 192.88.99.0/24 (6to4 relay anycast)', () => {
      expect(isPrivateIpv4('192.88.99.1')).toBe(true);
      expect(isPrivateIpv4('192.88.98.1')).toBe(false);
    });

    it('a bracketed literal in a webhook URL is refused at registration', () => {
      const guard = new OutboundUrlGuard(async () => []);
      for (const url of ['https://[::7f00:1]/hook', 'https://[::a9fe:a9fe]/hook', 'https://[::ffff:0:7f00:1]/hook', 'https://[fec0::1]/hook', 'https://[2001::1]/hook']) {
        expect(() => guard.parse(url, false)).toThrow(OutboundUrlBlockedError);
      }
    });

    it('a host name that resolves to such a form is refused at send time', async () => {
      const guard = new OutboundUrlGuard(async () => [{ address: '::a9fe:a9fe', family: 6 }]);
      await expect(guard.resolve('https://hooks.example.com/x', false)).rejects.toMatchObject({ code: 'WEBHOOK_URL_PRIVATE' });
    });
  });

  describe('parse', () => {
    const guard = new OutboundUrlGuard(async () => [{ address: '93.184.216.34', family: 4 }]);

    it('accepts https to a public host and rejects http unless allowed', () => {
      expect(guard.parse('https://hooks.example.com/in', false).hostname).toBe('hooks.example.com');
      expect(() => guard.parse('http://hooks.example.com/in', false)).toThrow(OutboundUrlBlockedError);
      expect(guard.parse('http://hooks.example.com/in', true).protocol).toBe('http:');
    });

    it('rejects credentials, other schemes, localhost names and literal private addresses', () => {
      const blocked = (url: string) => {
        try {
          guard.parse(url, true);
          return null;
        } catch (e) {
          return (e as OutboundUrlBlockedError).code;
        }
      };
      expect(blocked('https://user:pw@hooks.example.com/')).toBe('WEBHOOK_URL_CREDENTIALS');
      expect(blocked('ftp://hooks.example.com/')).toBe('WEBHOOK_URL_SCHEME');
      expect(blocked('file:///etc/passwd')).toBe('WEBHOOK_URL_SCHEME');
      expect(blocked('https://localhost/')).toBe('WEBHOOK_URL_PRIVATE');
      expect(blocked('https://api.localhost/')).toBe('WEBHOOK_URL_PRIVATE');
      expect(blocked('https://printer.local/')).toBe('WEBHOOK_URL_PRIVATE');
      expect(blocked('https://169.254.169.254/latest/meta-data/')).toBe('WEBHOOK_URL_PRIVATE');
      expect(blocked('https://[::1]/')).toBe('WEBHOOK_URL_PRIVATE');
      expect(blocked('https://[::ffff:10.0.0.1]/')).toBe('WEBHOOK_URL_PRIVATE');
      expect(blocked('not a url')).toBe('WEBHOOK_URL_INVALID');
    });
  });

  describe('resolve', () => {
    it('resolves the host and returns the first public address', async () => {
      const guard = new OutboundUrlGuard(async () => [{ address: '93.184.216.34', family: 4 }, { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 }]);
      const target = await guard.resolve('https://hooks.example.com/in', false);
      expect(target.address).toBe('93.184.216.34');
      expect(target.family).toBe(4);
      expect(target.url.pathname).toBe('/in');
    });

    it('refuses a host that resolves to a private address (even alongside a public one) or does not resolve', async () => {
      const rebinding = new OutboundUrlGuard(async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }]);
      await expect(rebinding.resolve('https://evil.example.com/', false)).rejects.toMatchObject({ code: 'WEBHOOK_URL_PRIVATE' });
      const metadata = new OutboundUrlGuard(async () => [{ address: '169.254.169.254', family: 4 }]);
      await expect(metadata.resolve('https://metadata.example.com/', false)).rejects.toMatchObject({ code: 'WEBHOOK_URL_PRIVATE' });
      const dead = new OutboundUrlGuard(async () => {
        throw new Error('ENOTFOUND');
      });
      await expect(dead.resolve('https://nowhere.example.com/', false)).rejects.toMatchObject({ code: 'WEBHOOK_URL_UNRESOLVABLE' });
      const empty = new OutboundUrlGuard(async () => []);
      await expect(empty.resolve('https://nowhere.example.com/', false)).rejects.toMatchObject({ code: 'WEBHOOK_URL_UNRESOLVABLE' });
    });

    it('skips DNS for a literal public address', async () => {
      const resolver = jest.fn();
      const guard = new OutboundUrlGuard(resolver);
      const target = await guard.resolve('https://8.8.8.8/hook', false);
      expect(target.address).toBe('8.8.8.8');
      expect(resolver).not.toHaveBeenCalled();
    });
  });
});
