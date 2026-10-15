import { describe, expect, it } from 'vitest';
import { ipKey } from './ip-key';

describe('ipKey', () => {
  it('keys an IPv4 address by itself', () => {
    expect(ipKey('203.0.113.7')).toBe('203.0.113.7');
    expect(ipKey('203.0.113.8')).not.toBe(ipKey('203.0.113.7'));
  });

  it('keys an IPv4-mapped IPv6 address as the IPv4 it carries', () => {
    expect(ipKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(ipKey('::FFFF:203.0.113.7')).toBe('203.0.113.7');
  });

  it('keys an IPv6 address by its /64, whatever its spelling', () => {
    expect(ipKey('2001:db8:1:2:aaaa::1')).toBe('2001:db8:1:2::/64');
    expect(ipKey('2001:0DB8:0001:0002:ffff:ffff:ffff:ffff')).toBe('2001:db8:1:2::/64');
    expect(ipKey('2001:db8:1:2::')).toBe('2001:db8:1:2::/64');
    expect(ipKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(ipKey('::1')).toBe('0:0:0:0::/64');
    expect(ipKey('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
    expect(ipKey('64:ff9b::192.0.2.33')).toBe('64:ff9b:0:0::/64');
  });

  it('separates two /64s', () => {
    expect(ipKey('2001:db8:1:2::1')).not.toBe(ipKey('2001:db8:1:3::1'));
  });

  it('keys a value that is not an IP by itself', () => {
    expect(ipKey('not-an-ip')).toBe('not-an-ip');
    expect(ipKey('')).toBe('');
  });
});
