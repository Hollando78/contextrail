/**
 * SSH Config Resolver (RSB).
 *
 * Resolves a target host alias from the host operator's existing SSH config
 * (~/.ssh/config). Credentials/identity files are never read until the command
 * has passed both the rate-limit and allowlist checks — this resolver is invoked
 * only after those gates. No SSH credentials are ever accepted from a desklet.
 * (SUB-RAG-047, ARC-REQ-018, SUB-RSB-060)
 */
import { readFile } from 'node:fs/promises';
import type { Logger } from '../core/logger.js';
import { expandTilde } from '../core/paths.js';

export interface ResolvedHost {
  alias: string;
  hostName: string;
  user?: string;
  port: number;
  identityFile?: string;
}

export class SshConfigResolver {
  constructor(
    private readonly configPath: string,
    private readonly log: Logger,
  ) {}

  /** Parse the SSH config and resolve a Host alias. Returns null if not found. */
  async resolve(alias: string): Promise<ResolvedHost | null> {
    let text: string;
    try {
      text = await readFile(expandTilde(this.configPath), 'utf8');
    } catch {
      this.log.warn('ssh config not readable', { path: this.configPath });
      return null;
    }

    const blocks = parseSshConfig(text);
    const block = blocks.find((b) => b.hosts.includes(alias) || b.hosts.some((h) => globMatch(h, alias)));
    if (!block) return null;

    return {
      alias,
      hostName: block.settings['hostname'] ?? alias,
      ...(block.settings['user'] ? { user: block.settings['user'] } : {}),
      port: block.settings['port'] ? Number(block.settings['port']) : 22,
      ...(block.settings['identityfile'] ? { identityFile: expandTilde(block.settings['identityfile']) } : {}),
    };
  }
}

interface HostBlock {
  hosts: string[];
  settings: Record<string, string>;
}

function parseSshConfig(text: string): HostBlock[] {
  const blocks: HostBlock[] = [];
  let current: HostBlock | undefined;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const sp = line.indexOf(' ');
    const key = (sp === -1 ? line : line.slice(0, sp)).toLowerCase();
    const value = sp === -1 ? '' : line.slice(sp + 1).trim();
    if (key === 'host') {
      current = { hosts: value.split(/\s+/), settings: {} };
      blocks.push(current);
    } else if (current) {
      current.settings[key] = value;
    }
  }
  return blocks;
}

function globMatch(pattern: string, value: string): boolean {
  if (!pattern.includes('*')) return pattern === value;
  const rx = new RegExp('^' + pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
  return rx.test(value);
}
