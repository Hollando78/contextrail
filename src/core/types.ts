/**
 * Shared message and envelope types. These are the contracts the subsystems
 * exchange across the in-process event bus and the WebSocket transport. Field
 * shapes are taken verbatim from the interface requirements (IFC-*).
 */
import type { Role } from './constants.js';
import type { ReasonCode } from './errors.js';

/** ISO 8601 timestamp string. */
export type IsoTimestamp = string;

/** Outcome status used across executor and intent paths. (SUB-EXE-024) */
export type OutcomeStatus = 'SUCCESS' | 'FAILURE' | 'TIMEOUT' | 'DENIED';

/** Intent dispatch lifecycle status surfaced to a desklet. (SUB-INT-012) */
export type IntentStatus = 'SUCCESS' | 'FAILURE' | 'TIMEOUT' | 'DENIED' | 'SUPERSEDED' | 'UN_DISPATCHED';

/** A high-level intent dispatched by a desklet. */
export interface Intent {
  /** Monotonic, host-assigned identifier. */
  intentId: string;
  /** Correlation id supplied by the client to match acks. */
  correlationId: string;
  deskletId: string;
  role: Role;
  /** Intent verb, e.g. 'launch-tool', 'open-url', 'ssh-action', 'restore-layout'. */
  type: string;
  payload: Record<string, unknown>;
  /** Context object this intent targets, used for conflict serialisation. */
  targetContextObject?: string;
  receiptTimestamp: IsoTimestamp;
}

/** Envelope the Channel Multiplexer forwards to the Intent Router. (IFC-XPT-042) */
export interface IntentEnvelope {
  deskletId: string;
  role: Role;
  intentType: string;
  payload: Record<string, unknown>;
  correlationId: string;
  receiptTimestamp: IsoTimestamp;
}

/** Typed command the Intent Router hands to the Workspace Executor. (IFC-EXE-017, IFC-EXE-029) */
export interface CommandEnvelope {
  /** Action identifier, used for the PERMIT lookup. */
  actionId: string;
  /** Adapter routing key: '' or 'local' -> Process Supervisor; 'rag' -> RAG; other -> Adapter Framework. (SUB-EXE-026) */
  adapterId: string;
  /** Target process path for local execution. */
  targetPath: string;
  args: string[];
  /** Environment overrides (e.g. SSH_SESSION_ID, REMOTE_USER for 'rag'). */
  env: Record<string, string>;
  intentId: string;
  /** ACG-issued PERMIT the executor verifies before running. (SUB-EXE-021) */
  permitId?: string;
  /**
   * Fire-and-forget launch: resolve SUCCESS on spawn (don't wait for exit) and
   * skip the wall-clock kill, so GUI apps / browser launches persist. Used for
   * launch-tool / open-url style actions where the OS launcher returns slowly. */
  detached?: boolean;
  /**
   * Names of Credential Vault secrets this command needs. The Process Supervisor
   * resolves them at spawn into CR_SECRET_<NAME> env vars (and replaces
   * `{{secret:NAME}}` tokens in env/args), so plaintext never enters the envelope,
   * the action definition, logs, or any desklet projection. (SYS-REQ-001/005)
   */
  secretRefs?: string[];
}

/** Result of executing a command. (SUB-EXE-024, IFC-EXE-030) */
export interface CommandResult {
  intentId: string;
  status: OutcomeStatus;
  exitCode: number;
  /** SHA-256 hex digest of captured output. (SUB-EXE-023) */
  stdoutDigest: string;
  truncated: boolean;
  elapsedMs: number;
  reason?: ReasonCode;
}

/** CommandOutcome published to the Workspace Context Store bus. (IFC-EXE-018) */
export interface CommandOutcome {
  intentId: string;
  status: OutcomeStatus;
  exitCode: number;
  stdoutDigest: string;
  truncated: boolean;
  elapsedMs: number;
}

/** SSH action request crossing RAG -> Remote SSH Boundary. (IFC-RSB-052) */
export interface SshActionRequest {
  commandText: string;
  targetHostAlias: string;
  adapterIdentity: string;
  commandClass: 'bounded' | 'streaming';
  sshSessionId: string;
}

/** SSH result envelope emitted by the Result Emitter. (SUB-RAG-049) */
export interface SshResultEnvelope {
  status: 'permit' | 'deny' | 'error' | 'timeout' | 'locked';
  targetHost: string;
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  timestamp: IsoTimestamp;
  reason?: ReasonCode;
}

/** A single context object held in the authoritative registry. (SUB-CTX-030) */
export interface ContextObject {
  id: string;
  /** Attribute map; each attribute is tagged with the roles permitted to see it. */
  attributes: Record<string, ContextAttribute>;
  version: number;
}

export interface ContextAttribute {
  value: unknown;
  /** Roles permitted to receive this attribute. (SUB-SLM-005, SUB-CTX-031) */
  roles: Role[];
  /** Marked when the source integration is unavailable. (SUB-CTX-034) */
  stale?: boolean;
}

/** ContextUpdated event published on the WCS bus. (IFC-CTX-021) */
export interface ContextUpdated {
  contextObjectId: string;
  deltaFields: Record<string, unknown>;
  version: number;
  sourceIntentId?: string;
}

/** Role-scoped projection delivered to the transport for a desklet. (IFC-CTX-022, IFC-CTX-035) */
export interface RoleProjection {
  deskletId: string;
  role: Role;
  contextObjectId: string;
  deltaFields: Record<string, unknown>;
  version: number;
  /** SHA-256 of the full current attribute set for the role. (IFC-CTX-022) */
  digest: string;
  stale: boolean;
}

/** Pairing record persisted in the Device Identity Ledger. (SUB-PAIR-036) */
export interface PairingRecord {
  deviceId: string;
  fingerprint: string;
  role: Role;
  pairedAt: IsoTimestamp;
  lastSeen: IsoTimestamp;
}

/** An allowlist entry. (IFC-HAS-055) */
export interface AllowlistEntry {
  /** Adapter or gateway name the rule applies to. */
  adapter: string;
  /** Action / command pattern (glob or class id). */
  actionPattern: string;
  effect: 'allow' | 'deny';
  /** Optional stable rule id for deny responses. (IFC-RAG-025) */
  ruleId?: string;
}

/** WebSocket control/data frame envelope used on the desklet channel. */
export interface WsFrame {
  kind: 'context' | 'intent' | 'control' | 'ack' | 'error' | 'ping' | 'pong' | 'term';
  /** Sequence number for ordered context delivery. (IFC-XPT-041) */
  seq?: number;
  role?: Role;
  payload?: unknown;
  correlationId?: string;
  timestamp?: IsoTimestamp;
}
