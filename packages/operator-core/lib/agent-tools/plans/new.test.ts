/**
 * plans:new — idempotent-completion opt-in regression (EI-11507).
 *
 * A plans:new whose wall-clock beat the 55s transport deadline STILL COMMITTED the plan
 * (the slug write runs inside withPlanLock, synchronously before the handler returns) — and
 * a genuine retry is safe (the plan lock's slug uniqueness makes a re-create a `slug_exists`
 * no-op, never a duplicate plan). Declaring `idempotent: true` opts the tool into the dispatch
 * abort-race branch (libs/generic/tooldef dispatch-stack.ts) that surfaces the TRUTHFUL success
 * instead of a spurious `timeout`, so the caller stops the forced verify-read. The abort-race
 * branch itself is exercised in dispatch-projected.test.ts; this pins the missing link — that
 * THIS mutation tool declares the flag, mirroring plans:set-status's own W6/P-007 remediation.
 */

import { describe, it, expect } from 'vitest';
import newPlan from './new';

describe('plans:new idempotent-completion opt-in (EI-11507)', () => {
  it('declares idempotent:true so a committed-but-slow create surfaces success, not a false timeout', () => {
    expect((newPlan as { idempotent?: boolean }).idempotent).toBe(true);
  });
});

describe('plans:new initial lifecycle status', () => {
  const base = { harness: 'papercusp', slug: 'initial-status-plan', title: 'Initial Status Plan' };

  it('accepts non-terminal initial statuses', () => {
    expect(newPlan.args.safeParse({ ...base, status: 'active' }).success).toBe(true);
  });

  it.each(['shipped', 'superseded'])('rejects terminal initial status %s', (status) => {
    expect(newPlan.args.safeParse({ ...base, status }).success).toBe(false);
  });
});
