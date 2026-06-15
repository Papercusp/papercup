/**
 * plan-clobber-notify — P-007 user-facing plan clobber notice.
 *
 * Pure mapping (planClobberNotice) + the idempotent listener registration. Drives
 * synthetic clobber events through the singleton emitter; no PG / coord / I/O.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clobberEvents, _resetForTests, type ClobberEvent } from '../clobber-events';
import {
  planClobberNotice,
  registerPlanClobberNotifier,
  _resetPlanClobberNotifierForTests,
} from '../plan-clobber-notify';

function clobber(over: Partial<ClobberEvent> = {}): ClobberEvent {
  return {
    table: 'plans-by-slug',
    hbKey: 'shared-hive-collaboration-2026-06-14',
    my: { table: 'plans-by-slug', hbKey: 'shared-hive-collaboration-2026-06-14', ts: 1000, pubkey: 'localdevicekeyhex' },
    theirs: { table: 'plans-by-slug', hbKey: 'shared-hive-collaboration-2026-06-14', ts: 2000, pubkey: 'remotepeerkeyhex' },
    observedAt: 2000,
    ...over,
  };
}

beforeEach(() => {
  _resetForTests();
});
afterEach(() => {
  _resetPlanClobberNotifierForTests();
  _resetForTests();
});

describe('planClobberNotice (pure)', () => {
  it('maps a plan clobber to a user notice naming the plan + the winning contributor', () => {
    const notice = planClobberNotice(clobber());
    expect(notice).not.toBeNull();
    expect(notice!.planSlug).toBe('shared-hive-collaboration-2026-06-14');
    expect(notice!.byPubkey).toBe('remotepeerkeyhex');
    expect(notice!.summary).toContain('shared-hive-collaboration-2026-06-14');
    expect(notice!.summary.toLowerCase()).toContain('raced');
    // Body explains the loss + the recovery action, and shows the short remote key.
    expect(notice!.body).toContain('overridden');
    expect(notice!.body).toContain('remotepe'); // shortPubkey(8)
    expect(notice!.body.toLowerCase()).toContain('re-apply');
  });

  it('ignores a non-plan clobber (e.g. the queue table has its own surface)', () => {
    expect(planClobberNotice(clobber({ table: 'queue' }))).toBeNull();
  });

  it('ignores a plan clobber with no hbKey', () => {
    expect(planClobberNotice(clobber({ hbKey: '' }))).toBeNull();
  });
});

describe('registerPlanClobberNotifier', () => {
  it('notifies once per plan clobber, and not for non-plan clobbers', () => {
    const notify = vi.fn();
    registerPlanClobberNotifier(notify);

    clobberEvents.emit('clobber', clobber());
    clobberEvents.emit('clobber', clobber({ table: 'working-set' }));

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0].planSlug).toBe('shared-hive-collaboration-2026-06-14');
  });

  it('is idempotent — a second registration does not double-fire', () => {
    const notify = vi.fn();
    registerPlanClobberNotifier(notify);
    registerPlanClobberNotifier(notify); // second boot in the same process

    clobberEvents.emit('clobber', clobber());
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('a notify throw never escapes into the emitter', () => {
    registerPlanClobberNotifier(() => {
      throw new Error('notify boom');
    });
    expect(() => clobberEvents.emit('clobber', clobber())).not.toThrow();
  });
});
