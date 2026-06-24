/**
 * Cloudflare DNS-01 hook for the cert issuer (CERT_DNS_HOOK).
 *
 * Publishes / removes the _acme-challenge TXT record via the Cloudflare API so
 * Let's Encrypt renewal is fully hands-off. Invoked by scripts/get-cert.mjs as:
 *   node scripts/cf-dns-hook.mjs <recordName> <value> [add|remove]
 *
 * Requires a Cloudflare API token with Zone:DNS:Edit on the domain:
 *   CLOUDFLARE_API_TOKEN=...    (required)
 *   CLOUDFLARE_ZONE_ID=...      (optional; looked up by domain if omitted)
 *
 * Store the token outside the repo (e.g. a git-ignored env). Never commit it.
 */
const API = 'https://api.cloudflare.com/client/v4';
const [recordName, value, mode = 'add'] = process.argv.slice(2);
const token = process.env.CLOUDFLARE_API_TOKEN;

if (!token) {
  console.error('CLOUDFLARE_API_TOKEN is not set');
  process.exit(1);
}
if (!recordName || (mode === 'add' && !value)) {
  console.error('usage: cf-dns-hook.mjs <recordName> <value> [add|remove]');
  process.exit(1);
}

const headers = { Authorization: `Bearer ${token}`, 'content-type': 'application/json' };

async function cf(path, init) {
  const res = await fetch(`${API}${path}`, { ...init, headers });
  const body = await res.json();
  if (!body.success) throw new Error(`Cloudflare API: ${JSON.stringify(body.errors)}`);
  return body.result;
}

/** Apex domain for a record name (strip the _acme-challenge. label). */
function apexOf(name) {
  return name.replace(/^_acme-challenge\./, '');
}

async function zoneId() {
  const pinned = process.env.CLOUDFLARE_ZONE_ID;
  // A real zone ID is 32 hex chars. Anything else (blank, or a domain name) →
  // look it up by name (requires the token to also have Zone:Read).
  if (pinned && /^[0-9a-f]{32}$/i.test(pinned)) return pinned;
  const zones = await cf(`/zones?name=${encodeURIComponent(apexOf(recordName))}`, { method: 'GET' });
  if (!zones.length) {
    throw new Error(
      `no Cloudflare zone for ${apexOf(recordName)} — set CLOUDFLARE_ZONE_ID to the 32-char hex Zone ID, or grant the token Zone:Read`,
    );
  }
  return zones[0].id;
}

async function main() {
  const zid = await zoneId();
  const existing = await cf(`/zones/${zid}/dns_records?type=TXT&name=${encodeURIComponent(recordName)}`, { method: 'GET' });

  if (mode === 'remove') {
    for (const rec of existing) await cf(`/zones/${zid}/dns_records/${rec.id}`, { method: 'DELETE' });
    console.log(`cf-dns-hook: removed ${existing.length} TXT record(s) for ${recordName}`);
    return;
  }

  // add — replace any stale record then create the current one
  for (const rec of existing) {
    if (rec.content === value) {
      console.log('cf-dns-hook: TXT already present');
      return;
    }
    await cf(`/zones/${zid}/dns_records/${rec.id}`, { method: 'DELETE' });
  }
  await cf(`/zones/${zid}/dns_records`, {
    method: 'POST',
    body: JSON.stringify({ type: 'TXT', name: recordName, content: value, ttl: 60 }),
  });
  console.log(`cf-dns-hook: published TXT ${recordName}`);
}

main().catch((err) => {
  console.error('cf-dns-hook failed:', err.message);
  process.exit(1);
});
