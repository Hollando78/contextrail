# ContextRail

Local-first host runtime that brokers role-scoped workspace context and host-mediated actions to zero-state browser **desklets** — spare phones/tablets repurposed over the local network with no native install.

All credentials, network access, and sensitive execution stay on the host (ARC-REQ-001, SYS-REQ-001). Desklets are pure render/dispatch surfaces. No cloud dependency (STK-REQ-011).

## Status

All 17 subsystems implemented and wired; typecheck clean, 35 unit tests + a
17-check end-to-end harness green. Built against the Reify spec in `docs/`:

- `docs/requirements.json` — the 319 source requirements.
- `docs/BUILD_SPEC.md` — distilled build specification (constants, decisions, interfaces).

### Subsystems

Host Core Runtime (boot order, mode machine, health watchdog) · Workspace Context
Store · Security & Lock Manager · Allowlist & Configuration Governance · Local
Transport Server (HTTPS+WSS, TLS) · Desklet Pairing & Identity · Intent Router ·
Workspace Executor · Adapter Framework (+ External Application & Deep Integration
boundaries) · Remote Action Gateway (+ Remote SSH Boundary) · Host Administration
Station · browser desklet client.

## Run

```bash
npm install
npm run build:desklet     # bundle the browser desklet (one-time / on client change)
npm run host              # start the host (tsx, no compile step)
```

Config: `config/contextrail.config.json` (or set `CONTEXTRAIL_CONFIG`).

### Connect a device (desklet)

Open the **operator console** in a browser on the host machine:

```
http://127.0.0.1:8788
```

Pick a role, and scan the QR image with a spare phone/tablet on the same LAN (or
open the printed URL). The device pairs, binds to the role, and renders live
context. The browser warns about the self-signed TLS cert — accept it (local-first,
no PKI). Roles: `Project, Actions, Status, Capture, Logs, AI`.

> The console is **host-only** (loopback): a device on the LAN cannot mint its own
> pairing token (ARC-REQ-004). If a phone can't reach the host, allow inbound TCP
> 8787 through the host firewall, or connect over Tailscale (the console offers a
> host-address picker).

The link is always TLS-encrypted; the default self-signed cert shows a one-time
browser warning. To remove it (e.g. for guests' devices) — bring your own
CA-signed cert via `tls.certPath`/`keyPath`, or use a local CA / Tailscale. See
**[docs/TLS.md](docs/TLS.md)**.

CLI alternative: `npm run pair -- Status` prints a QR/URL in the terminal.

### Operate (Host Administration Station)

Allowlist edits require Maintenance mode (everything is default-deny):

```bash
node dist/has/allowlist-cli.js status
node dist/has/allowlist-cli.js maintenance on
node dist/has/allowlist-cli.js add rag "service status" allow
node dist/has/allowlist-cli.js maintenance off
node dist/has/allowlist-cli.js lock
node dist/has/allowlist-cli.js unlock <passphrase>     # default dev passphrase: contextrail
node dist/has/allowlist-cli.js audit ssh
```

(Set `CONTEXTRAIL_OPERATOR_HASH` to a SHA-256 hex of your passphrase in production.)

### Remote SSH actions

The Remote Action Gateway uses your existing `~/.ssh/config` and never accepts
credentials from a desklet. Outbound SSH is **dry-run by default**; set
`CONTEXTRAIL_SSH_LIVE=1` to enable real connections. Every command is allowlist-gated
(default-deny), rate-limited (10/60s), and audited (90-day, append-only).

### Verify

```bash
npm test     # 35 unit tests (Vitest)
npm run e2e  # end-to-end: pair, stream context, run an intent, deny SSH, admin flow, lock/unlock
```
