/**
 * HTTP Static Asset Server (XPT).
 *
 * Serves the desklet web bundle (HTML/JS/CSS) over HTTPS on the same port as the
 * WebSocket Gateway, with content-hash cache-control headers, and answers the
 * pairing routes the desklet uses. Non-upgrade GETs are served as static files;
 * upgrade requests are handed to the WebSocket Gateway by the LTS. (SUB-XPT-043,
 * IFC-XPT-038)
 *
 * Pairing routes (served over TLS on the LAN-facing port so a phone can reach
 * them — the IFC-PAIR-027 "loopback" note refers to the host-internal call path;
 * the device-facing POST must traverse the LAN):
 *   POST /pair        { ott, role?, fingerprintParts } -> { sessionToken, role, deviceId, expiresAt }
 *   GET  /pair/new?role=Status (loopback only) -> { ott, url, qr }
 *   GET  /health      (loopback only) -> subsystem health
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import type { Logger } from '../core/logger.js';
import { isRole, type Role } from '../core/constants.js';
import { sha256Hex } from '../core/crypto.js';
import { isContextRailError } from '../core/errors.js';
import type { DeskletPairingAndIdentity } from '../pair/desklet-pairing-and-identity.js';

const PUBLIC_DIR = fileURLToPath(new URL('../host/public/', import.meta.url));

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
};

export class HttpStaticAssetServer {
  /** Cache of file bytes + content hash, keyed by path and validated against mtime. */
  private readonly cache = new Map<string, { body: Buffer; etag: string; mtimeMs: number }>();

  constructor(
    private readonly pairing: DeskletPairingAndIdentity,
    private readonly log: Logger,
    /** Candidate host addresses a desklet can reach (LAN + Tailscale + …). */
    private readonly addresses: () => string[],
    private readonly port: number,
  ) {}

  async handle(req: IncomingMessage, res: ServerResponse, opts: { loopback?: boolean } = {}): Promise<void> {
    const loopback = !!opts.loopback;
    const url = new URL(req.url ?? '/', 'https://host');
    try {
      // --- Operator-only routes (loopback / host machine only) ---
      if (url.pathname === '/pair/new') {
        if (!loopback) return this.send(res, 403, { error: 'pairing is host-only' });
        if (req.method === 'GET') return await this.handleNewPairing(url, res);
      }
      if (url.pathname === '/health' && req.method === 'GET') {
        return this.send(res, 200, { status: 'nominal', ts: new Date().toISOString() });
      }
      if (loopback && req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        return await this.serveFile('admin.html', res); // operator console
      }
      // Loopback dev desklet (localhost-only, no TLS) for development/debugging.
      if (loopback && req.method === 'GET' && (url.pathname === '/desklet' || url.pathname === '/desklet.html')) {
        return await this.serveFile('desklet.html', res);
      }

      // --- Device-facing routes (LAN) ---
      if (req.method === 'POST' && url.pathname === '/pair') return await this.handlePair(req, res);
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        return await this.serveFile('desklet.html', res);
      }
      if (req.method === 'GET') return await this.serveFile(url.pathname.replace(/^\/+/, ''), res);
      this.send(res, 405, { error: 'method not allowed' });
    } catch (err) {
      this.log.error('request handler error', { err: (err as Error).message, path: url.pathname });
      this.send(res, 500, { error: 'internal error' });
    }
  }

  // --- Pairing -----------------------------------------------------------------

  /** Issue a fresh OTT and a pairing URL/QR. Intended for the host operator. */
  async handleNewPairing(url: URL, res: ServerResponse): Promise<void> {
    const role = url.searchParams.get('role') ?? 'Status';
    if (!isRole(role)) return this.send(res, 400, { error: 'invalid role' });

    const candidates = this.addresses();
    const requested = url.searchParams.get('addr');
    // Only honour an address the host actually owns (no open-redirect via QR).
    const addr = requested && candidates.includes(requested) ? requested : (candidates[0] ?? '127.0.0.1');

    const { ott, expiresAt } = this.pairing.newPairing(role);
    // Omit the port for 443 so the URL reads as a plain https://host.
    const hostPart = this.port === 443 ? addr : `${addr}:${this.port}`;
    const pairUrl = `https://${hostPart}/?ott=${encodeURIComponent(ott)}&role=${role}`;
    const qr = await QRCode.toDataURL(pairUrl, { margin: 1, width: 320 });
    this.send(res, 200, { ott, url: pairUrl, qr, role, expiresAt, addr, addresses: candidates });
  }

  /** Complete a pairing from a desklet device. */
  async handlePair(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    let parsed: { ott?: string; fingerprintParts?: Record<string, string> };
    try {
      parsed = JSON.parse(body);
    } catch {
      return this.send(res, 400, { error: 'invalid JSON' });
    }
    if (!parsed.ott) return this.send(res, 400, { error: 'missing ott' });

    const fpParts = parsed.fingerprintParts ?? {};
    const fingerprint = this.pairing.fingerprint({
      ua: fpParts['ua'] ?? '',
      seed: fpParts['seed'] ?? sha256Hex(JSON.stringify(fpParts)),
    });

    try {
      const result = await this.pairing.completePairing(parsed.ott, fingerprint);
      this.send(res, 200, {
        sessionToken: result.sessionToken,
        role: result.role,
        deviceId: result.deviceId,
        expiresAt: result.expiresAt,
        fingerprint,
      });
    } catch (err) {
      if (isContextRailError(err)) return this.send(res, 401, err.toJSON());
      throw err;
    }
  }

  // --- Static ------------------------------------------------------------------

  private async serveFile(rel: string, res: ServerResponse): Promise<void> {
    const safe = normalize(rel).replace(/^(\.\.[/\\])+/, '');
    const full = join(PUBLIC_DIR, safe);
    if (!full.startsWith(PUBLIC_DIR)) return this.send(res, 403, { error: 'forbidden' });

    let mtimeMs: number;
    try {
      mtimeMs = (await stat(full)).mtimeMs;
    } catch {
      return this.send(res, 404, { error: 'not found' });
    }
    // Serve from cache only while the on-disk file is unchanged; a rebuilt bundle
    // (new mtime) is re-read so a host restart isn't needed to pick it up.
    let entry = this.cache.get(full);
    if (!entry || entry.mtimeMs !== mtimeMs) {
      try {
        const body = await readFile(full);
        entry = { body, etag: `"${sha256Hex(body).slice(0, 16)}"`, mtimeMs };
        this.cache.set(full, entry);
      } catch {
        return this.send(res, 404, { error: 'not found' });
      }
    }
    const type = MIME[extname(full)] ?? 'application/octet-stream';
    // Content-hash ETag with revalidation (no-cache): the browser caches but
    // always revalidates, so a rebuilt desklet bundle is picked up on reload while
    // unchanged assets still hit the cache. (SUB-XPT-043 — content-hash cache headers)
    res.writeHead(200, {
      'content-type': type,
      etag: entry.etag,
      'cache-control': 'no-cache',
    });
    res.end(entry.body);
  }

  private send(res: ServerResponse, status: number, body: unknown): void {
    const json = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(json);
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1_000_000) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
