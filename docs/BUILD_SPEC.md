# ContextRail — Build Specification Digest

Distilled from `docs/requirements.json` (319 requirements). Counts: 12 stakeholder,
16 system, 21 architecture-decisions, 81 subsystem, 56 interface, 133 verification.
All concrete constants are centralised in `src/core/constants.ts`.

## System summary

Local-first host process that owns workspace context and brokers host-mediated
actions to zero-state browser desklets over a local WSS transport. The host is the
sole point of execution, credential storage, and network access (ARC-REQ-001).
Desklets are browser/PWA render+dispatch surfaces, no native install (ARC-REQ-002).
No cloud / no outbound internet for core function (SYS-REQ-016, STK-REQ-011).

## Roles & modes

- Roles (exactly one per desklet): **Project, Actions, Status, Capture, Logs, AI**
  (STK-REQ-003, SYS-REQ-007).
- Operational modes (Mode State Machine, SUB-HCR-016): **Nominal, Degraded,
  Maintenance**. Overlays: **Initialising** (boot), **Locked** (SLM confidentiality
  safe-state, ARC-REQ-006).
- Boot order (SUB-HCR-019): Config Loader → Workspace Context Store → Security and
  Lock Manager → Allowlist & Configuration Governance → Local Transport Server →
  Adapter Framework → Intent Router. Each READY within 5 s; total boot ≤ 30 s.

## Subsystem decomposition (17 parts)

| Subsystem | Components | Key refs |
|---|---|---|
| Host Core Runtime (HCR) | Configuration Loader, Startup Orchestrator, Health Watchdog, Mode State Machine | SUB-HCR-016..020 |
| Workspace Context Store (CTX) | Context Object Registry, Role Scope Filter, Event Bus Adapter | SUB-CTX-030..034,079,080 |
| Security and Lock Manager (SLM) | Pairing Token Authority, Host Authenticator, Lock State Controller, Context Access Guard | SUB-SLM-001..006 |
| Allowlist & Config Governance (ACG) | Policy Engine, Allowlist Store, Maintenance Config Interface, Allowlist Audit Logger | SUB-ACG-007..010,078 |
| Local Transport Server (XPT) | WebSocket Gateway, HTTP Static Asset Server, Connection Registry, Heartbeat Monitor, Channel Multiplexer | SUB-XPT-039..045,069 |
| Desklet Pairing & Identity (PAIR) | Pairing Token Generator, Device Identity Ledger, Role Assignment Manager, Heartbeat Monitor | SUB-PAIR-035..038 |
| Intent Router (INT) | Intent Dispatcher, Conflict Serialiser, Dispatch Confirmer | SUB-INT-011..015 |
| Workspace Executor (EXE) | Command Dispatcher, Process Supervisor, Outcome Reporter | SUB-EXE-021..026 |
| Adapter Framework (ADP) | Action Broker, Adapter Registry, Adapter Manifest Loader | SUB-ADP-027..029,070..072,081,082 |
| Remote Action Gateway (RAG) | Allowlist Gate, SSH Session Manager, Remote Action Result Emitter | SUB-RAG-046..050 |
| Remote SSH Boundary (RSB) | SSH Session Rate Limiter, SSH Command Gate, SSH Config Resolver, SSH Audit Logger | SUB-RSB-060..063,075..077 |
| Deep Integration Boundary (DIB) | Deep Adapter Protocol Handler, Event Subscription Manager, Deep Session Tracker, Capability Scope Enforcer | SUB-DIB-056..059 |
| External Application Boundary (EAB) | Action Request Serialiser, Adapter Health Probe, Adapter Response Validator, HTTP Callback Dispatcher | SUB-EAB-066, SUB-ADP-081,082 |
| Desklet Web Boundary (DWB) | Context Push Relay, Intent Receiver, Static Asset Handler, WebSocket Admission Controller | SUB-DWB-064,065 |
| Desklet Client Framework (DCF) | Desklet Shell Renderer, Lifecycle State Machine, Context Feed Client, Connection Health Monitor | SUB-DCF-051..055 |
| Knowledge Worker Desklet Station (KWD) | Desklet Browser Client, Intent Dispatch Control, Pairing QR Scanner, Role Context Renderer | SUB-KWD-068,074 |
| Host Administration Station (HAS) | Allowlist Management CLI, Audit Log Viewer, Host Credential Validator, Mode Control Interface | SUB-HAS-067,073 |

