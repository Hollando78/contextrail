/**
 * Actions Registry.
 *
 * The customisable set of high-level actions an Actions desklet can dispatch.
 * Loaded from `config/actions.local.json` (operator override, git-ignored) or
 * `config/actions.json` (committed default), hot-reloaded on change. The Workspace
 * Context Store streams the list to Actions desklets; the Intent Router resolves a
 * dispatched action id against this registry. Operators customise actions by
 * editing the file — no code changes.
 */
import { readFileSync, existsSync, watchFile, unwatchFile } from 'node:fs';
import type { Logger } from '../core/logger.js';

export type ActionKind = 'app' | 'url' | 'script' | 'ssh';

export interface ActionDef {
  /** Unique id (used for dispatch + allowlist gating). */
  id: string;
  /** Button label shown on the desklet. */
  label: string;
  /** Short glyph/emoji for the tile. */
  icon?: string;
  kind: ActionKind;
  /** app: application name/path · url: URL · script: executable/script path. */
  target?: string;
  /** script: argument vector. */
  args?: string[];
  /** ssh: command text. */
  command?: string;
  /** ssh: target host alias (from ~/.ssh/config). */
  host?: string;
  /** ssh: bounded (30s) or streaming (deploy/backup). */
  commandClass?: 'bounded' | 'streaming';
  /** Optional grouping for the UI. */
  group?: string;
}

/** What the desklet needs to render a tile (no host-side target details). */
export interface ActionView {
  id: string;
  label: string;
  icon?: string;
  kind: ActionKind;
  group?: string;
}

export class ActionsRegistry {
  private defs: ActionDef[] = [];
  private listeners: Array<() => void> = [];
  private watched: string | undefined;

  constructor(
    private readonly committedPath: string,
    private readonly localPath: string,
    private readonly log: Logger,
  ) {}

  private activePath(): string {
    return existsSync(this.localPath) ? this.localPath : this.committedPath;
  }

  load(): void {
    const path = this.activePath();
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as ActionDef[];
      this.defs = Array.isArray(parsed) ? parsed.filter((a) => a && a.id && a.label && a.kind) : [];
      this.log.info('actions loaded', { count: this.defs.length, path });
    } catch (err) {
      this.log.warn('failed to load actions config', { path, err: (err as Error).message });
      this.defs = [];
    }
  }

  /** Watch the active file and reload + notify listeners on change. */
  watch(): void {
    const path = this.activePath();
    this.watched = path;
    watchFile(path, { interval: 2_000 }, () => {
      this.load();
      for (const cb of this.listeners) cb();
    });
  }

  onChange(cb: () => void): void {
    this.listeners.push(cb);
  }

  stop(): void {
    if (this.watched) unwatchFile(this.watched);
  }

  list(): ActionDef[] {
    return this.defs.map((a) => ({ ...a }));
  }

  /** Desklet-safe projection — labels/icons only, no host targets. */
  views(): ActionView[] {
    return this.defs.map((a) => ({
      id: a.id,
      label: a.label,
      kind: a.kind,
      ...(a.icon ? { icon: a.icon } : {}),
      ...(a.group ? { group: a.group } : {}),
    }));
  }

  get(id: string): ActionDef | undefined {
    return this.defs.find((a) => a.id === id);
  }
}
