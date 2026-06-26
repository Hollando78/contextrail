/**
 * Touchpad mouse-op encoding (the pure half of the Mouse Control helper).
 */
import { describe, it, expect } from 'vitest';
import { encodeMouse } from '../src/has/mouse-control.js';

describe('encodeMouse', () => {
  it('encodes relative moves, truncating fractional deltas', () => {
    expect(encodeMouse({ op: 'move', dx: 3.7, dy: -2.9 })).toBe('M 3 -2');
  });
  it('drops a zero move', () => {
    expect(encodeMouse({ op: 'move', dx: 0, dy: 0 })).toBeNull();
  });
  it('encodes clicks by button', () => {
    expect(encodeMouse({ op: 'click' })).toBe('L');
    expect(encodeMouse({ op: 'click', button: 'right' })).toBe('R');
    expect(encodeMouse({ op: 'click', button: 'middle' })).toBe('Mi');
    expect(encodeMouse({ op: 'double' })).toBe('D');
  });
  it('encodes button hold/release for drags', () => {
    expect(encodeMouse({ op: 'down' })).toBe('LD');
    expect(encodeMouse({ op: 'up' })).toBe('LU');
    expect(encodeMouse({ op: 'down', button: 'right' })).toBe('RD');
  });
  it('encodes scroll, dropping zero', () => {
    expect(encodeMouse({ op: 'scroll', dy: 120 })).toBe('S 120');
    expect(encodeMouse({ op: 'scroll', dy: -40 })).toBe('S -40');
    expect(encodeMouse({ op: 'scroll', dy: 0 })).toBeNull();
  });
});
