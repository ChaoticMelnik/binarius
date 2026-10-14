import { isIP } from 'node:net';

const IPV4_MAPPED = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

// Expands an IPv6 address to its eight 16-bit groups. Only called on what isIP() accepted.
const ipv6Groups = (address: string): number[] => {
  let text = address.toLowerCase();
  const zone = text.indexOf('%');
  if (zone !== -1) text = text.slice(0, zone);
  // an embedded IPv4 tail is two groups
  const tail = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (tail !== null) {
    const [a, b, c, d] = tail.slice(1).map(Number) as [number, number, number, number];
    text = `${text.slice(0, tail.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = '', rest] = text.split('::');
  const left = head === '' ? [] : head.split(':');
  const right = rest === undefined || rest === '' ? [] : rest.split(':');
  const missing = rest === undefined ? 0 : 8 - left.length - right.length;
  return [...left, ...Array<string>(missing).fill('0'), ...right].map((group) =>
    Number.parseInt(group, 16),
  );
};

/**
 * The key of the per-IP window in front of the cashier's forward (#111). One person usually holds
 * a whole IPv6 /64, so keying by the full address would give them 2^64 allowances; an IPv4-mapped
 * address is the IPv4 client it carries. Anything that is not an IP — never expected from Fastify
 * — is its own key rather than a shared one.
 */
export function ipKey(address: string): string {
  const mapped = IPV4_MAPPED.exec(address);
  if (mapped?.[1] !== undefined && isIP(mapped[1]) === 4) return mapped[1];
  if (isIP(address) === 6) {
    const prefix = ipv6Groups(address)
      .slice(0, 4)
      .map((group) => group.toString(16))
      .join(':');
    return `${prefix}::/64`;
  }
  return address;
}
