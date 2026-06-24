/**
 * Self-signed TLS material for the transport.
 *
 * The WebSocket Gateway serves all desklet connections over TLS using a
 * host-generated self-signed certificate rotated on each host process restart.
 * (SUB-XPT-039, IFC-XPT-019 — TLS 1.3, IFC-DWB-054 — WSS) SANs cover loopback and
 * the host's LAN addresses so desklets can connect by IP. Browsers will warn on
 * the untrusted self-signed cert; the operator accepts it once per device — this
 * is inherent to a local-first, no-PKI deployment.
 */
import { networkInterfaces } from 'node:os';
import selfsigned from 'selfsigned';

export interface TlsMaterial {
  key: string;
  cert: string;
  /** LAN addresses a desklet can use to reach the host. */
  lanAddresses: string[];
}

/**
 * Rank an IPv4 address by how likely it is to be the reachable home/office Wi-Fi
 * LAN address a desklet should use: 192.168/16 first, then 10/8, then 172.16/12,
 * deprioritising 100.64/10 (CGNAT/Tailscale) and virtual-adapter ranges.
 */
function lanRank(ip: string): number {
  if (ip.startsWith('192.168.')) return 0;
  if (ip.startsWith('10.')) return 1;
  const m = /^172\.(\d+)\./.exec(ip);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return 2;
  const c = /^100\.(\d+)\./.exec(ip);
  if (c && Number(c[1]) >= 64 && Number(c[1]) <= 127) return 4; // CGNAT / Tailscale
  return 3;
}

export function lanIPv4Addresses(): string[] {
  const out: string[] = [];
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const i of ifaces ?? []) {
      if (i.family === 'IPv4' && !i.internal) out.push(i.address);
    }
  }
  return out.sort((a, b) => lanRank(a) - lanRank(b));
}

export function generateSelfSigned(commonName: string): TlsMaterial {
  const lan = lanIPv4Addresses();
  const altNames = [
    { type: 2, value: 'localhost' },
    { type: 2, value: commonName },
    { type: 7, ip: '127.0.0.1' },
    ...lan.map((ip) => ({ type: 7, ip })),
  ];
  const pems = selfsigned.generate([{ name: 'commonName', value: commonName }], {
    keySize: 2048,
    days: 365,
    algorithm: 'sha256',
    extensions: [{ name: 'subjectAltName', altNames }],
  });
  return { key: pems.private, cert: pems.cert, lanAddresses: lan };
}
