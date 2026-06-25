import { describe, it, expect } from 'vitest';
import { betSignalView, betSignalWhy, betSignalDispositionArgs, BET_SIGNAL_ACTION } from './bet-signal-rule';
import type { ToolInvocationEvent } from '../events/types';

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

describe('rule registration', () => {
  it('self-registers on the work_items:complete event', async () => {
    await import('./bet-signal-rule');
    const { listReactionRules } = await import('../events/registry');
    const ids = listReactionRules().map((r) => r.id);
    expect(ids).toContain('oddsmith:bet-signal-disposition');
  });
});
