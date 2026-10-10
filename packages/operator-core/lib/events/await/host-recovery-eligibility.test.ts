/**
 * classifyStalledLoopHost — the stalled-loops guard's host verdict
 * (parked-agent-census-resumption-and-root-cause-2026-10-09 P-007).
 *
 * The verdict decides whether a turn-stalled loop is DISARMED or kept armed for the next wake's
 * child recycle. Its two inputs are shared with other callers on purpose:
 *   - the condition comes from turn-proof.ts `hostRecoverableCondition` (the P-006 pickup sweep);
 *   - wake-recoverability comes from `decideQuotaWakeRecovery` (the executor's inject-time gate).
 * So these tests pin the COMBINATION, not either half; each half has its own suite.
 */
import { describe, expect, it } from 'vitest';
import {
  AUTH_RECOVERY_MAX_PER_WINDOW,
  AUTH_RECOVERY_WINDOW_MS,
  classifyStalledLoopHost,
  type StalledLoopHostReading,
} from './host-recovery-eligibility';

const OWNER = 'su-stalled';
const NOW = 100 * AUTH_RECOVERY_WINDOW_MS;

type Host = NonNullable<StalledLoopHostReading['host']>;

/** A headless, agent-launched, recovery-capable host — the shape the executor will recycle. */
const recyclable: Host = {
  ownerId: OWNER,
  bridgeTty: false,
  launchedBy: 'su-leader',
  caps: ['quota-recovery', 'auth-recovery'],
};

const reading = (host: Host | null, events: unknown[] = []): StalledLoopHostReading => ({
  host,
  events: events as StalledLoopHostReading['events'],
});

const authRecoveryAt = (startedAtMs: number) => ({
  kind: 'quota-recovery-started',
  recoveryOwnerId: OWNER,
  cause: 'auth',
  startedAtMs,
});

