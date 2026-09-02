/**
 * WI-2142447 — the sweep PASS: which rows it looks at, what it stamps, what it reports.
 *
 * The judgement (which transitions are findings) is tested in
 * `completion-claim-recheck.test.ts`; this file tests the pass around it, with every
 * dependency injected — no database, no filesystem, no repo checkout.
 *
 * The failure this file exists to prevent is the one the `claims` feature already paid for
 * once: an evaluator that is complete and correct sitting behind plumbing that never
 * carries the data to it, where every test on either side passes and the feature is dead.
 * So these assertions are about the STAMP and the CANDIDATE HANDLING, not the algorithm.
 */
import { describe, expect, it, vi } from 'vitest';

import type { ClaimSourceReader, CompletionClaim } from './completion-claims';
import type { CompletionClaimRecheckRecord } from './completion-claim-recheck';
import {
  completionClaimRecheckWatchdogKey,
  renderCompletionClaimRecheckBody,
  runCompletionClaimRecheckSweep,
  type CompletionClaimRecheckCandidate,
} from './completion-claim-recheck-sweep';

const CLAIM: CompletionClaim = {
  kind: 'string-in-array',
  path: 'src/tools.ts',
  container: 'CORE_TOOL_NAMES',
  value: 'coord:dispatch',
  expect: 'present',
};

const HOLDING = { 'src/tools.ts': `export const CORE_TOOL_NAMES = ['coord:dispatch'] as const;` };
const BROKEN = { 'src/tools.ts': `export const CORE_TOOL_NAMES = ['coord:send'] as const;` };

function readerFor(files: Record<string, string>): ClaimSourceReader {
  return { readSource: (p) => files[p] ?? null };
}

/** A candidate as the SQL hands it over: raw jsonb values, not parsed types. */
function candidate(over: Partial<CompletionClaimRecheckCandidate> = {}): CompletionClaimRecheckCandidate {
  return {
    id: 'WI-1',
    harnessSlug: 'papercusp',
    title: 'a closed thing',
    claims: JSON.parse(JSON.stringify([CLAIM])) as unknown,
    baseline: JSON.parse(
      JSON.stringify({
        at: '2026-09-02T20:00:00.000Z',
        entries: [{ claim: CLAIM, verdict: 'holds', reason: 'present at close' }],
      }),
    ) as unknown,
    priorVerdict: null,
    ...over,
  };
}

function harness(rows: CompletionClaimRecheckCandidate[], files: Record<string, string>) {
  const stamped: Array<{ id: string; record: CompletionClaimRecheckRecord }> = [];
  const stamp = vi.fn(async (input: { id: string; harnessSlug: string | null; record: CompletionClaimRecheckRecord }) => {
    stamped.push({ id: input.id, record: input.record });
  });
  return {
    stamped,
    stamp,
    deps: {
      candidates: async () => rows,
      reader: readerFor(files),
      stamp,
      now: () => new Date('2026-09-02T21:00:00.000Z'),
    },
  };
}

