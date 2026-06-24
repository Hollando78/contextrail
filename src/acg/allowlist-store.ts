/**
 * Allowlist Store (ACG).
 *
 * Persistent host-side store of allowlist entries, written atomically so a crash
 * or power cycle never leaves a partial file; stored state matches the last
 * committed write within 100 ms of acknowledgement. (SUB-ACG-010, ARC-REQ-008)
 */
import { readFile, writeFile, rename } from 'node:fs/promises';
import type { Logger } from '../core/logger.js';
import type { AllowlistEntry } from '../core/types.js';

/** Default-deny seed: only these explicit allows let the action loop work out of the box. */
const DEFAULT_ENTRIES: AllowlistEntry[] = [
  // Config-driven local actions (operator owns config/actions.json) run as 'action:<id>'.
  { adapter: 'local', actionPattern: 'action:*', effect: 'allow', ruleId: 'seed-local-actions' },
  { adapter: 'local', actionPattern: 'launch-tool:*', effect: 'allow', ruleId: 'seed-local-launch' },
  { adapter: 'local', actionPattern: 'open-url:*', effect: 'allow', ruleId: 'seed-local-url' },
  { adapter: 'local', actionPattern: 'restore-layout', effect: 'allow', ruleId: 'seed-local-layout' },
  // SSH actions stay default-deny — add explicit allowlist entries in Maintenance.
];

export class AllowlistStore {
  private entries: AllowlistEntry[] = [];

  constructor(
    private readonly path: string,
    private readonly log: Logger,
  ) {}

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.path, 'utf8');
      this.entries = JSON.parse(raw) as AllowlistEntry[];
      // Merge in any managed default rules (by ruleId) missing from an older file,
      // so upgrades pick up new seed entries without wiping operator additions.
      const have = new Set(this.entries.map((e) => e.ruleId).filter(Boolean));
      const added = DEFAULT_ENTRIES.filter((d) => d.ruleId && !have.has(d.ruleId));
      if (added.length) {
        this.entries.push(...added);
        await this.persist();
      }
      this.log.info('allowlist loaded', { entries: this.entries.length, seededAdded: added.length });
    } catch {
      this.entries = [...DEFAULT_ENTRIES];
      await this.persist();
      this.log.info('allowlist seeded with defaults', { entries: this.entries.length });
    }
  }

  list(): AllowlistEntry[] {
    return this.entries.map((e) => ({ ...e }));
  }

  /** Add (or replace by adapter+pattern) an entry and persist atomically. */
  async add(entry: AllowlistEntry): Promise<void> {
    this.entries = this.entries.filter(
      (e) => !(e.adapter === entry.adapter && e.actionPattern === entry.actionPattern),
    );
    this.entries.push(entry);
    await this.persist();
  }

  async remove(adapter: string, actionPattern: string): Promise<boolean> {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => !(e.adapter === adapter && e.actionPattern === actionPattern));
    if (this.entries.length === before) return false;
    await this.persist();
    return true;
  }

  /** Entries matching a principal+action, deny taking precedence. */
  matches(principal: string, action: string): { allow?: AllowlistEntry; deny?: AllowlistEntry } {
    let allow: AllowlistEntry | undefined;
    let deny: AllowlistEntry | undefined;
    for (const e of this.entries) {
      if (!adapterMatches(e.adapter, principal)) continue;
      if (!patternMatches(e.actionPattern, action)) continue;
      if (e.effect === 'deny') deny = e;
      else if (!allow) allow = e;
    }
    return { ...(allow ? { allow } : {}), ...(deny ? { deny } : {}) };
  }

  private async persist(): Promise<void> {
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify(this.entries, null, 2), 'utf8');
    await rename(tmp, this.path); // atomic on the same filesystem
  }
}

function adapterMatches(pattern: string, principal: string): boolean {
  return pattern === '*' || pattern === principal;
}

/** Glob match supporting a trailing/embedded '*'. */
function patternMatches(pattern: string, action: string): boolean {
  if (pattern === action) return true;
  if (!pattern.includes('*')) return false;
  const rx = new RegExp('^' + pattern.split('*').map(escapeRegex).join('.*') + '$');
  return rx.test(action);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
