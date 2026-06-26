/**
 * Tailscale helpers (host-side, best-effort).
 *
 * Detects the node's MagicDNS name so the host can advertise a Tailscale-Served
 * URL (e.g. https://desktop-x.tailnet.ts.net/) in the pairing QR. That name —
 * unlike the raw 100.x Tailscale IP — gets a browser-trusted cert from
 * `tailscale serve`, which is what makes the desklet a secure context (PWA
 * install, wake lock) on a phone with no certificate warning.
 */
import { spawn } from 'node:child_process';

export function tailscaleBin(): string {
  return process.platform === 'win32' ? 'C:\\Program Files\\Tailscale\\tailscale.exe' : 'tailscale';
}

/** The node's MagicDNS name (trailing dot stripped), or null if unavailable. */
export function detectTailscaleName(): Promise<string | null> {
  return new Promise((resolve) => {
    let out = '';
    try {
      const p = spawn(tailscaleBin(), ['status', '--json'], { windowsHide: true });
      p.stdout?.on('data', (c) => (out += c));
      p.on('error', () => resolve(null));
      p.on('close', () => {
        try {
          const j = JSON.parse(out) as { Self?: { DNSName?: string } };
          const name = String(j?.Self?.DNSName ?? '').replace(/\.$/, '').trim();
          resolve(name || null);
        } catch {
          resolve(null);
        }
      });
    } catch {
      resolve(null);
    }
  });
}