describe('classifyStalledLoopHost (P-007)', () => {
  it('no live host → no-host (the pre-P-007 disarm applies unchanged)', () => {
    expect(classifyStalledLoopHost(reading(null), OWNER, NOW)).toEqual({ kind: 'no-host' });
  });

  it('a host reporting no wall → healthy, even with a confirmed binding in its tail', () => {
    expect(classifyStalledLoopHost(reading(recyclable), OWNER, NOW)).toEqual({ kind: 'healthy' });
    expect(
      classifyStalledLoopHost(
        reading(recyclable, [{ kind: 'respawn-binding-unconfirmed' }, { kind: 'respawn-binding-confirmed' }]),
        OWNER,
        NOW,
      ),
    ).toEqual({ kind: 'healthy' });
  });

  it('THE CASE: a dead provider login on a recyclable host → recoverable-on-wake, cause auth', () => {
    expect(classifyStalledLoopHost(reading({ ...recyclable, authBlocked: true }), OWNER, NOW)).toEqual({
      kind: 'recoverable-on-wake',
      condition: 'auth-blocked',
      cause: 'auth',
    });
  });

  it('a quota wall on a recyclable host → recoverable-on-wake, cause quota', () => {
    expect(classifyStalledLoopHost(reading({ ...recyclable, quotaBlocked: true }), OWNER, NOW)).toEqual({
      kind: 'recoverable-on-wake',
      condition: 'quota-blocked',
      cause: 'quota',
    });
  });

  it('auth outranks quota when both are reported', () => {
    expect(
      classifyStalledLoopHost(reading({ ...recyclable, authBlocked: true, quotaBlocked: true }), OWNER, NOW),
    ).toMatchObject({ kind: 'recoverable-on-wake', condition: 'auth-blocked', cause: 'auth' });
  });

  it('auth recoveries exhausted inside the window → needs-relaunch naming the dead SHARED login', () => {
    const events = Array.from({ length: AUTH_RECOVERY_MAX_PER_WINDOW }, (_, i) => authRecoveryAt(NOW - 1000 * (i + 1)));
    const verdict = classifyStalledLoopHost(reading({ ...recyclable, authBlocked: true }, events), OWNER, NOW);
    expect(verdict).toMatchObject({ kind: 'needs-relaunch', condition: 'auth-blocked' });
    expect(verdict.kind === 'needs-relaunch' && verdict.why).toContain('auth-recovery-exhausted');
    expect(verdict.kind === 'needs-relaunch' && verdict.remedy).toContain('re-authenticate');
  });

  it('auth recoveries OUTSIDE the window do not count against the bound', () => {
    const events = Array.from({ length: AUTH_RECOVERY_MAX_PER_WINDOW }, () =>
      authRecoveryAt(NOW - AUTH_RECOVERY_WINDOW_MS - 1),
    );
    expect(classifyStalledLoopHost(reading({ ...recyclable, authBlocked: true }, events), OWNER, NOW)).toMatchObject({
      kind: 'recoverable-on-wake',
    });
  });

  it('an interactive (bridged) host is never recycled → needs-relaunch with the owner-restart remedy', () => {
    const verdict = classifyStalledLoopHost(reading({ ...recyclable, authBlocked: true, bridgeTty: true }), OWNER, NOW);
    expect(verdict).toMatchObject({ kind: 'needs-relaunch', condition: 'auth-blocked' });
    expect(verdict.kind === 'needs-relaunch' && verdict.why).toContain('not-headless');
    expect(verdict.kind === 'needs-relaunch' && verdict.remedy).toContain('owner must restart');
  });

  it('a host that is not agent-launched, or lacks the capability, is not predicted recoverable', () => {
    expect(
      classifyStalledLoopHost(reading({ ...recyclable, authBlocked: true, launchedBy: null }), OWNER, NOW),
    ).toMatchObject({ kind: 'needs-relaunch', why: expect.stringContaining('not-agent-launched') });
    expect(
      classifyStalledLoopHost(reading({ ...recyclable, authBlocked: true, caps: ['quota-recovery'] }), OWNER, NOW),
    ).toMatchObject({ kind: 'needs-relaunch', why: expect.stringContaining('host-capability-missing') });
  });

  it('a discovery record naming another owner is never recycled for this one', () => {
    expect(
      classifyStalledLoopHost(reading({ ...recyclable, authBlocked: true, ownerId: 'su-other' }), OWNER, NOW),
    ).toMatchObject({ kind: 'needs-relaunch', why: expect.stringContaining('wrong-owner') });
  });

  it('an UNBOUND successor is never wake-recoverable, even on a fully recyclable host', () => {
    for (const kind of ['respawn-binding-unconfirmed', 'respawn-carry-dropped']) {
      const verdict = classifyStalledLoopHost(reading(recyclable, [{ kind: 'respawn-binding-confirmed' }, { kind }]), OWNER, NOW);
      expect(verdict).toMatchObject({ kind: 'needs-relaunch', condition: 'unbound-successor' });
      expect(verdict.kind === 'needs-relaunch' && verdict.why).toContain('deferred-successor-unbindable');
    }
  });

  it('every needs-relaunch verdict carries a non-empty remedy', () => {
    const shapes: Array<[Host, unknown[]]> = [
      [{ ...recyclable, authBlocked: true, bridgeTty: true }, []],
      [{ ...recyclable, quotaBlocked: true, launchedBy: null }, []],
      [{ ...recyclable, quotaBlocked: true, caps: [] }, []],
      [{ ...recyclable, authBlocked: true, ownerId: 'su-other' }, []],
      [recyclable, [{ kind: 'respawn-carry-dropped' }]],
    ];
    for (const [host, events] of shapes) {
      const verdict = classifyStalledLoopHost(reading(host, events), OWNER, NOW);
      expect(verdict.kind).toBe('needs-relaunch');
      expect(verdict.kind === 'needs-relaunch' && verdict.remedy.length).toBeGreaterThan(10);
    }
  });
});
