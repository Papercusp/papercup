/**
 * Tests for P-010's delivery half — the formatter and the sweep orchestration,
 * both without a database (the sweep's PG read is an injected seam).
 *
 * The behaviours that actually matter here are the ORDERINGS: agent before
 * leader, leader only on a repeat, and nothing at all delivered from a leg that
 * could not run. Each of those is a rule from the plan, not an implementation
 * detail, so each gets its own test.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  divergenceSweep,
  divergenceFireKey,
  formatDivergenceAlert,
  DIVERGENCE_REPEAT_LOOKBACK_HOURS,
  DIVERGENCE_DEBOUNCE_HOURS,
} from './agent-state-divergence-sweep';
import { RETRY_THRASH_THRESHOLD, type Divergence, type DivergenceCall } from './agent-state-divergence';

const T0 = Date.parse('2026-07-27T12:00:00.000Z');

/** A flail that the real detector will find: N same-tool failures, close together. */
function flailCalls(n = RETRY_THRASH_THRESHOLD, ownerId = 'su-a'): DivergenceCall[] {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    ownerId,
    toolName: 'work_items:claim',
    status: 'invalid-input',
    invokedAt: new Date(T0 + i * 1000).toISOString(),
    args: { a: i },
  }));
}

/** Stub deps; every test overrides only what it is about. */
function deps(over: Parameters<typeof divergenceSweep>[0] = {}) {
  return {
    loadRecentCalls: vi.fn(async () => flailCalls()),
    recentWatchdogFires: vi.fn(async () => 0),
    // Won the debounce slot. `claimWatchdogFire` replaced the old
    // recentWatchdogFires-then-recordFire pair, which was both racy and — because
    // the recorded reason never contained the scope key — a debounce that could
    // never match (EI-18824142520274965).
    claimWatchdogFire: vi.fn(async () => true),
    openEscalation: vi.fn(async () => undefined),
    sendMessage: vi.fn(async () => undefined),
    // Comfortably past CONVERGENCE_SETTLE_MS from the flail's last failure, so
    // these delivery-ordering tests exercise delivery rather than the settle
    // rule (which has its own tests below).
    now: T0 + 10 * 60_000,
    ...over,
  } as unknown as Parameters<typeof divergenceSweep>[0] & Record<string, ReturnType<typeof vi.fn>>;
}

describe('formatDivergenceAlert', () => {
  const loop: Divergence = {
    kind: 'unconverged-retry-loop',
    ownerId: 'su-a',
    intentEventId: null,
    detail: 'work_items:claim failed 4× within 10min (invalid-input) without converging',
    a: { callId: 1, toolName: 'work_items:claim', status: 'invalid-input', invokedAt: 'T1', goalRef: null },
    b: { callId: 4, toolName: 'work_items:claim', status: 'invalid-input', invokedAt: 'T4', goalRef: null },
    retryLoop: {
      attempts: 4,
      argsChangedTransitions: 1,
      identicalRetries: 2,
      fallbackObserved: true,
      statuses: ['invalid-input'],
    },
  };

  it('addresses the agent in the second person and leads with evidence', () => {
    const { summary, body } = formatDivergenceAlert(loop);
    expect(summary).toContain('You called work_items:claim 4×');
    expect(body).toContain('call 1');
    expect(body).toContain('call 4');
  });

  it('names identical retries explicitly — they cannot succeed', () => {
    expect(formatDivergenceAlert(loop).body).toContain('BYTE-IDENTICAL');
  });

  it('says the threshold was measured, so it does not read as an accusation', () => {
    const body = formatDivergenceAlert(loop).body;
    expect(body).toContain('measured');
    expect(body).toContain('not an accusation');
  });

  it('formats the stamped goal-drift kind differently', () => {
    const { summary } = formatDivergenceAlert({
      kind: 'goal-drift-within-intent',
      ownerId: 'su-a',
      intentEventId: 77,
      detail: 'one intent declaration spans goals WI-1 and WI-2',
      a: { callId: 1, toolName: 't', status: 'ok', invokedAt: 'T1', goalRef: 'WI-1' },
      b: { callId: 2, toolName: 't', status: 'ok', invokedAt: 'T2', goalRef: 'WI-2' },
    });
    expect(summary).toContain('WI-1');
    expect(summary).toContain('WI-2');
  });
});

describe('divergenceFireKey', () => {
  it('keys a retry loop per (owner, tool) so two flails page independently', () => {
    const base = {
      kind: 'unconverged-retry-loop' as const,
      ownerId: 'su-a',
      intentEventId: null,
      detail: '',
      b: { callId: 2, toolName: 'x', status: null, invokedAt: '', goalRef: null },
    };
    const k1 = divergenceFireKey({
      ...base,
      a: { callId: 1, toolName: 'work_items:claim', status: null, invokedAt: '', goalRef: null },
    });
    const k2 = divergenceFireKey({
      ...base,
      a: { callId: 1, toolName: 'plans:get', status: null, invokedAt: '', goalRef: null },
    });
    expect(k1).not.toBe(k2);
    expect(k1).toContain('su-a');
  });
});

