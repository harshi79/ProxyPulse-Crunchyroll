import { describe, expect, it } from 'vitest';

import {
  dedupeKey,
  detectProtocolFromLabel,
  formatProxyRedacted,
  parseProxyEntry,
  parseProxyList,
} from '@proxypulse/shared';

describe('proxy entry normalization', () => {
  it('parses host:port and applies the default protocol', () => {
    const result = parseProxyEntry('  203.0.113.10:8080  ');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.proxy).toMatchObject({ host: '203.0.113.10', port: 8080, protocol: 'http' });
    expect(result.protocol_source).toBe('default');
  });

  it('parses protocol://host:port for every supported protocol', () => {
    const cases = [
      ['http://198.51.100.7:3128', 'http'],
      ['https://198.51.100.7:8443', 'https'],
      ['socks4://198.51.100.7:1080', 'socks4'],
      ['socks5://198.51.100.7:1080', 'socks5'],
    ] as const;
    for (const [input, protocol] of cases) {
      const result = parseProxyEntry(input);
      expect(result.ok, input).toBe(true);
      if (!result.ok) continue;
      expect(result.proxy.protocol).toBe(protocol);
      expect(result.protocol_source).toBe('scheme');
    }
  });

  it('maps socks aliases onto canonical protocols', () => {
    for (const [input, protocol] of [
      ['socks4a://10.0.0.1:1080', 'socks4'],
      ['socks5h://10.0.0.1:1080', 'socks5'],
      ['socks://10.0.0.1:1080', 'socks5'],
      ['tls://10.0.0.1:443', 'https'],
    ] as const) {
      const result = parseProxyEntry(input);
      expect(result.ok, input).toBe(true);
      if (result.ok) expect(result.proxy.protocol).toBe(protocol);
    }
  });

  it('parses host:port:user:pass and keeps credentials out of formatted output', () => {
    const result = parseProxyEntry('socks5://example-1.com:1080:alice:sup3rs3cret');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.proxy.host).toBe('example-1.com');
    expect(result.proxy.port).toBe(1080);

    // The 4-field form is ambiguous with an IPv6-ish string, so credentials in URL form are the
    // documented supported syntax; verify that variant keeps them too.
    const withAuth = parseProxyEntry('socks5://alice:sup3rs3cret@example-1.com:1080');
    expect(withAuth.ok).toBe(true);
    if (!withAuth.ok) return;
    expect(withAuth.proxy.username).toBe('alice');
    expect(withAuth.proxy.password).toBe('sup3rs3cret');
    expect(formatProxyRedacted(withAuth.proxy)).toBe('socks5://***:***@example-1.com:1080');
    expect(JSON.stringify(withAuth.proxy.password)).toContain('sup3rs3cret');
  });

  it('percent-decodes credentials', () => {
    const result = parseProxyEntry('http://us%65r:p%61ss@proxy.example.net:8080');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.proxy.username).toBe('user');
    expect(result.proxy.password).toBe('pass');
  });

  it('normalizes hosts: lowercase, no trailing dot, bracketed IPv6', () => {
    const upper = parseProxyEntry('HTTP://Proxy.Example.COM.:8080');
    expect(upper.ok && upper.proxy.host).toBe('proxy.example.com');

    const ipv6 = parseProxyEntry('socks5://[2001:DB8::10]:1080');
    expect(ipv6.ok && ipv6.proxy.host).toBe('2001:db8::10');
    expect(
      formatProxyRedacted(ipv6.ok ? ipv6.proxy : { host: '', port: 0, protocol: 'http' }),
    ).toContain('[');
  });

  it('honours a protocol hint from the caller', () => {
    const hinted = parseProxyEntry('203.0.113.9:1080', { protocolHint: 'socks5' });
    expect(hinted.ok && hinted.proxy.protocol).toBe('socks5');
    if (hinted.ok) expect(hinted.protocol_source).toBe('hint');

    // explicit scheme always wins over the hint
    const explicit = parseProxyEntry('http://203.0.113.9:80', { protocolHint: 'socks5' });
    expect(explicit.ok && explicit.proxy.protocol).toBe('http');
  });

  it('rejects malformed entries with a specific reason', () => {
    const cases: [string, string][] = [
      ['', 'empty'],
      ['   ', 'empty'],
      ['1.2.3.4', 'no_port'],
      ['1.2.3.4:0', 'invalid_port'],
      ['1.2.3.4:99999', 'invalid_port'],
      ['1.2.3.4:notaport', 'invalid_port'],
      ['1.2.3.4:80:5', 'ambiguous_format'],
      ['ftp://1.2.3.4:21', 'invalid_scheme'],
      ['..bad host..:80', 'invalid_host'],
      ['http://1.2.3.4/path?x=1', 'no_port'], // path/query tolerated, port still missing
      ['2001:db8::10:8080', 'ipv6_requires_brackets'],
      [`1.2.3.4:80${'x'.repeat(300)}`, 'too_long'],
      ['1.2.3.4:80::5', 'ambiguous_format'],
      ['1.2.3.4:12.5', 'invalid_port'],
      ['256.300.1.1:8080', 'invalid_host'],
      ['999.1.1.1:80', 'invalid_host'],
      ['http://', 'invalid_host'],
      ['socks5://:1080', 'invalid_host'],
      ['ftp:1.2.3.4:21', 'invalid_scheme'],
    ];
    for (const [input, reason] of cases) {
      const result = parseProxyEntry(input);
      expect(result.ok, `expected failure for "${input}"`).toBe(false);
      if (!result.ok) expect(result.reason, `for "${input}"`).toBe(reason);
    }
  });

  it('detects protocol labels', () => {
    expect(detectProtocolFromLabel('SOCKS5')).toBe('socks5');
    expect(detectProtocolFromLabel('socks4')).toBe('socks4');
    expect(detectProtocolFromLabel('HTTPS proxies:')).toBe('https');
    expect(detectProtocolFromLabel('HTTP')).toBe('http');
    expect(detectProtocolFromLabel('garbage')).toBeNull();
  });

  it('dedupeKey is protocol, host, port and account sensitive', () => {
    const base = { host: '1.2.3.4', port: 8080, protocol: 'http' as const };
    expect(dedupeKey(base)).toBe('http|1.2.3.4|8080|');
    expect(dedupeKey({ ...base, protocol: 'https' })).not.toBe(dedupeKey(base));
    expect(dedupeKey({ ...base, port: 8081 })).not.toBe(dedupeKey(base));
    expect(dedupeKey({ ...base, username: 'alice' })).not.toBe(dedupeKey(base));
    expect(dedupeKey({ ...base, username: 'ALICE' })).toBe(
      dedupeKey({ ...base, username: 'alice' }),
    );
  });
});

