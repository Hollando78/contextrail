/**
 * End-to-end connect test: simulates a desklet device against a live host.
 *   1. boot the host
 *   2. operator mints a pairing OTT on the loopback port (GET /pair/new)
 *   3. device completes pairing over TLS (POST /pair)
 *   4. device opens a WSS connection with its session token
 *   5. device receives a role-scoped context frame
 *   6. device reconnects without a token (reconnect-without-repair path)
 *
 * Self-signed TLS is accepted (rejectUnauthorized:false) — the local-first model.
 */
import { spawn } from 'node:child_process';
import { request as httpsRequest } from 'node:https';
import { get as httpGet, request as httpRequest } from 'node:http';
import { WebSocket } from 'ws';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 8917;
const LOOPBACK = 8918;
const dataDir = mkdtempSync(join(tmpdir(), 'cr-e2e-'));

const config = {
  host: '127.0.0.1',
  port: PORT,
  loopbackPort: LOOPBACK,
  dataDir,
  adapterDir: './adapters',
  manifestDir: './adapters/manifests',
  ssh: { configPath: '~/.ssh/config', knownHostsPath: '~/.ssh/known_hosts' },
  tls: { commonName: 'contextrail.local' },
};

const fs = await import('node:fs');
const cfgPath = join(dataDir, 'config.json');
fs.writeFileSync(cfgPath, JSON.stringify(config));

function log(ok, msg) {
  console.log(`${ok ? '  ✓' : '  ✗'} ${msg}`);
  if (!ok) process.exitCode = 1;
}

function httpJson(url) {
  return new Promise((resolve, reject) => {
    httpGet(url, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });
}

function adminPost(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body ?? {});
    const req = httpRequest(
      { host: '127.0.0.1', port: LOOPBACK, path, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } },
      (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(d || '{}') })); },
    );
    req.on('error', reject);
    req.end(data);
  });
}

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = httpsRequest(
      url,
      { method: 'POST', rejectUnauthorized: false, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(d) }));
      },
    );
    req.on('error', reject);
    req.end(data);
  });
}

function waitFrame(ws, kind, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${kind} frame`)), timeoutMs);
    ws.on('message', (raw) => {
      const f = JSON.parse(raw.toString());
      if (f.kind === kind) {
        clearTimeout(t);
        resolve(f);
      }
    });
    ws.on('error', reject);
  });
}

const child = spawn(process.execPath, ['--import', 'tsx', 'src/host/main.ts', cfgPath], {
  cwd: process.cwd(),
  env: { ...process.env, CONTEXTRAIL_LOG_LEVEL: 'warn' },
});

function killTree() {
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
    } catch {
      /* ignore */
    }
  } else {
    child.kill('SIGTERM');
  }
}
child.stderr.on('data', (b) => {
  if (process.env.E2E_VERBOSE) process.stderr.write(b.toString());
});

/** Poll the loopback pairing endpoint until the transport is listening. */
async function waitBoot(ms = 15000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try {
      const mint = await httpJson(`http://127.0.0.1:${LOOPBACK}/pair/new?role=Status`);
      if (mint && mint.ott) return mint;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('host did not boot in time');
}

