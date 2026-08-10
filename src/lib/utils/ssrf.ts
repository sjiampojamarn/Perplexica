import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { isIP } from 'node:net';

const IPV4_BLOCKLIST = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.88.99.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '240.0.0.0/4',
  '255.255.255.255/32',
];

const IPV6_BLOCKLIST = [
  '::/128',
  '::1/128',
  '::ffff:0:0/96',
  '64:ff9b::/96',
  'fc00::/7',
  'fe80::/10',
  '2001:db8::/32',
];

const IPV6_MAX = (BigInt(1) << BigInt(128)) - BigInt(1);

type IPv4Rule = { network: number; prefix: number };

type IPv6Rule = { network: bigint; prefix: number };

const ipv4ToInt = (ip: string): number | null => {
  const parts = ip.split('.');

  if (parts.length !== 4) return null;

  let result = 0;

  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;

    const octet = parseInt(part, 10);

    if (octet > 255) return null;

    result = (result << 8) | octet;
  }

  return result >>> 0;
};

const ipv4InCidr = (address: number, network: number, prefix: number): boolean => {
  if (prefix === 0) return true;

  const mask = prefix >= 32 ? 0xffffffff : (~0 << (32 - prefix)) >>> 0;

  return (address & mask) === (network & mask);
};

const ipv6ToBigInt = (ip: string): bigint | null => {
  let embeddedV4 = '';
  let address = ip;

  if (address.includes('.')) {
    const parts = address.split(':');
    embeddedV4 = parts[parts.length - 1];
    address = parts.slice(0, -1).join(':');
  }

  const v4Hextets = embeddedV4
    ? embeddedV4.split('.').map((octet) => {
        const n = parseInt(octet, 10);
        return /^\d{1,3}$/.test(octet) && n <= 255 ? n : NaN;
      })
    : [];

  if (embeddedV4 && (v4Hextets.length !== 4 || v4Hextets.some(Number.isNaN))) {
    return null;
  }

  const groups = address.split('::');

  if (groups.length > 2) return null;

  const left = groups[0] ? groups[0].split(':') : [];
  const right = groups.length === 2 && groups[1] ? groups[1].split(':') : [];

  const hextets: number[] = [];

  for (const group of left) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    hextets.push(parseInt(group, 16));
  }

  if (embeddedV4) {
    hextets.push((v4Hextets[0] << 8) | v4Hextets[1]);
    hextets.push((v4Hextets[2] << 8) | v4Hextets[3]);
  }

  for (const group of right) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    hextets.push(parseInt(group, 16));
  }

  if (groups.length === 2) {
    while (hextets.length < 8) {
      hextets.splice(left.length, 0, 0);
    }
  }

  if (hextets.length !== 8) return null;

  let result = BigInt(0);

  for (const hextet of hextets) {
    result = (result << BigInt(16)) | BigInt(hextet);
  }

  return result;
};

const ipv6InCidr = (address: bigint, network: bigint, prefix: number): boolean => {
  if (prefix === 0) return true;

  const mask = prefix >= 128 ? IPV6_MAX : IPV6_MAX << BigInt(128 - prefix);

  return (address & mask) === (network & mask);
};

const ipv4Rules: IPv4Rule[] = [];

for (const cidr of IPV4_BLOCKLIST) {
  const [ip, prefixStr] = cidr.split('/');
  const prefix = parseInt(prefixStr, 10);
  const network = ipv4ToInt(ip);

  if (network === null) continue;

  ipv4Rules.push({ network, prefix });
}

const ipv6Rules: IPv6Rule[] = [];

for (const cidr of IPV6_BLOCKLIST) {
  const [ip, prefixStr] = cidr.split('/');
  const prefix = parseInt(prefixStr, 10);
  const network = ipv6ToBigInt(ip);

  if (network === null) continue;

  ipv6Rules.push({ network, prefix });
}

const isBlockedIpAddress = (address: string): boolean => {
  const family = isIP(address);

  if (family === 4) {
    const int = ipv4ToInt(address);

    return (
      int === null || ipv4Rules.some((r) => ipv4InCidr(int, r.network, r.prefix))
    );
  }

  if (family === 6) {
    const big = ipv6ToBigInt(address);

    return (
      big === null || ipv6Rules.some((r) => ipv6InCidr(big, r.network, r.prefix))
    );
  }

  return true;
};

const BLOCKED_HOSTNAMES = new Set(['localhost']);

const BLOCKED_HOSTNAME_SUFFIXES = ['.localhost', '.local', '.internal'];

const isBlockedHostname = (hostname: string): boolean => {
  const normalized = hostname.toLowerCase();

  if (BLOCKED_HOSTNAMES.has(normalized)) return true;

  return BLOCKED_HOSTNAME_SUFFIXES.some((suffix) =>
    normalized.endsWith(suffix),
  );
};

const lookupWithTimeout = (
  hostname: string,
  timeoutMs: number,
): Promise<LookupAddress[]> => {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`DNS lookup timed out for ${hostname}`));
    }, timeoutMs);

    lookup(hostname, { all: true, verbatim: true })
      .then((res) => {
        clearTimeout(timer);
        resolve(res);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
};

export const assertSafeUrl = async (url: string): Promise<void> => {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Only http and https URLs are allowed: ${url}`);
  }

  const { hostname } = parsed;

  if (isBlockedHostname(hostname)) {
    throw new Error(`Blocked hostname: ${hostname}`);
  }

  if (isIP(hostname) !== 0) {
    if (isBlockedIpAddress(hostname)) {
      throw new Error(`Blocked IP address: ${hostname}`);
    }

    return;
  }

  let addresses: LookupAddress[];

  try {
    const result = await lookupWithTimeout(hostname, 5000);

    addresses = result;
  } catch (err) {
    throw new Error(
      `Failed to resolve hostname ${hostname}: ${
        err instanceof Error ? err.message : err
      }`,
    );
  }

  for (const { address } of addresses) {
    if (isBlockedIpAddress(address)) {
      throw new Error(`Hostname ${hostname} resolves to blocked IP: ${address}`);
    }
  }
};