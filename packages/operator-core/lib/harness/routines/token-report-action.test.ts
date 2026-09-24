/**
 * token-report-action.test.ts — guards the P-016 presence read-volume block of
 * the weekly token report (presence-v2-2026-06-14 / token-usage-reduction P-003).
 *
 * `renderPresenceVolume` is pure (rows in → string out), so these run without a
 * DB. The SQL that feeds it (output_size from tool_invocations) is validated
 * against the live schema separately; here we lock the render contract: each
 * presence read tool surfaces calls + payload + avg, each with a week-over-week
 * delta, so a richer presence can't silently regress the call-count / result-size
 * levers.
 */
import { describe, it, expect } from 'vitest';
import { renderPresenceVolume, renderDim, evaluateUsageHealth, renderUsageHealth, type UsageHealthRow, type AggRow } from './token-report-action';

type Vol = { tool: string; calls: string; bytes: string | null; avg_bytes: string | null };

describe('usage accounting health detectors', () => {
  const row: UsageHealthRow = { cohort: 'anthropic:model:interactive', samples: '30', timed_requests: '30',
    unknown_model: '0', unknown_writes: '0', unknown_tiers: '0', tier_mismatches: '0',
    model_provenance_mismatches: '0', newest_event: '1000000' };
  it('stays healthy independently of hit rate when accounting is complete and recent', () => {
    expect(evaluateUsageHealth(row, 1000001)).toMatchObject({ state: 'ok', coverage: 1, signals: [] });
  });
  it('marks stale, thin and unknown populations as unknown, never as zero-cost healthy traffic', () => {
    const result = evaluateUsageHealth({ ...row, samples: '2', timed_requests: '0', newest_event: null,
      unknown_writes: '2', unknown_model: '1', unknown_tiers: '1' }, 1000001);
    expect(result.state).toBe('unknown');
    expect(result.unknown).toHaveLength(6);
    expect(result.signals).toEqual([]);
    expect(evaluateUsageHealth(row, 1000000 + 3 * 86_400_000).unknown).toContain('stale-or-unknown-telemetry');
    expect(renderUsageHealth([], 1)).toContain('unknown');
  });
  it('detects injected write-tier and parser/model contradictions even at low volume', () => {
    const result = evaluateUsageHealth({ ...row, samples: '1', timed_requests: '1',
      tier_mismatches: '1', model_provenance_mismatches: '1' }, 1000001);
    expect(result.state).toBe('regression');
    expect(result.signals).toEqual(['write-tier-reconciliation-failed', 'parser-model-provenance-inconsistent']);
  });
});

describe('cache reporting coverage', () => {
  const row = (changes: Partial<AggRow> = {}): AggRow => ({ dim: 'interactive [request-time]', calls: '10',
    in_t: '100', out_t: '100', cr_t: '800', cw_t: null, usd: null,
    incomplete_tokens: '10', unpriced: '10', estimated_usd: null, reported_usd: null,
    comparable_read: '800', comparable_input: '1000', comparable_samples: '10',
    request_observations: '10', request_hits: '9', unrecoverable_samples: '0', ...changes });
  it('separates token reuse, request hits and unknown write/pricing coverage', () => {
    const text = renderDim('source', [row()], new Map());
    expect(text).toContain('Token reuse 80.00% (10/10 comparable samples)');
    expect(text).toContain('requests with any cache read 90.00%');
    expect(text).toContain('unknown cache-write');
    expect(text).toContain('10/10 unpriced samples');
    expect(text).not.toContain('$0.00');
    expect(text).toContain('≥');
  });
  it('does not pretend legacy aggregates are requests or an empty denominator is a zero-percent hit rate', () => {
    const text = renderDim('source', [row({ dim: 'interactive [ingestion-time; request time unavailable]',
      request_observations: '0', request_hits: '0', comparable_input: null, comparable_read: null,
      comparable_samples: '0' })], new Map());
    expect(text).toContain('ingestion-time; request time unavailable');
    expect(text).toContain('Token reuse unknown');
    expect(text).toContain('requests with any cache read unknown');
    expect(text).not.toContain('0.00%');
  });
  it('suppresses misleading change percentages when either population has incomplete counts', () => {
    const text = renderDim('source', [row({ in_t: '1000000' })], new Map([[row().dim, row({ in_t: '1000' })]]));
    expect(text).not.toMatch(/\([+-]\d+%\)/);
  });
  it('discloses the unavailable-source population separately from merely unpriced samples', () => {
    expect(renderDim('source', [row({ unrecoverable_samples: '3' })], new Map()))
      .toContain('10/10 unpriced samples; 3/10 source-unavailable');
  });
});

describe('renderPresenceVolume (P-016 guardrail)', () => {
  it('surfaces calls + payload + avg with WoW deltas for each presence read tool', () => {
    const cur: Vol[] = [
      { tool: 'coord:presence', calls: '330', bytes: '12790190', avg_bytes: '38758' },
      { tool: 'coord:inbox', calls: '88000', bytes: '87000000', avg_bytes: '989' },
      { tool: 'fleet:assignments', calls: '1000', bytes: '17000000', avg_bytes: '17000' },
    ];
    const prev: Vol[] = [
      { tool: 'coord:presence', calls: '300', bytes: '9000000', avg_bytes: '30000' },
      { tool: 'coord:inbox', calls: '80000', bytes: '80000000', avg_bytes: '1000' },
      { tool: 'fleet:assignments', calls: '1000', bytes: '17000000', avg_bytes: '17000' },
    ];
    const out = renderPresenceVolume(cur, prev);
    expect(out).toContain('Presence/coord read-volume');
    // call-count lever (#1) — surfaced with WoW
    expect(out).toContain('coord:presence: 330 calls (+10%)');
    // tool-result-size lever (#2) — bytes formatted + WoW
    expect(out).toMatch(/coord:presence:.*12\.8 MB payload \(\+42%\)/);
    expect(out).toContain('avg 38.8 KB/call');
    // a flat tool still renders (a +0% is honest, not noise to suppress)
    expect(out).toContain('fleet:assignments: 1000 calls (+0%)');
  });

  it('lists every configured tool at zero on an empty window', () => {
    const out = renderPresenceVolume([], []);
    expect(out).toContain('coord:presence: 0 calls');
    expect(out).toContain('coord:inbox: 0 calls');
    expect(out).toContain('fleet:assignments: 0 calls');
    expect(out).toContain('(no presence/coord reads recorded this window)');
  });

  it('omits the WoW delta when there is no prior-window baseline', () => {
    const out = renderPresenceVolume(
      [{ tool: 'coord:presence', calls: '5', bytes: '1000', avg_bytes: '200' }],
      [],
    );
    expect(out).toContain('coord:presence: 5 calls —'); // prev=0 → no (±%) suffix
    expect(out).not.toMatch(/coord:presence: 5 calls \(/);
  });
});
