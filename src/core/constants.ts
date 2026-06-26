/**
 * ContextRail — central constants.
 *
 * Every hard number in the specification lives here so the magic values that the
 * requirements pin down are traceable to a single source. Each entry cites the
 * requirement ref(s) that fix it. Do not inline these numbers elsewhere.
 */

/** The desklet roles. Exactly one is bound per desklet. (STK-REQ-003, SYS-REQ-007)
 *  Remote extends the original six: it cycles/focuses host windows and relays
 *  input (e.g. nudging a waiting Claude session to continue). */
export const ROLES = ['Project', 'Actions', 'Status', 'Capture', 'Logs', 'AI', 'Remote', 'Touchpad'] as const;
export type Role = (typeof ROLES)[number];

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

/** Host operating modes exposed by the Mode State Machine. (SUB-HCR-016) */
export const MODES = ['Initialising', 'Nominal', 'Degraded', 'Maintenance', 'Locked'] as const;
export type Mode = (typeof MODES)[number];

/** Timing budgets in milliseconds. */
export const TIMING = {
  /** Intent dispatch → status on originating desklet, p95. (SYS-REQ-009) */
  INTENT_ROUND_TRIP_P95_MS: 200,
  /** Context change → all subscribed desklets. (SYS-REQ-012) */
  CONTEXT_PROPAGATION_MS: 200,
  /** Channel Multiplexer dispatch for up to 16 connections at peak. (SUB-XPT-042) */
  CHANNEL_DISPATCH_MS: 5,
  /** Initial HTTP response for the desklet bundle. (SUB-XPT-043) */
  STATIC_FIRST_BYTE_MS: 300,
  /** Desklet link-loss detection window. (SYS-REQ-008, SUB-XPT-041, SUB-PAIR-038) */
  LINK_LOSS_DETECT_MS: 5_000,
  /** Paired desklet join → role render admitted. (SYS-REQ-006) */
  JOIN_TO_RENDER_MS: 3_000,
  /** Lock → cease streaming / reject intents. (SYS-REQ-003 and many SUB-*-) */
  LOCK_QUIESCE_MS: 1_000,
  /** OS lock event → Lock State Controller signalled. (SUB-SLM-003) */
  OS_LOCK_TO_LSC_MS: 200,
  /** Pairing Token Authority validation. (IFC-SLM-005) */
  TOKEN_VALIDATION_MS: 20,
  /** XPT heartbeat ping interval. (SUB-XPT-041) */
  XPT_PING_INTERVAL_MS: 2_000,
  /** XPT pong timeout before DISCONNECT. (SUB-XPT-041) */
  XPT_PONG_TIMEOUT_MS: 5_000,
  /** Remove connection from registry after disconnect. (SUB-XPT-041) */
  XPT_REGISTRY_REMOVE_MS: 100,
  /** PAIR liveness probe interval. (SUB-PAIR-038) */
  PAIR_PROBE_INTERVAL_MS: 1_000,
  /** PAIR ack timeout (5 consecutive missed probes). (SUB-PAIR-038) */
  PAIR_ACK_TIMEOUT_MS: 5_000,
  /** Health Watchdog poll interval (± 100 ms). (SUB-HCR-018, IFC-XPT-020) */
  HEALTH_POLL_INTERVAL_MS: 2_000,
  HEALTH_POLL_JITTER_MS: 100,
  /** Health endpoint response budget; miss => missed heartbeat. (IFC-XPT-020) */
  HEALTH_RESPONSE_MS: 200,
  /** Per-subsystem READY budget during boot. (SUB-HCR-019, IFC-HCR-016) */
  SUBSYSTEM_READY_MS: 5_000,
  /** Total boot deadline → BOOT_COMPLETE/BOOT_FAILED. (IFC-HCR-015) */
  BOOT_DEADLINE_MS: 30_000,
  /** MODE_DEGRADED broadcast after SUBSYSTEM_FAILED. (SUB-HCR-017) */
  MODE_DEGRADED_BROADCAST_MS: 500,
  /** Local subprocess wall-clock timeout before SIGKILL. (SUB-EXE-022) */
  LOCAL_EXEC_TIMEOUT_MS: 5_000,
  /** Process Supervisor execution-started ack. (SUB-EXE-022) */
  EXEC_STARTED_ACK_MS: 200,
  /** Outcome Reporter publish to WCS bus. (SUB-EXE-024) */
  OUTCOME_PUBLISH_MS: 10,
  /** Dispatch Confirmer outcome delivery / TIMEOUT budget. (SUB-INT-012) */
  DISPATCH_CONFIRM_MS: 200,
  /** SSH bounded-command timeout. (SUB-RSB-061, SUB-RAG-048) */
  SSH_BOUNDED_TIMEOUT_MS: 30_000,
  /** RSB bounded result envelope budget (30 s exec + 2 s overhead). (IFC-RSB-052) */
  SSH_BOUNDED_RESULT_MS: 32_000,
  /** Streaming SSH initiating ack. (IFC-RSB-052) */
  SSH_STREAM_ACK_MS: 2_000,
  /** Max context staleness in Degraded mode. (SYS-REQ-013) */
  DEGRADED_STALENESS_MS: 30_000,
  /** Desklet staleness indicator threshold. (SUB-KWD-068) */
  STALENESS_INDICATOR_MS: 10_000,
  /** DCF WS disconnect detection. (SUB-DCF-054) */
  DCF_DISCONNECT_DETECT_MS: 10_000,
  /** DCF reconnect back-off cap. (SUB-DCF-054) */
  RECONNECT_BACKOFF_CAP_MS: 30_000,
  /** DEEP adapter heartbeat timeout. (SUB-DIB-058) */
  DEEP_HEARTBEAT_TIMEOUT_MS: 10_000,
  /** KWD/DCF crash restart window. (SUB-KWD-074) */
  CLIENT_RESTART_MS: 10_000,
  /** DCF render assigned role. (SUB-DCF-051) */
  ROLE_RENDER_MS: 500,
  /** DCF quiesce. (SUB-DCF-052) */
  QUIESCE_MS: 1_000,
  /** DCF resume. (SUB-DCF-053) */
  RESUME_MS: 3_000,
  /** Policy Engine ALLOW/DENY, p99. (SUB-ACG-007) */
  POLICY_DECISION_P99_MS: 5,
  /** Adapter/RAG permit RPC; non-response => DENY. (IFC-ADP-023, SUB-ADP-027) */
  PERMIT_RPC_TIMEOUT_MS: 10,
  /** EAB action round-trip (5 s callback + 1 s margin). (IFC-EAB-054) */
  EAB_ROUNDTRIP_MS: 6_000,
  EAB_CALLBACK_TIMEOUT_MS: 5_000,
  /** Role-scoped relay after context change. (SUB-DWB-065, SUB-DIB-057, SUB-DCF-055) */
  RELAY_MS: 50,
  /** Context Object Registry write apply. (SUB-CTX-030) */
  CTX_WRITE_MS: 50,
  /** Event Bus Adapter translate to a registry write. (SUB-CTX-032) */
  CTX_TRANSLATE_MS: 30,
  /** Role Scope Filter projection after ContextUpdated. (SUB-CTX-031) */
  CTX_PROJECTION_MS: 100,
  /** Context rebuild after unplanned restart. (SUB-CTX-080) */
  CTX_REBUILD_MS: 2_000,
  /** HAS WARN cadence while session unavailable. (SUB-HAS-073) */
  HAS_WARN_INTERVAL_MS: 60_000,
  /** Housekeeping sweep of expired pairing tokens (defence in depth). */
  TOKENS_SWEEP_MS: 15_000,
} as const;

