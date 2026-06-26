/**
 * Pairing Token Generator — single-use OTTs with a bounded ring so a console QR
 * refresh doesn't invalidate a code a phone just scanned. (SUB-PAIR-035)
 */
import { describe, it, expect } from 'vitest';
import { createLogger } from '../src/core/logger.js';
import { PairingTokenGenerator } from '../src/pair/pairing-token-generator.js';
import { TOKENS } from '../src/core/constants.js';

const log = createLogger('test');

describe('PairingTokenGenerator', () => {
  it('issues and consumes a token, returning its bound role', () => {
    const g = new PairingTokenGenerator(log);
    const { ott } = g.issue('Status');
    expect(g.consume(ott)).toBe('Status');
  });

  it('is single-use: a token cannot be consumed twice', () => {
    const g = new PairingTokenGenerator(log);
    const { ott } = g.issue('Actions');
    expect(g.consume(ott)).toBe('Actions');
    expect(g.consume(ott)).toBeNull();
  });

  it('keeps an earlier token valid after a newer one is issued (QR-refresh race)', () => {
    const g = new PairingTokenGenerator(log);
    const a = g.issue('Status'); // what the phone scanned
    g.issue('Status'); // console auto-refresh mints a newer one
    expect(g.consume(a.ott)).toBe('Status'); // the scanned token still pairs
  });

  it('rejects an expired token', () => {
    let t = 1000;
    const g = new PairingTokenGenerator(log, () => t);
    const { ott } = g.issue('Logs');
    t += TOKENS.QR_TOKEN_TTL_MS + 1;
    expect(g.consume(ott)).toBeNull();
  });

  it('rejects an unknown token', () => {
    const g = new PairingTokenGenerator(log);
    expect(g.consume('nope')).toBeNull();
  });

  it('bounds the ring, dropping the oldest beyond the cap', () => {
    const g = new PairingTokenGenerator(log);
    const first = g.issue('Status');
    for (let i = 0; i < 8; i++) g.issue('Status'); // push first out of the 8-slot ring
    expect(g.consume(first.ott)).toBeNull();
  });
});
