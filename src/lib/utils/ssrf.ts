import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { BlockList, isIP } from 'node:net';

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

const blockList = new BlockList();

for (const cidr of [...IPV4_BLOCKLIST, ...IPV6_BLOCKLIST]) {
  const [ip, prefix] = cidr.split('/');
  blockList.addSubnet(ip, parseInt(prefix, 10));
}

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

const isBlockedIpAddress = (address: string): boolean => {
  const candidates = [address];

  const lower = address.toLowerCase();

  if (lower.startsWith('::ffff:') && lower.includes('.')) {
    const embeddedIPv4 = lower.slice(7);

    if (isIP(embeddedIPv4) === 4) candidates.push(embeddedIPv4);
  }

  return candidates.some((candidate) => {
    try {
      return blockList.check(candidate);
    } catch {
      return true;
    }
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
