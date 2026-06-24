# TLS & trust

ContextRail desklets connect over **TLS (WSS)**, so the link is always encrypted.
What differs between setups is whether the browser *trusts* the certificate (no
warning) — that depends on who runs the host and who the desklets belong to.

Pick the option that matches your deployment. The default needs zero setup.

---

## 1. Self-signed (default — zero config)

Out of the box the host generates a self-signed cert (persisted across restarts,
see `tls.persist`). Desklets get a one-time **"Not secure → Advanced → Proceed"**
prompt per device, then connect silently forever after.

- Best for: personal use, evaluation, a single operator with their own spare devices.
- No domain, no account, fully offline.
- The cert is stored under the data dir (`data/tls-cert.pem`, `data/tls-key.pem`)
  and reused on restart so paired devices reconnect without re-accepting it.

Nothing to configure.

---

## 2. Bring-your-own CA-signed cert (no warnings, recommended for third parties)

If desklets belong to people you don't control (guests, colleagues), don't ask
them to trust your private CA or join your network — give the host a
**browser-trusted certificate** instead. Any device then connects with no warning
and nothing to install.

Config (`config/contextrail.config.json`):

```jsonc
"tls": {
  "commonName": "contextrail.local",
  "certPath": "./certs/cert.pem",   // full chain (PEM)
  "keyPath":  "./certs/key.pem",    // private key (PEM) — never commit this
  "publicHost": "your-domain.example"
}
```

When both files exist they're used as-is and `publicHost` is preferred in pairing
URLs. **`certs/` and `*.pem` are git-ignored — never commit a private key.**

### Getting a cert with Let's Encrypt (DNS-01) — no inbound internet needed

DNS-01 proves you own the domain via a DNS TXT record, so the host stays
LAN-only (no port forwarding, no public exposure — consistent with the
local-first model). Run an ACME client **on the host machine**:

```bash
# acme.sh example (manual DNS)
acme.sh --issue --dns -d your-domain.example --yes-I-know-dns-manual-mode-enough-go-ahead-please
# add the printed _acme-challenge TXT record at your DNS provider, then:
acme.sh --renew --dns -d your-domain.example --yes-I-know-dns-manual-mode-enough-go-ahead-please
acme.sh --install-cert -d your-domain.example \
  --key-file       ./certs/key.pem \
  --fullchain-file ./certs/cert.pem
```

(`certbot certonly --manual --preferred-challenges dns -d your-domain.example`
works equally well; point `certPath`/`keyPath` at the issued files.)

### Make the name resolve to the host on the LAN

Desklets connect to `https://your-domain.example:<port>`, so that name must
resolve to the host's **LAN IP** for devices on the network. Either:

- a **public A record** `your-domain.example → 192.168.x.y` (a private IP; resolves
  for anyone, but only reachable on that LAN), or
- a **local/router DNS** entry / split-horizon DNS.

Use a static DHCP lease (or local DNS) so the host IP doesn't move.

### Renewal

Let's Encrypt certs last ~90 days. `npm run cert:renew` renews only when <30 days
remain, and the host **hot-reloads** the new cert with no restart (it watches the
cert file). Schedule it weekly, e.g. Windows Task Scheduler:

```powershell
schtasks /create /tn "ContextRail cert renew" ^
  /tr "cmd /c cd /d C:\path\to\ContextRail && node scripts\renew-cert.mjs >> data\renew.log 2>&1" ^
  /sc WEEKLY /d SUN /st 03:00 /f
```

#### Fully hands-off renewal (Cloudflare)

If your DNS is on Cloudflare, the included hook publishes/cleans the
`_acme-challenge` TXT automatically — no manual record entry:

1. Create a Cloudflare API token with **Zone → DNS → Edit** on your domain.
2. Provide it to the renewal process via env (keep it out of the repo — e.g. a
   git-ignored `certs/cf.env`):
   ```
   CLOUDFLARE_API_TOKEN=your-token
   CERT_DNS_HOOK=node scripts/cf-dns-hook.mjs
   ```
3. Run `npm run cert` (first issue) or `npm run cert:renew` with those env vars set;
   the hook creates the TXT, the issuer waits for it to go live, finalizes, then the
   hook deletes it. Other providers: point `CERT_DNS_HOOK` at any script taking
   `<recordName> <value> [add|remove]`.

> **Cloudflare A record:** the `context-rail.com → <LAN IP>` A record must be
> **DNS only (grey cloud)**, not proxied — Cloudflare can't proxy to a private IP.

---

## 3. Local CA (mkcert) — no domain, devices you control

If you have no domain but want no warnings on devices you administer, create a
local CA and install its root on each device:

```bash
mkcert -install                       # trust the local CA on this machine
mkcert -cert-file certs/cert.pem -key-file certs/key.pem contextrail.local 192.168.x.y
```

Then set `certPath`/`keyPath` as above. Install the mkcert root CA on each phone
(iOS: install the profile, then enable it under Settings → General → About →
Certificate Trust Settings). **Only do this for devices you own** — installing a
root CA lets it intercept all of that device's TLS.

---

## 4. Tailscale certs — your own devices, anywhere

If your devices are on a Tailscale tailnet, issue a real (publicly-trusted) cert
for the host's MagicDNS name and point `certPath`/`keyPath`/`publicHost` at it:

```bash
tailscale cert your-host.your-tailnet.ts.net   # requires HTTPS enabled in the admin console
```

Desklets connect over the tailnet by that name — no warning, no per-device setup —
but every device must be on your tailnet (not suitable for arbitrary third parties).

---

## Which should I use?

| Situation | Use |
|---|---|
| Just me / evaluation | Self-signed (default) |
| Third parties / guests on the LAN | **CA-signed cert for a domain (option 2)** |
| No domain, devices I own | Local CA / mkcert (option 3) |
| My own devices, on Tailscale | Tailscale certs (option 4) |
