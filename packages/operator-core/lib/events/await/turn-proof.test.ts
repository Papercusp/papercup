import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PICKUP_WINDOW_SEC,
  PICKUP_ESCALATION_SOURCE,
  TURN_PROOF_CONFIRMED,
  TURN_PROOF_STATES,
  hostRecoverableCondition,
  initialTurnProof,
  isTurnProof,
  judgeExpiredPickup,
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

describe('hostRecoverableCondition (D-004 (4): only what P-004/P-005 recover)', () => {
  it('names auth, quota and an unbound successor, auth first', () => {
    expect(hostRecoverableCondition({ authBlocked: true, quotaBlocked: true })).toBe('auth-blocked');
    expect(hostRecoverableCondition({ quotaBlocked: true })).toBe('quota-blocked');
    expect(hostRecoverableCondition({ latestBindingEvent: 'respawn-binding-unconfirmed' })).toBe('unbound-successor');
    expect(hostRecoverableCondition({ latestBindingEvent: 'respawn-carry-dropped' })).toBe('unbound-successor');
  });

  it('is null for a healthy host, a confirmed binding, or no host at all', () => {
    expect(hostRecoverableCondition({ authBlocked: false, quotaBlocked: false })).toBeNull();
    expect(hostRecoverableCondition({ latestBindingEvent: 'respawn-binding-confirmed' })).toBeNull();
    expect(hostRecoverableCondition(null)).toBeNull();
  });
});

describe('judgeExpiredPickup (P-006 slice 2)', () => {
  const DELIVERED = 1_000_000;
  const psu = { deliveredAtMs: DELIVERED, channel: 'psu-socket-inject', source: null };

  it('counts a host turn start AFTER delivery as observed', () => {
    const v = judgeExpiredPickup(psu, { execution: { phase: 'running', turnStartedAt: DELIVERED + 5_000 } });
    expect(v).toEqual({ proof: 'observed', turnStartedAtMs: DELIVERED + 5_000, via: 'host-turn-start' });
  });

  it('never counts a turn that started BEFORE (or at) delivery', () => {
    for (const t of [DELIVERED - 1, DELIVERED]) {
      const v = judgeExpiredPickup(psu, { execution: { phase: 'running', turnStartedAt: t } });
      expect(v.proof).toBe('not-picked-up');
    }
  });

  it('never counts a failed turn or a turn on a blocked host as a pickup', () => {
    // A codex child whose login cannot refresh starts a turn that fails at once.
    const failed = judgeExpiredPickup(psu, { execution: { phase: 'failed', turnStartedAt: DELIVERED + 1 } });
    expect(failed.proof).toBe('not-picked-up');
    const blocked = judgeExpiredPickup(psu, {
      authBlocked: true,
      execution: { phase: 'settled', turnStartedAt: DELIVERED + 1 },
    });
    expect(blocked).toMatchObject({ proof: 'not-picked-up', escalate: true, recoverable: 'auth-blocked' });
  });

  it('escalates a turn-starting channel once when the host reports a recoverable condition', () => {
    expect(judgeExpiredPickup(psu, { quotaBlocked: true })).toMatchObject({ escalate: true, recoverable: 'quota-blocked' });
    expect(judgeExpiredPickup(psu, { latestBindingEvent: 'respawn-binding-unconfirmed' })).toMatchObject({
      escalate: true,
      recoverable: 'unbound-successor',
    });
  });

  it('never escalates a re-queue again (bounded to ONE)', () => {
    const v = judgeExpiredPickup({ ...psu, source: PICKUP_ESCALATION_SOURCE }, { authBlocked: true });
    expect(v).toMatchObject({ proof: 'not-picked-up', escalate: false });
  });

  it('reports inbox and other non-turn channels without escalating (D-002)', () => {
    for (const channel of ['inbox', 'coalesced', null]) {
      const v = judgeExpiredPickup({ ...psu, channel }, { authBlocked: true });
      expect(v).toMatchObject({ proof: 'not-picked-up', escalate: false });
    }
  });

  it('every turn-burning channel is escalatable, so a new turn channel cannot be silently excluded', () => {
    for (const channel of WAKE_TURN_CHANNELS) {
      expect(judgeExpiredPickup({ ...psu, channel }, { authBlocked: true }).proof).toBe('not-picked-up');
      expect(judgeExpiredPickup({ ...psu, channel }, { authBlocked: true })).toMatchObject({ escalate: true });
    }
  });

  it('does not escalate without a live host or without a recoverable condition', () => {
    expect(judgeExpiredPickup(psu, null)).toMatchObject({ escalate: false, recoverable: null });
    expect(judgeExpiredPickup(psu, { execution: { phase: 'settled', turnStartedAt: DELIVERED - 10 } })).toMatchObject({
      escalate: false,
      recoverable: null,
    });
  });
});