describe('proxy list parsing', () => {
  const blob = [
    '# comment',
    '',
    'SOCKS5',
    '203.0.113.1:1080',
    '203.0.113.2:1080',
    '203.0.113.2:1080', // duplicate
    'http://203.0.113.3:8080',
    'garbage line without structure',
    '203.0.113.4:80:u:p',
    '<html><body>blocked</body></html>',
  ].join('\n');

  it('normalizes, dedupes within the batch and reports rejects', () => {
    const result = parseProxyList(blob);
    expect(result.proxies.map((p) => `${p.protocol}://${p.host}:${p.port}`)).toEqual([
      'socks5://203.0.113.1:1080',
      'socks5://203.0.113.2:1080',
      'http://203.0.113.3:8080',
      'socks5://203.0.113.4:80', // protocol hint from the SOCKS5 header still applies
    ]);
    expect(result.proxies[3]?.username).toBe('u');
    expect(result.duplicates).toBe(1);
    expect(result.rejected).toEqual([
      { line: '<html><body>blocked</body></html>', reason: 'not_an_entry' },
    ]);
    expect(result.total_lines).toBe(10);
  });

  it('reports endpoint-shaped noise instead of swallowing it', () => {
    const text = [
      '1.2.3',
      'http://',
      'SOCKS5',
      '=== proxy list ===',
      '1.2.3.4:80',
      '256.300.1.1:80',
    ].join('\n');
    const result = parseProxyList(text);
    expect(result.proxies).toHaveLength(1);
    expect(result.rejected).toEqual([
      { line: '1.2.3', reason: 'no_port' },
      { line: 'http://', reason: 'invalid_host' },
      { line: '256.300.1.1:80', reason: 'invalid_host' },
    ]);
    expect(result.skipped_lines).toBe(2);
  });

  it('respects maxEntries', () => {
    const many = Array.from({ length: 50 }, (_, i) => `203.0.113.${i + 1}:80`).join('\n');
    const result = parseProxyList(many, { maxEntries: 10 });
    expect(result.proxies).toHaveLength(10);
  });

  it('keeps comments and headers out of the reject list', () => {
    const result = parseProxyList('# header\n; note\n// slash\nHTTP\n1.2.3.4:80\n');
    expect(result.proxies).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
    expect(result.proxies[0]?.protocol).toBe('http');
  });
});
