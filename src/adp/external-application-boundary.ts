/**
 * External Application Boundary (EAB).
 *
 * Mediates BASIC adapter actions against external applications/OS tools. Local
 * callback dispatch is restricted to RFC 1918 private address space; a target
 * resolving to a non-local address fails without dispatch. (SUB-EAB-066,
 * IFC-EAB-055)
 */
import { isIP } from 'node:net';
import type { Logger } from '../core/logger.js';

/** True for RFC 1918 / loopback IPv4 (the only callback targets allowed). */
export function isLocalAddress(host: string): boolean {
  if (host === 'localhost') return true;
  if (isIP(host) !== 4) return false;
  const p = host.split('.').map(Number) as [number, number, number, number];
  if (p[0] === 127) return true; // loopback
  if (p[0] === 10) return true; // 10.0.0.0/8
  if (p[0] === 192 && p[1] === 168) return true; // 192.168.0.0/16
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true; // 172.16.0.0/12
  return false;
}

export class ExternalApplicationBoundary {
  constructor(private readonly log: Logger) {}

  /** Guard a BASIC adapter callback URL: refuse anything not on the local network. */
  assertLocalCallback(url: string): void {
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      throw new Error('invalid callback URL');
    }
    if (!isLocalAddress(host)) {
      this.log.error('blocked non-local BASIC adapter callback', { url, host });
      throw new Error('callback target is not on the local network (RFC 1918 only)');
    }
  }
}
