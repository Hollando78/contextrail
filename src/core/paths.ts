/**
 * Filesystem path helpers for runtime state (ledger, allowlist, audit, certs).
 * All runtime state lives under the configured data directory — no cloud
 * dependency. (ARC-REQ-001, SYS-REQ-016)
 */
import { homedir } from 'node:os';
import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';

/** Expand a leading `~` to the user's home directory. */
export function expandTilde(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2));
  return p;
}

export function resolveDataDir(dataDir: string): string {
  return resolve(expandTilde(dataDir));
}

export async function ensureDir(path: string): Promise<string> {
  await mkdir(path, { recursive: true });
  return path;
}

/** Standard runtime file locations under the data directory. */
export function dataPaths(dataDir: string) {
  const root = resolveDataDir(dataDir);
  return {
    root,
    ledger: join(root, 'device-ledger.jsonl'),
    allowlist: join(root, 'allowlist.json'),
    allowlistAudit: join(root, 'allowlist-audit.jsonl'),
    sshAudit: join(root, 'ssh-audit.jsonl'),
    adapterRegistry: join(root, 'adapter-registry.jsonl'),
    contextSnapshot: join(root, 'context-snapshot.json'),
    captures: join(root, 'captures.jsonl'),
    credentials: join(root, 'credentials.enc.json'),
    vaultKey: join(root, 'vault.key'),
    deepSocket:
      process.platform === 'win32'
        ? join('\\\\.\\pipe\\contextrail-deep')
        : join(root, 'deep.sock'),
  };
}
