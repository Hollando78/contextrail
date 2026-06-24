/**
 * Bundles the browser/PWA desklet client (src/desklet) into a single static
 * asset served by the Local Transport Server's HTTP Static Asset Server.
 * The desklet is a zero-install browser client (ARC-REQ-002).
 */
import { build } from 'esbuild';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entry = resolve(root, 'src/desklet/main.ts');
const outfile = resolve(root, 'src/host/public/desklet.js');

if (!existsSync(entry)) {
  console.error(`[build-desklet] entry not found yet: ${entry} (skipping)`);
  process.exit(0);
}

await mkdir(dirname(outfile), { recursive: true });
await build({
  entryPoints: [entry],
  bundle: true,
  format: 'iife',
  target: ['es2020'],
  sourcemap: true,
  minify: false,
  outfile,
  logLevel: 'info',
});
console.log(`[build-desklet] wrote ${outfile}`);