/** Token lifetimes / entropy. */
export const TOKENS = {
  /** Unredeemed pairing/session token TTL. (SYS-REQ-002, SUB-SLM-001, IFC-PAIR-027) */
  PAIRING_TTL_MS: 60_000,
  /** QR display token expiry if unused. (SUB-PAIR-035) */
  QR_TOKEN_TTL_MS: 30_000,
  /** Minimum entropy of a pairing token. (SUB-PAIR-035) */
  ENTROPY_BITS: 128,
} as const;

/** Rates, quotas, and concurrency limits. */
export const LIMITS = {
  /** Context streaming / update rate. (SUB-XPT-069, SUB-CTX-034, IFC-DCF-045) */
  CONTEXT_HZ: 10,
  /** Max concurrent registered/paired desklets. (SUB-PAIR-036, IFC-CTX-035) */
  MAX_DESKLETS: 8,
  /** Connections used for the resource budget. (SUB-XPT-069) */
  BUDGET_CONNECTIONS: 6,
  /** Connections used for the dispatch-latency target. (SUB-XPT-042) */
  DISPATCH_CONNECTIONS: 16,
  /** SSH commands per rolling window. (SUB-RSB-063) */
  SSH_RATE_LIMIT: 10,
  SSH_RATE_WINDOW_MS: 60_000,
  SSH_RATE_BURST: 3,
  /** Concurrent active SSH sessions. (SUB-RSB-061) */
  SSH_MAX_SESSIONS: 4,
  /** DEEP adapter event delivery cap. (SUB-DIB-057) */
  DEEP_EVENTS_PER_SEC: 100,
  /** Bounded context ingestion queue (drop-oldest). (SUB-CTX-079) */
  CTX_QUEUE_MAX: 200,
  /** Command history entries retained in the snapshot. (SUB-CTX-030) */
  CTX_HISTORY_MAX: 50,
} as const;

