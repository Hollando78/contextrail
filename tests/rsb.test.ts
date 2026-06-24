/**
 * Remote SSH Boundary verification tests (dry-run).
 * Maps to SUB-RSB-063 (rate limit), SUB-RAG-046 (allowlist gate / exit 126),
 * ARC-REQ-018 (rate -> allowlist -> resolve -> spawn -> audit), SUB-RAG-048 dry-run.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '../src/core/logger.js';
import { AllowlistStore } from '../src/acg/allowlist-store.js';
import { AllowlistAuditLogger } from '../src/acg/allowlist-audit-logger.js';
import { PolicyEngine } from '../src/acg/policy-engine.js';
import { SshRateLimiter } from '../src/rsb/ssh-rate-limiter.js';
import { SshConfigResolver } from '../src/rsb/ssh-config-resolver.js';
import { SshAuditLogger } from '../src/rsb/ssh-audit-logger.js';
import { RemoteSshBoundary } from '../src/rsb/remote-ssh-boundary.js';
import { LIMITS } from '../src/core/constants.js';

const log = createLogger('test');

describe('SshRateLimiter (SUB-RSB-063)', () => {
  it('allows up to 10 per window then blocks', () => {
    const rl = new SshRateLimiter();
    for (let i = 0; i < LIMITS.SSH_RATE_LIMIT; i++) expect(rl.tryAcquire('rag')).toBe(true);
    expect(rl.tryAcquire('rag')).toBe(false);
  });
});

describe('RemoteSshBoundary dry-run sequence (ARC-REQ-018)', () => {
  let boundary: RemoteSshBoundary;
  let dir: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cr-rsb-'));
    const cfg = join(dir, 'ssh_config');
    writeFileSync(cfg, 'Host prod\n  HostName 127.0.0.1\n  User deploy\n  Port 2222\n');

    const store = new AllowlistStore(join(dir, 'allow.json'), log);
    await store.load();
    await store.add({ adapter: 'rag', actionPattern: 'service status', effect: 'allow', ruleId: 'svc' });

    const policy = new PolicyEngine(store, new AllowlistAuditLogger(join(dir, 'aud.jsonl'), log), log);
    boundary = new RemoteSshBoundary(
      new SshRateLimiter(),
      new SshConfigResolver(cfg, log),
      new SshAuditLogger(join(dir, 'ssh-audit.jsonl'), log),
      policy,
      log,
    );
  });

  it('permits an allowlisted command (dry-run, no real connection)', async () => {
    const r = await boundary.execute({
      commandText: 'service status',
      targetHostAlias: 'prod',
      adapterIdentity: 'rag',
      commandClass: 'bounded',
      sshSessionId: 's1',
    });
    expect(r.status).toBe('permit');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('[dry-run]');
  });

  it('denies a non-allowlisted command with exit 126 (IFC-RAG-025)', async () => {
    const r = await boundary.execute({
      commandText: 'rm -rf /',
      targetHostAlias: 'prod',
      adapterIdentity: 'rag',
      commandClass: 'bounded',
      sshSessionId: 's2',
    });
    expect(r.status).toBe('deny');
    expect(r.exitCode).toBe(126);
  });

  it('errors when the host is not in ssh config', async () => {
    const r = await boundary.execute({
      commandText: 'service status',
      targetHostAlias: 'unknown-host',
      adapterIdentity: 'rag',
      commandClass: 'bounded',
      sshSessionId: 's3',
    });
    expect(r.status).toBe('error');
  });
});
