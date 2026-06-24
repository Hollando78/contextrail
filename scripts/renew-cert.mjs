/**
 * Renew the Let's Encrypt cert when it's close to expiry, then signal the host to
 * reload it. Intended to run unattended on a schedule (Task Scheduler / cron).
 *
 *   node scripts/renew-cert.mjs [domain] [--force]
 *
 * Renewal still uses DNS-01. For a HANDS-OFF renewal you must let the ACME client
 * set the _acme-challenge TXT automatically via your DNS provider's API — pass a
 * hook command in CERT_DNS_HOOK that publishes the TXT (it receives the record
 * name and value as args). Without a hook, this runs the interactive issuer
 * (prints the TXT and polls), which is fine for a manual/assisted renewal.
 *
 * Exit 0 = cert valid / renewed; non-zero = renewal needed but could not complete.
 */
import { X509Certificate } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const domain = process.argv[2]?.startsWith('--') ? 'context-rail.com' : process.argv[2] || 'context-rail.com';
const force = process.argv.includes('--force');
const RENEW_WHEN_DAYS_LEFT = 30;

function daysLeft() {
  if (!existsSync('certs/cert.pem')) return -1;
  try {
    const to = new Date(new X509Certificate(readFileSync('certs/cert.pem')).validTo).getTime();
    return Math.floor((to - Date.now()) / 86_400_000);
  } catch {
    return -1;
  }
}

const left = daysLeft();
if (!force && left > RENEW_WHEN_DAYS_LEFT) {
  console.log(`Cert valid for ${left} more days (> ${RENEW_WHEN_DAYS_LEFT}); no renewal needed.`);
  process.exit(0);
}

console.log(`Cert has ${left < 0 ? 'no/invalid' : left + ' days'} left — renewing ${domain}…`);
const res = spawnSync(process.execPath, ['scripts/get-cert.mjs', domain], { stdio: 'inherit' });
if (res.status !== 0) {
  console.error('Renewal did not complete.');
  process.exit(res.status ?? 1);
}
console.log('Renewed. Restart the host (or it will pick up the new cert on next start) to serve it.');