/** Payload / buffer size caps. */
export const SIZES = {
  /** Combined stdout/stderr capture for local exec, then SHA-256 + discard. (SUB-EXE-023) */
  LOCAL_OUTPUT_CAP_BYTES: 4 * 1024,
  /** SSH stdout max. (IFC-RAG-044) */
  SSH_STDOUT_MAX_BYTES: 1024 * 1024,
  /** SSH stderr max. (IFC-RAG-044) */
  SSH_STDERR_MAX_BYTES: 64 * 1024,
} as const;

/** Audit / retention. */
export const AUDIT = {
  /** Minimum SSH audit record retention. (SUB-RSB-075, ARC-REQ-020) */
  SSH_RETENTION_DAYS: 90,
} as const;

/**
 * Allowlisted SSH command classes. Arbitrary SSH is never exposed.
 * (STK-REQ-009, IFC-RSB-053, SUB-RSB-061)
 */
export const SSH_COMMAND_CLASSES = [
  'service-status',
  'log-tail',
  'restart',
  'deploy',
  'backup',
  'health-check',
] as const;
export type SshCommandClass = (typeof SSH_COMMAND_CLASSES)[number];

/** Command classes that stream without a fixed ceiling. (SUB-RSB-061) */
export const SSH_STREAMING_CLASSES: ReadonlySet<SshCommandClass> = new Set(['deploy', 'backup']);

/**
 * BASIC adapter action kinds mediated through the External Application Boundary.
 * (IFC-EAB-055)
 */
export const BASIC_ADAPTER_ACTIONS = [
  'app-launch',
  'url-open',
  'local-script',
  'keyboard-sim',
  'workspace-restore',
] as const;
export type BasicAdapterAction = (typeof BASIC_ADAPTER_ACTIONS)[number];

/**
 * Subsystem boot order. (SUB-HCR-019)
 * The remaining subsystems (pairing, executor, gateways, boundaries) are owned and
 * started by the seven listed roots, so this is the authoritative top-level sequence.
 */
export const BOOT_ORDER = [
  'ConfigurationLoader',
  'WorkspaceContextStore',
  'SecurityAndLockManager',
  'AllowlistAndConfigurationGovernance',
  'LocalTransportServer',
  'AdapterFramework',
  'IntentRouter',
] as const;
