import { describe, expect, it } from 'vitest';
import {
  FLUSH_GATE_PCT,
  FLUSH_STALE_MS,
  classifyStaleClaims,
  renderFlushGateLine,
  type ClaimFreshness,
} from './inbox-flush-gate';
import { contextUsagePct, COMPACTION_HINT_PCT } from './inbox-context-usage';

const NOW = 1_800_000_000_000; // fixed clock so cases are deterministic
const claim = (o: Partial<ClaimFreshness> & { workItemId: string }): ClaimFreshness => ({
  lastActivityMs: NOW,
  acquiredMs: NOW,
  checkpointUpdatedMs: null,
  ...o,
});

describe('classifyStaleClaims (P-002 flush-freshness classifier)', () => {
  it('is empty for no claims', () => {
    expect(classifyStaleClaims([], NOW)).toEqual([]);
  });

  it("flags a NEVER-checkpointed claim held past the threshold as reason 'never'", () => {
    const held = FLUSH_STALE_MS + 60_000; // 11 min
    const out = classifyStaleClaims(
      [claim({ workItemId: 'WI-1', acquiredMs: NOW - held, checkpointUpdatedMs: null })],
      NOW,
    );
    expect(out).toEqual([{ workItemId: 'WI-1', reason: 'never', staleMs: held }]);
  });

  it('does NOT flag a never-checkpointed claim still within the threshold', () => {
    const held = FLUSH_STALE_MS - 60_000; // 9 min — genuinely fresh work
    const out = classifyStaleClaims(
      [claim({ workItemId: 'WI-1', acquiredMs: NOW - held, checkpointUpdatedMs: null })],
      NOW,
    );
    expect(out).toEqual([]);
  });

  it("flags a claim whose work outran its last checkpoint as reason 'drift'", () => {
    const drift = FLUSH_STALE_MS + 120_000; // 12 min since the last checkpoint
    const out = classifyStaleClaims(
      [
        claim({
          workItemId: 'WI-2',
          acquiredMs: NOW - 3_600_000,
          lastActivityMs: NOW,
          checkpointUpdatedMs: NOW - drift,
        }),
      ],
      NOW,
    );
    expect(out).toEqual([{ workItemId: 'WI-2', reason: 'drift', staleMs: drift }]);
  });

  it('does NOT flag a claim checkpointed within the threshold of its last activity', () => {
    const drift = FLUSH_STALE_MS - 60_000; // 9 min — recently flushed
    const out = classifyStaleClaims(
      [
        claim({
          workItemId: 'WI-2',
          lastActivityMs: NOW,
          checkpointUpdatedMs: NOW - drift,
        }),
      ],
      NOW,
    );
    expect(out).toEqual([]);
  });

  it('treats a checkpoint NEWER than last-activity as fresh (negative drift, never flagged)', () => {
    const out = classifyStaleClaims(
      [claim({ workItemId: 'WI-3', lastActivityMs: NOW - 5_000, checkpointUpdatedMs: NOW })],
      NOW,
    );
    expect(out).toEqual([]);
  });

  it('honors a custom staleMs threshold', () => {
    const held = 5 * 60_000; // 5 min
    const c = [claim({ workItemId: 'WI-4', acquiredMs: NOW - held, checkpointUpdatedMs: null })];
    expect(classifyStaleClaims(c, NOW, 10 * 60_000)).toEqual([]); // under a 10-min gate
    expect(classifyStaleClaims(c, NOW, 2 * 60_000)).toEqual([
      { workItemId: 'WI-4', reason: 'never', staleMs: held },
    ]); // over a 2-min gate
  });

  it('classifies a mixed set, keeping only the stale ones', () => {
    const stale = FLUSH_STALE_MS + 60_000;
    const fresh = FLUSH_STALE_MS - 60_000;
    const out = classifyStaleClaims(
      [
        claim({ workItemId: 'WI-fresh-never', acquiredMs: NOW - fresh, checkpointUpdatedMs: null }),
        claim({ workItemId: 'WI-stale-never', acquiredMs: NOW - stale, checkpointUpdatedMs: null }),
        claim({ workItemId: 'WI-stale-drift', lastActivityMs: NOW, checkpointUpdatedMs: NOW - stale }),
        claim({ workItemId: 'WI-fresh-drift', lastActivityMs: NOW, checkpointUpdatedMs: NOW - fresh }),
      ],
      NOW,
    );
    expect(out.map((s) => s.workItemId)).toEqual(['WI-stale-never', 'WI-stale-drift']);
  });
});

describe('renderFlushGateLine (P-002 named-action injection)', () => {
  const stale = [{ workItemId: 'WI-2378', reason: 'never' as const, staleMs: 11 * 60_000 }];

  it('is null when pct is below the gate', () => {
    expect(renderFlushGateLine(FLUSH_GATE_PCT - 1, stale)).toBeNull();
  });

  it('is null when pct cannot be computed', () => {
    expect(renderFlushGateLine(null, stale)).toBeNull();
    expect(renderFlushGateLine(undefined, stale)).toBeNull();
  });

  it('is null when no claims are stale, even at/above the gate', () => {
    expect(renderFlushGateLine(FLUSH_GATE_PCT, [])).toBeNull();
    expect(renderFlushGateLine(99, [])).toBeNull();
  });

  it('engages AT the gate and NAMES the item + the action', () => {
    const line = renderFlushGateLine(FLUSH_GATE_PCT, stale);
    expect(line).not.toBeNull();
    expect(line).toContain('WI-2378');
    expect(line).toContain('no checkpoint, held 11m');
    expect(line).toContain('work_items:checkpoint');
    expect(line).toContain(`at ${FLUSH_GATE_PCT}% context`);
  });

  it('renders drift reason with the checkpoint-staleness phrasing', () => {
    const line = renderFlushGateLine(80, [
      { workItemId: 'WI-9', reason: 'drift', staleMs: 15 * 60_000 },
    ]);
    expect(line).toContain('WI-9 (checkpoint 15m stale)');
  });

  it('uses singular vs plural claim wording', () => {
    const one = renderFlushGateLine(80, stale);
    expect(one).toContain('1 work-item claim ');
    const two = renderFlushGateLine(80, [
      ...stale,
      { workItemId: 'WI-9', reason: 'drift', staleMs: 12 * 60_000 },
    ]);
    expect(two).toContain('2 work-item claims');
    expect(two).toContain('WI-2378');
    expect(two).toContain('WI-9');
  });

  it('honors a custom gatePct override', () => {
    expect(renderFlushGateLine(70, stale, { gatePct: 60 })).not.toBeNull();
    expect(renderFlushGateLine(70, stale, { gatePct: 90 })).toBeNull();
  });

  it('gates BELOW the compaction hint so flushing precedes the compaction-urgent zone', () => {
    expect(FLUSH_GATE_PCT).toBeLessThan(COMPACTION_HINT_PCT);
  });
});

describe('contextUsagePct (P-002 single pct source)', () => {
  it('rounds the same way the usage line and the flush gate both read', () => {
    expect(contextUsagePct(845, 1000)).toBe(85);
    expect(contextUsagePct(844, 1000)).toBe(84);
  });
  it('is null when usage cannot be computed', () => {
    expect(contextUsagePct(null, 1000)).toBeNull();
    expect(contextUsagePct(1000, 0)).toBeNull();
    expect(contextUsagePct(undefined, undefined)).toBeNull();
  });
});
