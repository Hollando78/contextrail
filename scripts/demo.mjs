/**
 * Live demo: boots a real host, prints the LAN URL + a scannable QR, then
 * connects a simulated desklet and shows the context frame it receives.
 * Self-contained and self-cleaning.
 */
import { spawn } from 'node:child_process';
import { request as httpsRequest } from 'node:https';
import { get as httpGet } from 'node:http';
import { WebSocket } from 'ws';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import QRCode from 'qrcode';

const PORT = 8787;
const LOOPBACK = 8788;
const dataDir = mkdtempSync(join(tmpdir(), 'cr-demo-'));
const cfgPath = join(dataDir, 'config.json');
writeFileSync(
  cfgPath,
  JSON.stringify({
    host: '0.0.0.0',
    port: PORT,
    loopbackPort: LOOPBACK,
    dataDir,
    adapterDir: './adapters',
    manifestDir: './adapters/manifests',
    ssh: { configPath: '~/.ssh/config', knownHostsPath: '~/.ssh/known_hosts' },
    tls: { commonName: 'contextrail.local' },
  }),
);

const httpJson = (url) =>
  new Promise((res, rej) => httpGet(url, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(JSON.parse(d))); }).on('error', rej));

const postJson = (url, body) =>
  new Promise((res, rej) => {
    const data = JSON.stringify(body);
    const req = httpsRequest(url, { method: 'POST', rejectUnauthorized: false, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } },
      (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(JSON.parse(d))); });
    req.on('error', rej); req.end(data);
  });

const child = spawn(process.execPath, ['--import', 'tsx', 'src/host/main.ts', cfgPath], {
  env: { ...process.env, CONTEXTRAIL_LOG_LEVEL: 'info' },
});
child.stderr.on('data', (b) => {
  for (const line of b.toString().split('\n').filter(Boolean)) {
    try {
      const o = JSON.parse(line);
      if (['mode transition', 'local transport server listening', 'host operational', 'desklet paired', 'desklet admitted'].includes(o.msg)) {
        console.log(`   [host] ${o.msg}${o.url ? ' ' + o.url : ''}${o.lan ? ' lan=' + JSON.stringify(o.lan) : ''}${o.role ? ' role=' + o.role : ''}`);
      }
    } catch { /* ignore non-JSON */ }
  }
});

function killTree() {
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
  else child.kill('SIGTERM');
}

async function waitBoot(ms = 15000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try { const m = await httpJson(`http://127.0.0.1:${LOOPBACK}/pair/new?role=Status`); if (m?.ott) return m; } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('host did not boot');
}

try {
  console.log('\n── Booting ContextRail host ───────────────────────────────\n');
  const mint = await waitBoot();

  console.log('\n── Pair a device (scan on a phone on the same Wi-Fi) ───────\n');
  console.log(await QRCode.toString(mint.url, { type: 'terminal', small: true }));
  console.log(`   URL: ${mint.url}\n`);

  console.log('── Simulating a desklet pairing + connecting ──────────────\n');
  const paired = await postJson(`https://127.0.0.1:${PORT}/pair`, { ott: mint.ott, fingerprintParts: { ua: 'demo-phone', seed: 'demo-seed' } });
  console.log(`   paired: role=${paired.role}, device=${paired.deviceId}`);

  const ws = new WebSocket(`wss://127.0.0.1:${PORT}/?token=${encodeURIComponent(paired.sessionToken)}&fp=${paired.fingerprint}&deviceId=${paired.deviceId}`, { rejectUnauthorized: false });
  const frame = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no frame')), 4000);
    ws.on('message', (raw) => { const f = JSON.parse(raw.toString()); if (f.kind === 'context') { clearTimeout(t); resolve(f); } });
    ws.on('error', reject);
  });
  console.log(`\n   ← context frame received:`);
  console.log(`     role=${frame.role}  version=${frame.payload.version}  digest=${frame.payload.digest?.slice(0, 12)}  stale=${frame.payload.stale}`);
  console.log(`     fields=${JSON.stringify(frame.payload.deltaFields)}`);
  ws.close();

  console.log('\n── Live. The host is serving; a real phone can scan above. ─\n');
  await new Promise((r) => setTimeout(r, 500));
} catch (err) {
  console.error('demo error:', err.message);
  process.exitCode = 1;
} finally {
  killTree();
  setTimeout(() => process.exit(process.exitCode ?? 0), 500);
}
