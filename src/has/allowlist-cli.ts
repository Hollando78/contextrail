#!/usr/bin/env node
/**
 * contextrail-allowlist — operator CLI for the Host Administration Station.
 *
 * Talks to the host's loopback admin API. Allowlist edits require Maintenance
 * mode (the host enforces this). Examples:
 *   contextrail-allowlist status
 *   contextrail-allowlist maintenance on
 *   contextrail-allowlist add rag "service status" allow
 *   contextrail-allowlist list
 *   contextrail-allowlist maintenance off
 *   contextrail-allowlist lock
 *   contextrail-allowlist unlock <passphrase>
 *   contextrail-allowlist audit ssh
 */
import { request } from 'node:http';

const PORT = Number(process.env['CONTEXTRAIL_LOOPBACK'] ?? 8788);

function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const req = request(
      { host: '127.0.0.1', port: PORT, path, method, headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: d ? JSON.parse(d) : {} }));
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  try {
    switch (cmd) {
      case 'status': {
        const r = await call('GET', '/admin/status');
        console.log(JSON.stringify(r.body, null, 2));
        break;
      }
      case 'maintenance': {
        const on = args[0] === 'on';
        const r = await call('POST', '/admin/maintenance', { on });
        console.log(`mode: ${r.body.mode}`);
        break;
      }
      case 'list': {
        const r = await call('POST', '/admin/allowlist', { op: 'list' });
        if (r.status !== 200) return fail(r);
        console.table(r.body.entries);
        break;
      }
      case 'add': {
        const [adapter, actionPattern, effect] = args;
        const r = await call('POST', '/admin/allowlist', { op: 'add', adapter, actionPattern, effect: effect ?? 'allow' });
        r.status === 200 ? console.log('added') : fail(r);
        break;
      }
      case 'remove': {
        const [adapter, actionPattern] = args;
        const r = await call('POST', '/admin/allowlist', { op: 'remove', adapter, actionPattern });
        r.status === 200 ? console.log(r.body.removed ? 'removed' : 'not found') : fail(r);
        break;
      }
      case 'lock': {
        await call('POST', '/admin/lock', { reason: 'cli' });
        console.log('locked');
        break;
      }
      case 'unlock': {
        const r = await call('POST', '/admin/unlock', { passphrase: args[0] });
        console.log(r.status === 200 ? 'unlocked' : 'authentication failed');
        break;
      }
      case 'audit': {
        const r = await call('GET', `/admin/audit?type=${args[0] ?? 'allowlist'}&limit=${args[1] ?? 20}`);
        for (const rec of r.body.records ?? []) console.log(JSON.stringify(rec));
        break;
      }
      default:
        console.log('usage: contextrail-allowlist <status|maintenance on|off|list|add|remove|lock|unlock|audit>');
    }
  } catch (err) {
    console.error(`could not reach host on loopback:${PORT} — is it running? (${(err as Error).message})`);
    process.exitCode = 1;
  }
}

function fail(r: { status: number; body: any }): void {
  console.error(`error ${r.status}: ${r.body.message ?? r.body.error ?? JSON.stringify(r.body)}`);
  process.exitCode = 1;
}

void main();