try {
  const mint = await waitBoot();
  log(true, 'host booted and transport listening');
  log(!!mint.ott && !!mint.qr, `minted pairing OTT + QR (role=${mint.role})`);

  const paired = await postJson(`https://127.0.0.1:${PORT}/pair`, {
    ott: mint.ott,
    fingerprintParts: { ua: 'e2e-device', seed: 'seed-123' },
  });
  log(paired.status === 200 && !!paired.body.sessionToken, `paired over TLS -> session token (role=${paired.body.role})`);
  const { sessionToken, fingerprint, deviceId } = paired.body;

  // Reject a bad token.
  const ws1 = new WebSocket(
    `wss://127.0.0.1:${PORT}/?token=bogus&fp=${fingerprint}&deviceId=${deviceId}`,
    { rejectUnauthorized: false },
  );
  const rejected = await new Promise((resolve) => {
    ws1.on('unexpected-response', (_req, res) => resolve(res.statusCode));
    ws1.on('error', () => resolve('error'));
    ws1.on('open', () => resolve('opened'));
  });
  log(rejected === 401, `invalid token rejected with 401 (got ${rejected})`);

  // Admit with the real session token, expect a context frame.
  const ws = new WebSocket(
    `wss://127.0.0.1:${PORT}/?token=${encodeURIComponent(sessionToken)}&fp=${fingerprint}&deviceId=${deviceId}`,
    { rejectUnauthorized: false },
  );
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
    ws.on('unexpected-response', (_q, res) => reject(new Error('upgrade rejected ' + res.statusCode)));
  });
  log(true, 'WSS admitted with session token');
  const frame = await waitFrame(ws, 'context');
  log(frame.role === 'Status', `received role-scoped context frame (role=${frame.role}, v${frame.payload?.version})`);

  // --- Action loop: dispatch an allowed intent, expect SUCCESS within budget ---
  const ackFor = (correlationId, timeoutMs = 3000) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no ack for ' + correlationId)), timeoutMs);
      const onMsg = (raw) => {
        const f = JSON.parse(raw.toString());
        if (f.kind === 'ack' && f.correlationId === correlationId) {
          clearTimeout(t);
          ws.off('message', onMsg);
          resolve(f);
        }
      };
      ws.on('message', onMsg);
    });

  const c1 = 'c-launch-' + Date.now();
  const t0 = Date.now();
  ws.send(JSON.stringify({ kind: 'intent', correlationId: c1, payload: { type: 'launch-tool', data: { profile: 'launch-ide' } } }));
  const ack1 = await ackFor(c1);
  const rtt = Date.now() - t0;
  log(ack1.payload?.status === 'SUCCESS', `allowed intent executed -> ${ack1.payload?.status} (round-trip ${rtt}ms)`);
  log(rtt < 200, `round-trip within 200ms budget (SYS-REQ-009): ${rtt}ms`);

  // --- Allowlist deny: an SSH action is default-denied (no rag allowlist entry) ---
  const c2 = 'c-ssh-' + Date.now();
  ws.send(JSON.stringify({ kind: 'intent', correlationId: c2, payload: { type: 'ssh-action', data: { command: 'rm -rf /', host: 'prod' } } }));
  const ack2 = await ackFor(c2);
  log(ack2.payload?.status === 'DENIED', `non-allowlisted SSH action denied -> ${ack2.payload?.status} (${ack2.payload?.detail?.reason})`);

  ws.close();
  await new Promise((r) => setTimeout(r, 100));

  // --- Host Admin Station: Maintenance gating + allowlist edit (loopback) ------
  const denyEdit = await adminPost('/admin/allowlist', { op: 'add', adapter: 'rag', actionPattern: 'service status', effect: 'allow' });
  log(denyEdit.status === 409 && denyEdit.body.code === 'MODE_RESTRICTION', `allowlist edit blocked outside Maintenance -> ${denyEdit.body.code} (SUB-HAS-067)`);

  const enterM = await adminPost('/admin/maintenance', { on: true });
  log(enterM.body.mode === 'Maintenance', `entered Maintenance via admin API -> ${enterM.body.mode}`);

  const addEntry = await adminPost('/admin/allowlist', { op: 'add', adapter: 'rag', actionPattern: 'service status', effect: 'allow', ruleId: 'svc' });
  const listed = await adminPost('/admin/allowlist', { op: 'list' });
  const hasEntry = (listed.body.entries ?? []).some((e) => e.adapter === 'rag' && e.actionPattern === 'service status');
  log(addEntry.status === 200 && hasEntry, 'allowlist entry added + listed in Maintenance');

  const leaveM = await adminPost('/admin/maintenance', { on: false });
  log(leaveM.body.mode === 'Nominal', `left Maintenance -> ${leaveM.body.mode}`);

  // --- Lock / unlock safe-state ------------------------------------------------
  await adminPost('/admin/lock', { reason: 'e2e' });
  const lockedStatus = await new Promise((resolve) => {
    httpGet(`http://127.0.0.1:${LOOPBACK}/admin/status`, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => resolve(JSON.parse(d))); });
  });
  log(lockedStatus.locked === true && lockedStatus.mode === 'Locked', `host locked -> mode=${lockedStatus.mode} (SYS-REQ-003)`);

  const badUnlock = await adminPost('/admin/unlock', { passphrase: 'wrong' });
  log(badUnlock.status === 401, 'unlock rejected with wrong passphrase');
  const goodUnlock = await adminPost('/admin/unlock', { passphrase: 'contextrail' });
  log(goodUnlock.status === 200 && goodUnlock.body.locked === false, 'unlock succeeds with operator passphrase');

  // Reconnect without a token (single-use token already consumed) via DIL.
  await new Promise((r) => setTimeout(r, 200));
  const ws2 = new WebSocket(
    `wss://127.0.0.1:${PORT}/?fp=${fingerprint}&deviceId=${deviceId}`,
    { rejectUnauthorized: false },
  );
  const reconnected = await new Promise((resolve) => {
    ws2.on('open', () => resolve(true));
    ws2.on('error', () => resolve(false));
    ws2.on('unexpected-response', () => resolve(false));
  });
  log(reconnected, 'reconnected without re-pairing (device ledger path, SYS-REQ-008)');
  ws2.close();

  console.log(process.exitCode ? '\nE2E FAILED' : '\nE2E PASSED');
} catch (err) {
  log(false, `e2e error: ${err.message}`);
} finally {
  killTree();
  setTimeout(() => process.exit(process.exitCode ?? 0), 500);
}