## Architecture decisions (selected, ARC-REQ-001..021)

- **001** Host sole execution/credential/network point; desklets zero-state.
- **003** Single default-deny allowlist gate for BASIC/DEEP/SSH; edits Maintenance-only.
- **004** Single-use 60 s pairing token bound to device for the session.
- **006** Locked = confidentiality safe-state; streaming + intents cease ≤ 1 s; allowlist stays enforced; resume on host re-auth.
- **008** Policy Engine in-process, synchronous, default-deny (no IPC/remote — offline).
- **009** INT in-process, < 5 ms/hop (separate-process rejected; > 10 ms risks 200 ms budget).
- **011** Executor: Command Dispatcher → Process Supervisor (single timeout/SIGKILL point) → Outcome Reporter.
- **014** XPT single Node process, HTTP static + WS gateway on the same port; ≤ 5 ms dispatch for 16 desklets at up to 60 Hz; per-socket send queues.
- **015** RAG fresh SSH session per action (no pool); reuse ControlMaster if available; no embedded ssh creds (use operator config); 30 s bounded timeout.
- **016** DCF in-process event bus; < 500 ms role render, < 1 s quiesce.
- **017** DIB bidirectional JSON-RPC over Unix domain socket; DEEP adapters co-located.
- **018** RSB sequence: rate-check → allowlist-check → credential-resolve → spawn → audit. Credentials never read until rate+allowlist pass.
- **020** SSH audit under ISO 27001 A.8.15 + data-minimisation: log command/host/adapter/verdict/duration/result only; exclude creds/keys/content; 90-day retention.
- **021** Allowlist gate per IEC 62443-3-3 SR 2.1; rejections name denied command class + allowlist reference.

## Key numbers (see `src/core/constants.ts` for the full set + refs)

- Intent round-trip ≤ **200 ms** p95 (SYS-REQ-009); context propagation ≤ 200 ms (SYS-REQ-012).
- Channel dispatch ≤ **5 ms** for 16 conns (SUB-XPT-042); policy decision ≤ 5 ms p99 (SUB-ACG-007).
- Heartbeat **2 s** ping / **5 s** pong (XPT); **1 s** probe / 5 s ack (PAIR); link-loss detect ≤ 5 s.
- Lock quiesce ≤ **1 s** (SYS-REQ-003). Health poll 2 s ± 100 ms, 2 misses → failed (SUB-HCR-018).
- Pairing token TTL **60 s** (session) / **30 s** (QR display), ≥ **128-bit** entropy, single-use, one outstanding.
- Local exec timeout **5 s** → SIGKILL process group; capture first **4 KB** + SHA-256 (SUB-EXE-022,023).
- SSH bounded **30 s**; streaming (deploy/backup) unbounded; **10 cmds/60 s** + burst 3; **4** concurrent; stdout ≤ 1 MiB / stderr ≤ 64 KiB; audit ≥ 90 days.
- Max **8** paired desklets; context queue **200** drop-oldest; **50** command history; **10 Hz** streaming.
- Status codes: 401 (bad WS token), 403 (unauthenticated upgrade), SSH DENY exit 126, SSH timeout exit_code −1 / 'TIMEOUT'.
- Command Dispatcher routing: '' / 'local' → Process Supervisor; 'rag' → RAG; other → Adapter Framework (SUB-EXE-026).

## Standards

TLS 1.3 (WSS), RFC 6455 (WebSocket), RFC 1918 (local callbacks), ISO 8601, SHA-256,
JSON Schema (config), JSON-RPC (DEEP), SSE (context), MCP/extension APIs (DEEP),
IEC 62443-3-3 SR 2.1, ISO/IEC 27001 A.8.15, GDPR Art. 5(1)(c), ISO/IEC/IEEE 25010.
