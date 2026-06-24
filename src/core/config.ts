/**
 * Host configuration shape + embedded JSON Schema validation.
 *
 * The Configuration Loader validates the config file against this schema at
 * startup and halts boot with a structured error identifying the failing schema
 * path on any violation. (SUB-HCR-020, IFC-HCR-016)
 */
import { readFile } from 'node:fs/promises';
import AjvDefault, { type ErrorObject } from 'ajv';
import addFormatsDefault from 'ajv-formats';
import { ContextRailError } from './errors.js';

// ajv / ajv-formats are CJS with a default export; NodeNext types the default
// import as the module namespace, so cast back to the real constructor/function.
// The runtime value is already correct (ajv sets `module.exports = Ajv`).
const Ajv = AjvDefault as unknown as typeof import('ajv').default;
const addFormats = addFormatsDefault as unknown as typeof import('ajv-formats').default;

export interface HostConfig {
  host: string;
  port: number;
  /** Loopback port for the /health endpoint and /pair. (IFC-XPT-020, IFC-PAIR-027) */
  loopbackPort: number;
  dataDir: string;
  /** Directory tree adapters' executables must live under. (SUB-ADP-028) */
  adapterDir: string;
  /** Path to the BASIC/DEEP adapter manifests. */
  manifestDir: string;
  /** Consecutive-FAILURE threshold before an executor circuit opens. (SUB-INT-015) */
  failureCircuitThreshold: number;
  ssh: {
    /** Path to the operator's existing SSH config. (SUB-RAG-047) */
    configPath: string;
    knownHostsPath: string;
  };
  tls: {
    /** Common name for the generated self-signed certificate. (SUB-XPT-039) */
    commonName: string;
  };
}

export const CONFIG_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  additionalProperties: false,
  required: ['host', 'port', 'loopbackPort', 'dataDir', 'adapterDir', 'manifestDir', 'ssh', 'tls'],
  properties: {
    host: { type: 'string', minLength: 1 },
    port: { type: 'integer', minimum: 1, maximum: 65535 },
    loopbackPort: { type: 'integer', minimum: 1, maximum: 65535 },
    dataDir: { type: 'string', minLength: 1 },
    adapterDir: { type: 'string', minLength: 1 },
    manifestDir: { type: 'string', minLength: 1 },
    failureCircuitThreshold: { type: 'integer', minimum: 1, default: 5 },
    ssh: {
      type: 'object',
      additionalProperties: false,
      required: ['configPath', 'knownHostsPath'],
      properties: {
        configPath: { type: 'string' },
        knownHostsPath: { type: 'string' },
      },
    },
    tls: {
      type: 'object',
      additionalProperties: false,
      required: ['commonName'],
      properties: {
        commonName: { type: 'string', minLength: 1 },
      },
    },
  },
} as const;

export const DEFAULT_CONFIG: HostConfig = {
  host: '0.0.0.0',
  port: 8787,
  loopbackPort: 8788,
  dataDir: './data',
  adapterDir: './adapters',
  manifestDir: './adapters/manifests',
  failureCircuitThreshold: 5,
  ssh: {
    configPath: '~/.ssh/config',
    knownHostsPath: '~/.ssh/known_hosts',
  },
  tls: {
    commonName: 'contextrail.local',
  },
};

function formatErrors(errors: ErrorObject[] | null | undefined): string {
  if (!errors?.length) return 'unknown validation error';
  return errors
    .map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`.trim())
    .join('; ');
}

/** Validate a candidate config object, applying defaults. Throws SCHEMA_INVALID. */
export function validateConfig(candidate: unknown): HostConfig {
  const ajv = new Ajv({ allErrors: true, useDefaults: true, coerceTypes: false });
  addFormats(ajv);
  const validate = ajv.compile(CONFIG_SCHEMA);
  const merged = { ...DEFAULT_CONFIG, ...(candidate as object) };
  if (!validate(merged)) {
    throw new ContextRailError('SCHEMA_INVALID', 'config failed schema validation', {
      errors: formatErrors(validate.errors),
      failingPath: validate.errors?.[0]?.instancePath ?? '/',
    });
  }
  return merged as HostConfig;
}

/** Load + validate the config file. (SUB-HCR-020) */
export async function loadConfig(path: string | undefined): Promise<HostConfig> {
  if (!path) return validateConfig({});
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    throw new ContextRailError('SCHEMA_INVALID', `config file not readable: ${path}`, {
      cause: (err as Error).message,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ContextRailError('SCHEMA_INVALID', `config file is not valid JSON: ${path}`, {
      cause: (err as Error).message,
    });
  }
  return validateConfig(parsed);
}
