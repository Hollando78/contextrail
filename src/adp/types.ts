/**
 * Adapter manifest + registration types, and the embedded manifest JSON Schema.
 * Adapters are bounded by the host capability model at registration time
 * (STK-REQ-008, SYS-REQ-014).
 */
export type AdapterType = 'BASIC' | 'DEEP';

export interface AdapterManifest {
  id: string;
  type: AdapterType;
  /** Executable path (BASIC adapters); must live under the host adapter dir. */
  execPath?: string;
  /** Action classes/patterns this adapter is permitted to perform. */
  capabilityScope: string[];
  /** Working directory a BASIC local-script is confined to. (SUB-ADP-082) */
  workingDir?: string;
  /** Detached cryptographic signature (base64) over the manifest body. (SUB-ADP-081) */
  signature?: string;
  /** Key id in the host trust store used to verify the signature. */
  publicKeyId?: string;
}

export interface RegisteredAdapter extends AdapterManifest {
  registeredAt: string;
}

export const MANIFEST_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  additionalProperties: false,
  required: ['id', 'type', 'capabilityScope'],
  properties: {
    id: { type: 'string', minLength: 1, pattern: '^[a-zA-Z0-9._-]+$' },
    type: { enum: ['BASIC', 'DEEP'] },
    execPath: { type: 'string' },
    capabilityScope: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1 },
    workingDir: { type: 'string' },
    signature: { type: 'string' },
    publicKeyId: { type: 'string' },
  },
} as const;
