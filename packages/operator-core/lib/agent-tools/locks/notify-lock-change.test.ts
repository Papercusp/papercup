/**
 * P-025 / D-042 — the plan-lock push half, and the regression it exists to
 * prevent.
 *
 * ┌ WHAT MAKES THIS TEST NON-OBVIOUS ─────────────────────────────────────────┐
 * │ A test that asserts "an invalidation is emitted" PASSES while the bug      │
 * │ ships. The defect is not a missing first event — it is the SECOND event on │
 * │ the same (name, args) key being silently dropped by the bus's 90s          │
 * │ first-wins dedupe. So the assertions below are all about the second one.   │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * A plan lock is routinely acquired and released well inside 90s. Both emits
 * carry the SAME key, so on the bus default the RELEASE is discarded — and
 * P-025 deletes the 30s poll that used to paper over it, so nothing corrects
 * the banner afterwards.
 *
 * The `acquire → release` cases therefore replay the module's REAL emitted
 * arguments through a REAL `createInvalidationBus` configured with the REAL
 * 90s production default, rather than asserting against a mock. Each is paired
 * with a CONTROL that omits only the per-call override and must FAIL to
 * deliver — without that control, both tests would still pass if the override
 * silently stopped working.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createInvalidationBus,
  type ListenSource,
  type NotifySink,
} from '@papercusp/sync/server';

const calls: Array<{
  name: string;
  args?: Record<string, unknown>;
  data?: unknown[];
  opts?: { dedupeWindowMs?: number };
}> = [];

vi.mock('../../sync-sse', () => ({
  notifySyncInvalidate: async (
    name: string,
    args?: Record<string, unknown>,
    data?: unknown[],
    opts?: { dedupeWindowMs?: number },
  ) => {
    calls.push({ name, args, data, opts });
  },
}));

import {
  isPlanLockPath,
  notifyPlanLockChange,
  PLAN_LOCK_QUERY,
  PLAN_LOCK_DEDUPE_MS,
} from './notify-lock-change';

/** The production default the operator inherits (sync-sse passes no override). */
const PRODUCTION_DEDUPE_MS = 90_000;

const PLAN_A = 'apps/operator/docs/plans/my-plan.md';
const PLAN_B = 'apps/operator/docs/plans/archive/old-plan.md';

/** Single-process loopback, mirroring the bus's own test harness. */
function makeLoopback() {
  let onMsg: ((raw: string) => void) | null = null;
  const delivered: string[] = [];
  const listen: ListenSource = {
    start(cb) {
      onMsg = cb;
    },
  };
  const notify: NotifySink = {
    async notify(json) {
      delivered.push(json);
      onMsg?.(json);
    },
  };
  return { listen, notify, delivered };
}

/** Let the fire-and-forget dynamic-import chain settle. */
async function settle() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  calls.length = 0;
});

describe('isPlanLockPath', () => {
  it('accepts plan paths, including archived ones', () => {
    expect(isPlanLockPath(PLAN_A)).toBe(true);
    expect(isPlanLockPath(PLAN_B)).toBe(true);
  });

  it('rejects non-plan file locks — the fleet-wide volume guard', () => {
    // file-lock-guard wraps EVERY agent file edit. If these leaked through at a
    // 1s window we would re-create the WI-840 fan-out storm the bus default was
    // written to suppress.
    expect(isPlanLockPath('packages/operator-core/lib/foo.ts')).toBe(false);
    expect(isPlanLockPath('apps/operator/docs/design/x.md')).toBe(false);
    expect(isPlanLockPath('README.md')).toBe(false);
  });

  it('rejects a non-markdown file inside the plans dir', () => {
    expect(isPlanLockPath('apps/operator/docs/plans/notes.txt')).toBe(false);
  });
});

describe('notifyPlanLockChange', () => {
  it('emits once per distinct plan path, scoped by a single scalar arg', async () => {
    notifyPlanLockChange([PLAN_A, PLAN_A, 'packages/operator-core/lib/foo.ts']);
    await settle();

    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe(PLAN_LOCK_QUERY);
    // D-038: the dedupe key is `name|args|dataHash`, so a SINGLE scalar path is
    // what gives each plan its own bucket. A wider args object would merge them.
    expect(calls[0].args).toEqual({ path: PLAN_A });
  });

  it('emits nothing at all when no plan path is involved', async () => {
    notifyPlanLockChange(['packages/operator-core/lib/foo.ts', 'README.md']);
    await settle();
    expect(calls).toHaveLength(0);
  });

  it('passes a per-call dedupe window well under the 90s production default', async () => {
    notifyPlanLockChange([PLAN_A]);
    await settle();
    expect(calls[0].opts?.dedupeWindowMs).toBe(PLAN_LOCK_DEDUPE_MS);
    expect(PLAN_LOCK_DEDUPE_MS).toBeLessThan(PRODUCTION_DEDUPE_MS);
  });

  it('acquire→release inside 90s BOTH reach the bus (the actual regression)', async () => {
    notifyPlanLockChange([PLAN_A]); // acquire
    await settle();
    notifyPlanLockChange([PLAN_A]); // release, seconds later
    await settle();
    expect(calls).toHaveLength(2);

    // Replay the module's REAL arguments through a REAL bus at the REAL
    // production window. Both must fan out, or the banner freezes on a lock
    // that no longer exists.
    const clock = { t: 1_000 };
    const lb = makeLoopback();
    const bus = createInvalidationBus({
      listen: lb.listen,
      notify: lb.notify,
      now: () => clock.t,
      dedupeWindowMs: PRODUCTION_DEDUPE_MS,
    });
    await bus.subscribe(() => {});

    await bus.notifyInvalidate(calls[0].name, calls[0].args, undefined, calls[0].opts);
    clock.t += 5_000; // a realistic acquire→release gap
    await bus.notifyInvalidate(calls[1].name, calls[1].args, undefined, calls[1].opts);

    expect(lb.delivered).toHaveLength(2);
  });

  it('CONTROL: the same pair WITHOUT the override loses the release', async () => {
    // Calibration. If this ever delivers 2, the override is no longer what is
    // carrying the test above and the guard has quietly stopped guarding.
    const clock = { t: 1_000 };
    const lb = makeLoopback();
    const bus = createInvalidationBus({
      listen: lb.listen,
      notify: lb.notify,
      now: () => clock.t,
      dedupeWindowMs: PRODUCTION_DEDUPE_MS,
    });
    await bus.subscribe(() => {});

    await bus.notifyInvalidate(PLAN_LOCK_QUERY, { path: PLAN_A });
    clock.t += 5_000;
    await bus.notifyInvalidate(PLAN_LOCK_QUERY, { path: PLAN_A });

    expect(lb.delivered).toHaveLength(1);
  });

  it('two different plans never share a dedupe bucket', async () => {
    const clock = { t: 1_000 };
    const lb = makeLoopback();
    const bus = createInvalidationBus({
      listen: lb.listen,
      notify: lb.notify,
      now: () => clock.t,
      dedupeWindowMs: PRODUCTION_DEDUPE_MS,
    });
    await bus.subscribe(() => {});

    await bus.notifyInvalidate(PLAN_LOCK_QUERY, { path: PLAN_A });
    await bus.notifyInvalidate(PLAN_LOCK_QUERY, { path: PLAN_B });

    expect(lb.delivered).toHaveLength(2);
  });
});
