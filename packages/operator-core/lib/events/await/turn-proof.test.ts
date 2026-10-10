import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PICKUP_WINDOW_SEC,
  TURN_PROOF_CONFIRMED,
  TURN_PROOF_STATES,
  initialTurnProof,
  isTurnProof,
  pickupWindowSec,
} from './turn-proof';
import { WAKE_TURN_CHANNELS } from './types';

describe('initialTurnProof (P-006/D-004)', () => {
  it('trusts only the executor attestation as proof at booking time', () => {
    expect(initialTurnProof('psu-socket-inject', 'host-attested')).toBe('host-attested');
    expect(initialTurnProof('psu-socket-recycle', 'host-attested')).toBe('host-attested');
  });

  it('books the inbox fallback as awaiting, never as a started turn', () => {
    // The peer-reported defect: degradeToInboxOrDrop returns delivered/inbox, which read back
    // as a clean success although no turn ran.
    expect(initialTurnProof('inbox', undefined)).toBe('awaiting');
  });

  it('books every unattested turn-burning channel as awaiting', () => {
    for (const channel of WAKE_TURN_CHANNELS) {
      expect(initialTurnProof(channel, undefined)).toBe('awaiting');
    }
  });

  it('books content that rides another delivery as superseded, not as a missed pickup', () => {
    expect(initialTurnProof('coalesced', undefined)).toBe('superseded');
    expect(initialTurnProof('suppressed-redundant', undefined)).toBe('superseded');
  });

  it('never yields a state outside the migration 1441 CHECK set', () => {
    for (const channel of [...WAKE_TURN_CHANNELS, 'inbox', 'coalesced', 'suppressed-redundant']) {
      for (const attested of [undefined, 'host-attested'] as const) {
        expect(TURN_PROOF_STATES).toContain(initialTurnProof(channel, attested));
      }
    }
  });
});

describe('turn-proof states', () => {
  it('counts only host-attested and observed as pickup', () => {
    expect([...TURN_PROOF_CONFIRMED].sort()).toEqual(['host-attested', 'observed']);
    expect(TURN_PROOF_CONFIRMED.has('awaiting')).toBe(false);
    expect(TURN_PROOF_CONFIRMED.has('superseded')).toBe(false);
    expect(TURN_PROOF_CONFIRMED.has('not-picked-up')).toBe(false);
  });

  it('recognises exactly the declared states', () => {
    for (const s of TURN_PROOF_STATES) expect(isTurnProof(s)).toBe(true);
    expect(isTurnProof('delivered')).toBe(false);
    expect(isTurnProof(null)).toBe(false);
  });
});

describe('pickupWindowSec', () => {
  it('defaults to the measured 600s window', () => {
    expect(pickupWindowSec({})).toBe(DEFAULT_PICKUP_WINDOW_SEC);
    expect(DEFAULT_PICKUP_WINDOW_SEC).toBe(600);
  });

  it('honours a valid override and clamps it to [30s, 24h]', () => {
    expect(pickupWindowSec({ PAPERCUSP_WAKE_PICKUP_WINDOW_SEC: '120' })).toBe(120);
    expect(pickupWindowSec({ PAPERCUSP_WAKE_PICKUP_WINDOW_SEC: '5' })).toBe(30);
    expect(pickupWindowSec({ PAPERCUSP_WAKE_PICKUP_WINDOW_SEC: '999999' })).toBe(86_400);
  });

  it('falls back to the default on an unparsable or non-positive value', () => {
    expect(pickupWindowSec({ PAPERCUSP_WAKE_PICKUP_WINDOW_SEC: 'soon' })).toBe(600);
    expect(pickupWindowSec({ PAPERCUSP_WAKE_PICKUP_WINDOW_SEC: '0' })).toBe(600);
    expect(pickupWindowSec({ PAPERCUSP_WAKE_PICKUP_WINDOW_SEC: '  ' })).toBe(600);
  });
});
