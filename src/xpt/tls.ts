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
import { X509Certificate } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
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

/**
 * Load a persisted self-signed cert if it exists and still covers every current
 * LAN address; otherwise generate a fresh one and (when persisting) save it. A
 * stable cert lets paired phones re-establish WSS after a host restart without
 * re-accepting a new certificate. (Trades off SUB-XPT-039's per-restart rotation
 * for cross-restart reconnect; gated by config `tls.persist`.)
 */
export function loadOrCreateTls(
  commonName: string,
  dataDir: string,
  persist: boolean,
  extraDns: string[] = [],
): TlsMaterial {
  const lan = lanIPv4Addresses();
  const certPath = join(dataDir, 'tls-cert.pem');
  const keyPath = join(dataDir, 'tls-key.pem');

  if (persist && existsSync(certPath) && existsSync(keyPath)) {
    try {
      const cert = readFileSync(certPath, 'utf8');
      const key = readFileSync(keyPath, 'utf8');
      const san = new X509Certificate(cert).subjectAltName ?? '';
      const covered = ['127.0.0.1', ...lan, ...extraDns].every((name) => san.includes(name));
      if (covered) return { key, cert, lanAddresses: lan };
    } catch {
      /* fall through to regenerate */
    }
  }

  const fresh = generateSelfSigned(commonName, extraDns);
  if (persist) {
    try {
      writeFileSync(certPath, fresh.cert);
      writeFileSync(keyPath, fresh.key);
    } catch {
      /* non-fatal: run with an in-memory cert this session */
    }
  }
  return fresh;
}

export function generateSelfSigned(commonName: string, extraDns: string[] = []): TlsMaterial {
  const lan = lanIPv4Addresses();
  const altNames = [
    { type: 2, value: 'localhost' },
    { type: 2, value: commonName },
    ...extraDns.map((d) => ({ type: 2, value: d })),
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

export interface TlsOptions {
  commonName: string;
  dataDir: string;
  persist: boolean;
  /** Optional CA-signed cert/key (bring-your-own); used when both exist. */
  certPath?: string | undefined;
  keyPath?: string | undefined;
  /** Public hostname to prefer in pairing URLs and include in the self-signed SAN. */
  publicHost?: string | undefined;
}

/**
 * Resolve the TLS material for the transport. Prefers an operator-supplied
 * CA-signed cert (browser-trusted, no warning) when `certPath`/`keyPath` are
 * configured and readable; otherwise generates/persists a self-signed cert.
 * The returned `lanAddresses` lists the addresses a desklet can use, with the
 * public hostname first when configured (so pairing URLs prefer the trusted name).
 */
export function resolveTls(opts: TlsOptions): { material: TlsMaterial; trusted: boolean } {
  const extra = opts.publicHost ? [opts.publicHost] : [];

  if (opts.certPath && opts.keyPath && existsSync(opts.certPath) && existsSync(opts.keyPath)) {
    const cert = readFileSync(opts.certPath, 'utf8');
    const key = readFileSync(opts.keyPath, 'utf8');
    return { material: { key, cert, lanAddresses: [...extra, ...lanIPv4Addresses()] }, trusted: true };
  }

  const m = loadOrCreateTls(opts.commonName, opts.dataDir, opts.persist, extra);
  return { material: { ...m, lanAddresses: [...extra, ...m.lanAddresses] }, trusted: false };
}