describe('divergenceSweep — the delivery orderings', () => {
  it('notifies THE AGENT ITSELF and does not escalate on first sight', async () => {
    const d = deps();
    const out = await divergenceSweep(d);
    expect(d.sendMessage).toHaveBeenCalledTimes(1);
    expect(d.openEscalation).not.toHaveBeenCalled();
    expect(out.outcomes[0].outcome).toBe('notified');
    // Addressed to the agent, not broadcast.
    const [, opts] = (d.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(opts.to).toEqual(['su-a']);
  });

  it('escalates to the leader ONLY on a repeat, and still tells the agent', async () => {
    // Nothing inside the debounce window, but something inside the repeat window.
    const recentWatchdogFires = vi.fn(async (_ws, _slug, hours: number) =>
      hours === DIVERGENCE_REPEAT_LOOKBACK_HOURS ? 1 : 0,
    );
    const d = deps({ recentWatchdogFires } as never);
    const out = await divergenceSweep(d);
    expect(d.sendMessage).toHaveBeenCalledTimes(1);
    expect(d.openEscalation).toHaveBeenCalledTimes(1);
    expect(out.outcomes[0].outcome).toBe('escalated');
    const [, esc] = (d.openEscalation as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(esc.summary).toContain('REPEAT');
  });

  it('debounces when the fire slot is already claimed — no message, no escalation', async () => {
    const d = deps({ claimWatchdogFire: vi.fn(async () => false) } as never);
    const out = await divergenceSweep(d);
    expect(d.sendMessage).not.toHaveBeenCalled();
    expect(d.openEscalation).not.toHaveBeenCalled();
    expect(out.outcomes[0].outcome).toBe('debounced');
  });

  it('claims the fire BEFORE notifying, so a crash cannot re-page forever', async () => {
    const d = deps();
    await divergenceSweep(d);
    const fireOrder = (d.claimWatchdogFire as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    const sendOrder = (d.sendMessage as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    expect(fireOrder).toBeLessThan(sendOrder);
  });

  // ── EI-18824142520274965: the debounce that could never match ──────────────
  //
  // The regression that produced 113 fires across 2 conditions in 37 minutes.
  // `claimWatchdogFire`/`recentWatchdogFires` resolve a `scopeKey` as
  // `reason LIKE '%scopeKey%'`, so recording the bare summary — which never
  // contains `<ownerId>:<toolName>` — left the debounce structurally unable to
  // find its own prior fires. Asserting on the RECORDED REASON is what pins it:
  // a test that only checked "was it called" passed throughout the outage.
  it('records the fire under a reason CONTAINING the scope key, or the debounce cannot match', async () => {
    const d = deps();
    await divergenceSweep(d);
    const [claim] = (d.claimWatchdogFire as ReturnType<typeof vi.fn>).mock.calls[0];
    const key = `su-a:work_items:claim`;
    expect(claim.scopeKey).toBe(key);
    expect(claim.reason).toContain(key);
    expect(claim.windowHours).toBe(DIVERGENCE_DEBOUNCE_HOURS);
  });

  it('reads isRepeat BEFORE claiming, so its own fire cannot pin it to true', async () => {
    const d = deps();
    await divergenceSweep(d);
    const repeatRead = (d.recentWatchdogFires as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    const claim = (d.claimWatchdogFire as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    expect(repeatRead).toBeLessThan(claim);
  });
});

describe('divergenceSweep — what it refuses to deliver', () => {
  it('suppresses a clean window and says WHICH zero it was', async () => {
    const d = deps({ loadRecentCalls: vi.fn(async () => []) } as never);
    const out = await divergenceSweep(d);
    expect(d.sendMessage).not.toHaveBeenCalled();
    expect(out.outcomes[0].outcome).toBe('suppressed');
    expect(out.outcomes[0].reason).toContain('STRUCTURAL ZERO');
  });

  it('carries the coverage out so a caller can log the stamp fill rate', async () => {
    const out = await divergenceSweep(deps());
    expect(out.report?.coverage.stampFillRate).toBe(0);
    expect(out.report?.coverage.failuresSeen).toBe(RETRY_THRASH_THRESHOLD);
  });

  it('is fail-soft when the PG read throws', async () => {
    const d = deps({
      loadRecentCalls: vi.fn(async () => {
        throw new Error('pg down');
      }),
    } as never);
    const out = await divergenceSweep(d);
    expect(out.outcomes[0].outcome).toBe('error');
    expect(out.outcomes[0].reason).toContain('pg down');
    expect(out.report).toBeNull();
  });

  it('is fail-soft per finding when a notification throws', async () => {
    const d = deps({
      sendMessage: vi.fn(async () => {
        throw new Error('coord down');
      }),
    } as never);
    const out = await divergenceSweep(d);
    expect(out.outcomes[0].outcome).toBe('error');
  });
});
