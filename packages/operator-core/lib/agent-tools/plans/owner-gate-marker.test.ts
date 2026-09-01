import { describe, expect, it } from 'vitest';
import {
  findAnchoredOwnerGateMarker,
  findOwnerGateMarker,
} from './owner-gate-marker';

describe('owner-gate marker extraction', () => {
  it('recognizes an owner-gated marker in an anchored parenthesized clause', () => {
    expect(findAnchoredOwnerGateMarker('(owner-gated: wait for owner)')).toBe('owner-gated');
  });

  it('recognizes bracketed markers without constructing an invalid regex', () => {
    expect(findAnchoredOwnerGateMarker('[owner-gated] decision required')).toBe('owner-gated');
  });

  it('does not treat a negated free-text mention as an owner gate', () => {
    expect(findOwnerGateMarker('This item is non-owner-gated and may auto-flip.')).toBeNull();
  });
});