describe('runCompletionClaimRecheckSweep', () => {
  it('finds the regression and STAMPS it on the row', async () => {
    const h = harness([candidate()], BROKEN);
    const result = await runCompletionClaimRecheckSweep(h.deps);

    expect(result.regressed).toHaveLength(1);
    expect(result.regressed[0]).toMatchObject({ id: 'WI-1', newlyRegressed: true });
    expect(result.regressed[0].claims[0].reason).toContain('CORE_TOOL_NAMES');

    // The stamp is the durable half — the audit bucket's predicate reads exactly this.
    expect(h.stamp).toHaveBeenCalledTimes(1);
    expect(h.stamped[0].record).toMatchObject({
      verdict: 'regressed',
      regressed: 1,
      claimsChecked: 1,
      baselineMissing: false,
      at: '2026-09-02T21:00:00.000Z',
    });
  });

  it('stamps a CLEAN verdict too — never-checked and checked-clean are different states', async () => {
    const h = harness([candidate()], HOLDING);
    const result = await runCompletionClaimRecheckSweep(h.deps);
    expect(result.regressed).toHaveLength(0);
    expect(h.stamp).toHaveBeenCalledTimes(1);
    expect(h.stamped[0].record.verdict).toBe('clean');
  });

  it('reports newlyRegressed:false when a previous pass already stamped it regressed', async () => {
    const h = harness([candidate({ priorVerdict: 'regressed' })], BROKEN);
    const result = await runCompletionClaimRecheckSweep(h.deps);
    expect(result.regressed[0].newlyRegressed).toBe(false);
  });

  it('SKIPS a row whose persisted claims do not parse, and never guesses at it', async () => {
    const h = harness([candidate({ claims: [{ kind: 'not-a-real-kind', nonsense: 1 }] })], BROKEN);
    const result = await runCompletionClaimRecheckSweep(h.deps);
    expect(result.malformedRows).toBe(1);
    expect(result.scannedRows).toBe(0);
    expect(result.regressed).toHaveLength(0);
    // A malformed row must not be stamped: a stamp is a claim to have judged it.
    expect(h.stamp).not.toHaveBeenCalled();
  });

  it('SKIPS a row whose persisted baseline does not parse', async () => {
    const h = harness([candidate({ baseline: { at: 42, entries: 'nope' } })], BROKEN);
    const result = await runCompletionClaimRecheckSweep(h.deps);
    expect(result.malformedRows).toBe(1);
    expect(h.stamp).not.toHaveBeenCalled();
  });

  it('an ABSENT baseline is judged, not skipped — and never yields a regression', async () => {
    // Distinct from malformed above: no baseline is a legitimate state (a close written
    // before baselines were recorded), so the row is still checked and stamped.
    const h = harness([candidate({ baseline: null })], BROKEN);
    const result = await runCompletionClaimRecheckSweep(h.deps);
    expect(result.malformedRows).toBe(0);
    expect(result.unbaselinedRows).toBe(1);
    expect(result.regressed).toHaveLength(0);
    expect(result.falsifiedUnbaselined).toHaveLength(1);
    expect(h.stamped[0].record).toMatchObject({ verdict: 'clean', baselineMissing: true });
  });

  it('a source it cannot read yields no finding at all (fail-open across the pass)', async () => {
    const h = harness([candidate()], {});
    const result = await runCompletionClaimRecheckSweep(h.deps);
    expect(result.regressed).toHaveLength(0);
    expect(result.falsifiedUnbaselined).toHaveLength(0);
    expect(h.stamped[0].record.verdict).toBe('clean');
  });

  it('passes the row limit through to the candidate query', async () => {
    const candidates = vi.fn(async () => []);
    await runCompletionClaimRecheckSweep(
      { candidates, reader: readerFor({}), stamp: async () => {} },
      7,
    );
    expect(candidates).toHaveBeenCalledWith(7);
  });

  it('carries several rows independently', async () => {
    const h = harness(
      [candidate({ id: 'WI-1' }), candidate({ id: 'WI-2', claims: [] })],
      BROKEN,
    );
    const result = await runCompletionClaimRecheckSweep(h.deps);
    // WI-2 declares an empty claim array: nothing to judge, so it is not scanned.
    expect(result.scannedRows).toBe(1);
    expect(result.regressed.map((f) => f.id)).toEqual(['WI-1']);
  });
});

describe('renderCompletionClaimRecheckBody', () => {
  it('names each regressed item and refuses to read as a verdict on the close', async () => {
    const h = harness([candidate()], BROKEN);
    const body = renderCompletionClaimRecheckBody(await runCompletionClaimRecheckSweep(h.deps));
    expect(body).toContain('WI-1');
    expect(body).toContain('EVIDENCE, NOT A VERDICT');
    // The reader must be pointed at the durable surface, not left with prose.
    expect(body).toContain('claim-since-falsified');
  });

  it('lists unbaselined falsifications separately from regressions', async () => {
    const h = harness([candidate({ baseline: null })], BROKEN);
    const body = renderCompletionClaimRecheckBody(await runCompletionClaimRecheckSweep(h.deps));
    expect(body).toContain('never witnessed holding');
    expect(body).toContain('NOT counted as a regression');
  });
});

describe('watchdog key', () => {
  it('is per-harness so one harness cannot dedup another out of a filing', () => {
    expect(completionClaimRecheckWatchdogKey('papercusp')).toBe('completion-claim-recheck:papercusp');
    expect(completionClaimRecheckWatchdogKey('other')).not.toBe(
      completionClaimRecheckWatchdogKey('papercusp'),
    );
  });
});
