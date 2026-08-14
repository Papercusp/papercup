import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { betSignalView, betSignalWhy, betSignalDispositionArgs, BET_SIGNAL_ACTION } from './bet-signal-rule';
import type { ReactionRule, ToolInvocationEvent } from '../events/types';

/** A minimal `work_items:complete` event (single-item shape) carrying a bet-analysis Signal. */
function completeEvent(over: {
  domainKind?: string;
  outputPayload?: unknown;
  id?: string;
} = {}): ToolInvocationEvent {
  return {
    tool: 'work_items:complete',
    args: {},
    ctx: {},
    result: {
      data: {
        ok: true,
        id: over.id ?? 'BA-1',
        workItem: { payload: { domainKind: over.domainKind ?? 'bet-analysis', venue: 'polymarket', ticker: '0xabc' } },
        outputPayload:
          'outputPayload' in over
            ? over.outputPayload
            : { venue: 'polymarket', ticker: '0xabc', side: 'yes', modelProb: 0.62, marketProb: 0.5, edge: 0.12, confidence: 0.8, rationale: 'fresh evidence favors YES', sources: ['x'], ts: 't' },
      },
    },
  } as unknown as ToolInvocationEvent;
}

describe('betSignalView — the reaction `when` gate', () => {
  it('reads the Signal off a bet-analysis completion', () => {
    const v = betSignalView(completeEvent());
    expect(v).toMatchObject({ itemRef: 'BA-1', side: 'yes', edge: 0.12, confidence: 0.8, modelProb: 0.62, marketProb: 0.5 });
  });

  it('returns null for a non-bet-analysis completion (rule does not fire)', () => {
    expect(betSignalView(completeEvent({ domainKind: 'chunk' }))).toBeNull();
  });

  it('returns null when there is no output payload', () => {
    expect(betSignalView(completeEvent({ outputPayload: undefined }))).toBeNull();
  });

  it('tolerates a partial/off-shape payload (best-effort, defensive reads)', () => {
    const v = betSignalView(completeEvent({ outputPayload: { side: 'no', rationale: 'thin' } }));
    expect(v).toMatchObject({ itemRef: 'BA-1', side: 'no', rationale: 'thin' });
    expect(v?.edge).toBeUndefined();
  });
});

describe('betSignalWhy', () => {
  it('leads with the numeric strength then the rationale', () => {
    const v = betSignalView(completeEvent())!;
    expect(betSignalWhy(v)).toBe('edge=+0.120 conf=0.80 model=0.62 mkt=0.50 yes · fresh evidence favors YES');
  });
  it('clamps to 1000 chars', () => {
    const v = betSignalView(completeEvent({ outputPayload: { side: 'yes', rationale: 'x'.repeat(2000) } }))!;
    expect(betSignalWhy(v).length).toBeLessThanOrEqual(1000);
  });
});

describe('betSignalDispositionArgs — the fired autonomy:record_disposition args', () => {
  it('emits a propose-only, reversible, system-authority act disposition (D-005-honest)', () => {
    const args = betSignalDispositionArgs(completeEvent());
    expect(args).toMatchObject({
      action: BET_SIGNAL_ACTION,
      disposition: 'act',
      riskTier: 'low',
      reversibility: 'reversible',
      authority: 'system',
      itemRef: 'BA-1',
    });
    expect(args.why).toMatch(/edge=\+0\.120/);
  });
});

/**
 * ⚠ This block is ordering-hardened on purpose — it was a chronic gate flake
 * (EI-20345838853265287 / EI-20354160652342594 / EI-20377731359136136 /
 * EI-20413591345557630, red ~6×/6h and a suspect in a 21h green-checkpoint red streak).
 *
 * The mechanism: the reaction registry is ONE process-global instance (pinned via
 * `pinModuleState` in events/registry.ts). This module registers by IMPORT SIDE-EFFECT,
 * and `events/index.ts` → `events/rules.ts` side-effect-imports it, so in a shared vitest
 * worker it is usually already evaluated by the time this file runs. ESM evaluates a
 * module body ONCE per worker, so a plain `await import('./bet-signal-rule')` is a cached
 * no-op that CANNOT re-register. Any of the 13 files calling `_resetReactionsForTests()`
 * therefore wipes this rule with no way for this test to restore it — which is exactly
 * what CI saw: the registry held only `['cache-tag-eca:table-changed']`.
 *
 * So the test no longer depends on worker file-ordering: it forces the hostile
 * precondition itself, then re-registers via `vi.resetModules()`.
 */
describe('rule registration', () => {
  let snapshot: ReactionRule[] = [];

  beforeAll(async () => {
    const { listReactionRules } = await import('../events/registry');
    snapshot = listReactionRules().slice();
  });

  afterAll(async () => {
    // Leave the SHARED registry exactly as we found it — this file must not itself
    // become another cross-file polluter for whatever runs next in this worker.
    const { _resetReactionsForTests, registerReactionRule } = await import('../events/registry');
    _resetReactionsForTests();
    for (const r of snapshot) registerReactionRule(r);
  });

  // CONTROL — pins the hazard itself. If a bare re-import ever DOES restore the
  // registration, the premise above changed and the guard below can be simplified.
  it('a bare re-import can NOT restore the rule once a peer cleared the shared registry', async () => {
    const { _resetReactionsForTests, listReactionRules } = await import('../events/registry');
    _resetReactionsForTests();
    await import('./bet-signal-rule'); // already evaluated ⇒ body does not re-run
    expect(listReactionRules().map((r) => r.id)).not.toContain('oddsmith:bet-signal-disposition');
  });

  it('self-registers on the work_items:complete event', async () => {
    const { _resetReactionsForTests, listReactionRules } = await import('../events/registry');
    _resetReactionsForTests(); // hostile precondition: a peer file cleared the registry

    vi.resetModules(); // drop the cached module record …
    await import('./bet-signal-rule'); // … so the body re-runs and re-applies its registration

    expect(listReactionRules().map((r) => r.id)).toContain('oddsmith:bet-signal-disposition');
  });
});
