/**
 * Obtain a browser-trusted TLS cert for ContextRail via Let's Encrypt DNS-01.
 *
 *   node scripts/get-cert.mjs [domain]        # default: context-rail.com
 *   CERT_STAGING=1 node scripts/get-cert.mjs  # use the LE staging CA (dry run)
 *   CERT_EMAIL=you@example.com ...            # optional expiry-notice email
 *
 * DNS-01 proves domain ownership via a TXT record — no inbound internet / no open
 * ports needed. The script prints the TXT record to add at your DNS provider,
 * auto-detects when it's live (polling public resolvers), then writes:
 *   certs/cert.pem   (full chain)   certs/key.pem   (private key)
 * Point config tls.certPath/keyPath at these and restart the host. See docs/TLS.md.
 */
import acme from 'acme-client';
import { Resolver } from 'node:dns/promises';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';

const domain = process.argv[2] || 'context-rail.com';
const staging = process.env.CERT_STAGING === '1';
const email = process.env.CERT_EMAIL; // optional
const POLL_INTERVAL_MS = 10_000;
const POLL_TIMEOUT_MS = 20 * 60_000; // 20 minutes to add the record

mkdirSync('certs', { recursive: true });

const resolver = new Resolver();
resolver.setServers(['1.1.1.1', '8.8.8.8']); // public resolvers, avoid local cache

async function txtIsLive(name, expected) {
  try {
    const recs = await resolver.resolveTxt(name);
    return recs.some((chunks) => chunks.join('') === expected);
  } catch {
    return false; // NXDOMAIN / not yet present
  }
}

async function waitForTxt(name, expected) {
  const start = Date.now();
  process.stdout.write(`\n  waiting for DNS TXT to go live (checking every ${POLL_INTERVAL_MS / 1000}s)…\n`);
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    if (await txtIsLive(name, expected)) {
      console.log('  ✓ TXT record detected — continuing\n');
      return;
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    process.stdout.write('  …still waiting (add the record above, propagation can take a few minutes)\n');
  }
  throw new Error(`TXT record did not appear within ${POLL_TIMEOUT_MS / 60000} min`);
}

async function main() {
  // Reuse a persisted ACME account key so re-runs don't create new accounts.
  let accountKey;
  if (existsSync('certs/acct.key')) {
    accountKey = readFileSync('certs/acct.key');
  } else {
    accountKey = await acme.crypto.createPrivateKey();
    writeFileSync('certs/acct.key', accountKey);
  }

  const client = new acme.Client({
    directoryUrl: staging ? acme.directory.letsencrypt.staging : acme.directory.letsencrypt.production,
    accountKey,
  });

  console.log(`\nRequesting ${staging ? 'STAGING (not trusted) ' : ''}certificate for: ${domain}\n`);

  const [key, csr] = await acme.crypto.createCsr({ commonName: domain });

  const cert = await client.auto({
    csr,
    ...(email ? { email } : {}),
    termsOfServiceAgreed: true,
    challengePriority: ['dns-01'],
    challengeCreateFn: async (authz, challenge, keyAuthorization) => {
      const name = `_acme-challenge.${authz.identifier.value}`;
      console.log('\n=== ADD THIS DNS RECORD AT YOUR REGISTRAR ===');
      console.log(`  Type:  TXT`);
      console.log(`  Name:  ${name}`);
      console.log(`  Value: ${keyAuthorization}`);
      console.log('  TTL:   60 (or lowest available)');
      console.log('============================================');
      await waitForTxt(name, keyAuthorization);
    },
    challengeRemoveFn: async () => {
      /* leave the record; you can delete it after issuance */
    },
  });

  writeFileSync('certs/cert.pem', cert);
  writeFileSync('certs/key.pem', key.toString());
  console.log('\n✓ Certificate issued.');
  console.log('  certs/cert.pem  (full chain)');
  console.log('  certs/key.pem   (private key)');
  console.log('\nNext: set tls.certPath/keyPath/publicHost in config and restart the host.');
  if (staging) console.log('\n(NOTE: staging cert is NOT browser-trusted — re-run without CERT_STAGING=1 for a real cert.)');
}

main().catch((err) => {
  console.error('\n✗ Certificate request failed:', err.message);
  process.exit(1);
});
