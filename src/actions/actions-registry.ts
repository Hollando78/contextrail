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
import { readFileSync, writeFileSync, existsSync, watchFile, unwatchFile } from 'node:fs';
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

/** A desklet-originated action awaiting operator approval on the host console. */
export interface ActionProposal {
  proposalId: string;
  def: ActionDef;
  /** deviceId of the proposing desklet. */
  by: string;
  at: string;
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'action';
}

export class ActionsRegistry {
  private defs: ActionDef[] = [];
  private listeners: Array<() => void> = [];
  private watched: string[] = [];
  /** In-memory queue of desklet proposals awaiting operator approval. */
  private pending: ActionProposal[] = [];
  private proposalSeq = 0;
  /** Set while we write actions.local.json so our own watch-fire is ignored. */
  private selfWriting = false;

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

  /** Watch both config files and reload + notify listeners on external change. */
  watch(): void {
    this.watched = [this.committedPath, this.localPath];
    for (const path of this.watched) {
      watchFile(path, { interval: 2_000 }, () => {
        if (this.selfWriting) return; // ignore our own save() writes
        this.load();
        for (const cb of this.listeners) cb();
      });
    }
  }

  onChange(cb: () => void): void {
    this.listeners.push(cb);
  }

  stop(): void {
    for (const path of this.watched) unwatchFile(path);
  }

  list(): ActionDef[] {
    return this.defs.map((a) => ({ ...a }));
  }

  // --- Editing (operator console + approved proposals) -------------------------

  /**
   * Validate and normalise a (partial) action definition. Derives a unique id
   * from the label when none is supplied; enforces the per-kind required fields.
   */
  private normalise(input: Partial<ActionDef>, takenIds: Set<string>): ActionDef {
    const kind = input.kind;
    if (kind !== 'app' && kind !== 'url' && kind !== 'script' && kind !== 'ssh') {
      throw new Error('kind must be app, url, script, or ssh');
    }
    const label = String(input.label ?? '').trim();
    if (!label) throw new Error('label is required');

    let id = String(input.id ?? '').trim().toLowerCase();
    if (id && !/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error('id must be lowercase letters, digits, and dashes');
    if (!id) {
      const base = slugify(label);
      id = base;
      let n = 2;
      while (takenIds.has(id)) id = `${base}-${n++}`;
    }

    const def: ActionDef = { id, label, kind };
    if (input.icon) def.icon = String(input.icon).slice(0, 32);
    if (input.group) def.group = String(input.group).slice(0, 48);

    if (kind === 'app' || kind === 'url' || kind === 'script') {
      const target = String(input.target ?? '').trim();
      if (!target) throw new Error(`${kind} action requires a target`);
      def.target = target;
      if (kind === 'script' && Array.isArray(input.args)) def.args = input.args.map((a) => String(a));
    }
    if (kind === 'ssh') {
      const command = String(input.command ?? '').trim();
      const host = String(input.host ?? '').trim();
      if (!command) throw new Error('ssh action requires a command');
      if (!host) throw new Error('ssh action requires a host');
      def.command = command;
      def.host = host;
      def.commandClass = input.commandClass === 'streaming' ? 'streaming' : 'bounded';
    }
    return def;
  }

  /** Add or update an action and persist it to actions.local.json. */
  async upsert(input: Partial<ActionDef>): Promise<ActionDef> {
    const requestedId = String(input.id ?? '').trim().toLowerCase();
    const taken = new Set(this.defs.map((d) => d.id).filter((existing) => existing !== requestedId));
    const def = this.normalise(input, taken);
    const next = this.defs.some((d) => d.id === def.id)
      ? this.defs.map((d) => (d.id === def.id ? def : d))
      : [...this.defs, def];
    await this.save(next);
    return def;
  }

  /** Remove an action by id. Returns false if it didn't exist. */
  async remove(id: string): Promise<boolean> {
    const next = this.defs.filter((d) => d.id !== id);
    if (next.length === this.defs.length) return false;
    await this.save(next);
    return true;
  }

  /** Replace the whole set (validated) and persist. */
  async save(defs: ActionDef[]): Promise<void> {
    const taken = new Set<string>();
    const validated = defs.map((d) => {
      const norm = this.normalise(d, taken);
      taken.add(norm.id);
      return norm;
    });
    this.selfWriting = true;
    try {
      writeFileSync(this.localPath, JSON.stringify(validated, null, 2) + '\n', 'utf8');
    } finally {
      // Release after the watch poll window so the self-write isn't re-ingested.
      setTimeout(() => { this.selfWriting = false; }, 2_500).unref?.();
    }
    this.defs = validated;
    this.log.info('actions saved', { count: validated.length, path: this.localPath });
    for (const cb of this.listeners) cb();
  }

  // --- Proposals (desklet → operator approval) --------------------------------

  /** Queue a desklet-proposed action for operator approval. */
  propose(input: Partial<ActionDef>, by: string): ActionProposal {
    const def = this.normalise(input, new Set(this.defs.map((d) => d.id)));
    const proposal: ActionProposal = {
      proposalId: `prop-${++this.proposalSeq}-${Date.now().toString(36)}`,
      def,
      by,
      at: new Date().toISOString(),
    };
    this.pending.push(proposal);
    if (this.pending.length > 50) this.pending.shift();
    this.log.info('action proposed (awaiting approval)', { id: def.id, by });
    return proposal;
  }

  proposals(): ActionProposal[] {
    return this.pending.map((p) => ({ ...p }));
  }

  /** Approve a proposal: promote it to a live action and clear it. */
  async approveProposal(proposalId: string): Promise<ActionDef | null> {
    const p = this.pending.find((x) => x.proposalId === proposalId);
    if (!p) return null;
    this.pending = this.pending.filter((x) => x.proposalId !== proposalId);
    return this.upsert(p.def);
  }

  rejectProposal(proposalId: string): boolean {
    const before = this.pending.length;
    this.pending = this.pending.filter((x) => x.proposalId !== proposalId);
    return this.pending.length < before;
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
