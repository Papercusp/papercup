/**
 * P-017 (c) — the "this value has a cell, read it" detector.
 *
 * The bulk of this suite is FALSE-POSITIVE tests, and that is deliberate. Per EI-10949
 * (work_items/complete.ts), a nudge that misfires on ordinary prose teaches agents to
 * skim the channel it shares with real warnings — so for a tier-3 detector, precision
 * is the correctness property and recall is secondary. A detector that catches every
 * transcription and cries wolf twice a day is WORSE than one that catches most and
 * never does.
 */

import { describe, it, expect } from 'vitest';
import {
  detectCellTranscriptions,
  cellTranscriptionHint,
  formatCellTranscriptionHint,
  CONTEXT_WINDOW,
} from './cell-transcription-detector';
import { registerBuiltinCells } from './cell-registrations';
import { getCellUnchecked, __resetCellRegistryForTests } from './cell-registry';

describe('cell-transcription detector — TRUE positives (the 2026-07-26 shape)', () => {
  it('flags a sha stated as the deployed position', () => {
    const hits = detectCellTranscriptions(':3070 is serving abc1234 right now');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.value).toBe('abc1234');
    expect(hits[0]!.cell).toBe('git.pipelinePosition');
  });

  it('routes a sha stated as the gate candidate to the candidate cell', () => {
    const hits = detectCellTranscriptions('green-checkpoint is judging candidate 60bb6f3c33');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.cell).toBe('gate.greenCheckpoint.candidate');
    expect(hits[0]!.field).toBe('changeInCandidate.judgingSha');
    expect(hits[0]!.what).toContain('green-checkpoint candidate');
  });

  it('does not classify a gate candidate as the deployed pipeline position', () => {
    const hits = detectCellTranscriptions('gate candidate adf6129c');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.cell).toBe('gate.greenCheckpoint.candidate');
  });

  it('does not treat an active source/candidate citation without state language as a claim', () => {
    expect(detectCellTranscriptions('preserve the active adf6129c salvage')).toEqual([]);
  });

  it('flags a behind-count stated as current pipeline state', () => {
    const hits = detectCellTranscriptions('main is 3 commits behind staging');
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits.some((h) => h.cell === 'git.pipelinePosition')).toBe(true);
  });

  it('flags the "behind by N" phrasing too', () => {
    expect(detectCellTranscriptions('origin/main is behind by 12 right now').length).toBeGreaterThanOrEqual(1);
  });

  it('reports the SAME sha claimed twice only once (dedupe, case-insensitive)', () => {
    const hits = detectCellTranscriptions('deployed ABC1234 … confirming deployed abc1234');
    expect(hits).toHaveLength(1);
  });

  it('finds several DISTINCT transcriptions in one body', () => {
    const hits = detectCellTranscriptions(
      'deployed sha is abc1234, staging is on def5678, and main is 4 commits behind',
    );
    expect(hits.length).toBeGreaterThanOrEqual(3);
  });
});

describe('cell-transcription detector — FALSE positives it must NOT raise (EI-10949)', () => {
  const mustNotFire = [
    // A citation, not a state claim — the single most important negative.
    ['a historical commit citation', 'see commit abc1234 for the rationale behind this change'],
    ['a fix reference', 'this was fixed in abc1234, which predates the refactor'],
    // Hex-shaped things that are not shas.
    ['a hex colour', 'the token resolves to #a1b2c3d and the contrast still passes'],
    // THE ONE THAT ACTUALLY BIT: agent ids travel in coord messages beside words like
    // "live"/"running" constantly, and `\b` treats `-` as a boundary — so a naive sha
    // pattern matched the uuid's 8- and 12-char hex segments and would have fired on a
    // large share of real traffic. Both the prefixed and bare forms are pinned.
    ['a prefixed agent id', 'session su-8d9a671c-ccda-4aa9-b4f4-8f0d1c7a4804 is live'],
    ['a bare uuid (leading segment, no prefix)', '8d9a671c-ccda-4aa9-b4f4-8f0d1c7a4804 is running'],
    ['an id in a deploy sentence', 'agent su-2846407f-4f4c-4313-8db8-dce7592e269d deployed the change'],
    ['a hyphenated identifier', 'the branch deadbeef-fix is now on staging'],
    // A source checkout's HEAD is not the deployed pipeline position. The nearby
    // release/staging words belong to separate facts in the same report.
    ['a current source HEAD beside unrelated pipeline prose', 'current HEAD 2b95ba4eb7; release status remains red'],
    ['a source HEAD beside a staging note', 'source HEAD is 2b95ba4eb7, while staging source is ahead'],
    // Pure digits are numbers far more often than shas — the pattern requires an a-f.
    ['a 7-digit number', 'the sweep processed 1234567 rows in the window'],
    ['a row count', 'tool_invocations holds 5461000 rows over 30 days'],
    // Counts with no pipeline context.
    ['a generic count of commits in prose', 'I reviewed 3 commits worth of changes to the parser'],
    ['an unrelated number', 'the suite runs 155 tests in 12 seconds'],
    // Ordinary engineering prose.
    ['plain prose', 'refactored the resolver so the audience check is applied on the read path'],
    ['an empty string', ''],
  ] as const;

  for (const [label, text] of mustNotFire) {
    it(`does not fire on ${label}`, () => {
      expect(detectCellTranscriptions(text), `text: ${text}`).toEqual([]);
    });
  }

  it('does not fire when the state word is FAR from the value (outside the context window)', () => {
    const far = `abc1234 ${'x'.repeat(CONTEXT_WINDOW * 3)} deployed`;
    expect(detectCellTranscriptions(far)).toEqual([]);
  });

  it('DOES fire when that same pair is close together — proving the window is what separates them', () => {
    expect(detectCellTranscriptions('abc1234 was deployed').length).toBeGreaterThanOrEqual(1);
  });

  it('DOES fire when a source HEAD is explicitly described as deployed', () => {
    const hits = detectCellTranscriptions('current HEAD 2b95ba4eb7 is deployed to :3070');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.value).toBe('2b95ba4eb7');
  });
});

describe('cell-transcription detector — never throws, never blocks (tier-3 invariant)', () => {
  const junk: unknown[] = [null, undefined, 42, {}, [], true, Symbol('x'), () => {}, NaN];

  for (const v of junk) {
    it(`returns [] for ${String(typeof v)} input rather than throwing`, () => {
      expect(() => detectCellTranscriptions(v)).not.toThrow();
      expect(detectCellTranscriptions(v)).toEqual([]);
    });
  }

  it('bounds the scan on a very large body without hanging', () => {
    const huge = `${'deployed abc1234 '.repeat(5000)}`;
    const t0 = Date.now();
    const hits = detectCellTranscriptions(huge);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(hits.length).toBeGreaterThan(0);
  });

  it('is ORDER-INDEPENDENT — repeated calls give identical results (no shared regex lastIndex)', () => {
    const text = 'deployed abc1234 and main is 3 commits behind';
    const a = detectCellTranscriptions(text);
    const b = detectCellTranscriptions(text);
    const c = detectCellTranscriptions(text);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });
});

describe('the advisory text', () => {
  it('is null when there is nothing to say — callers must not attach an empty hint', () => {
    expect(formatCellTranscriptionHint([])).toBeNull();
    expect(cellTranscriptionHint('nothing of interest here')).toBeNull();
  });

  it('names the CELL, not just the offending value — a hint with no next call is useless', () => {
    const hint = cellTranscriptionHint(':3070 is serving abc1234')!;
    expect(hint).toContain('git.pipelinePosition');
    expect(hint).toContain('abc1234');
  });

  it('says plainly that nothing was blocked — it is a DETECTOR, not a gate', () => {
    const hint = cellTranscriptionHint(':3070 is serving abc1234')!;
    expect(hint).toMatch(/nothing was blocked|advisory/i);
  });

  it('caps the enumerated list and reports the remainder rather than dumping everything', () => {
    const hint = cellTranscriptionHint(
      'deployed abc1234, def5678, 9abcdef, feedbee, cafebabe are all live releases',
    )!;
    expect(hint).toMatch(/and \d+ more/);
  });
});

/**
 * THE ANTI-DRIFT GUARD. The pattern table names cells by string; nothing in the type
 * system ties those to the registry. A cell that is renamed (or a pattern written
 * against a cell P-007 has not shipped yet) would leave the detector silently matching
 * nothing — the exact failure mode this plan keeps cataloguing.
 */
describe('every cell named by the pattern table is actually REGISTERED', () => {
  it('resolves each pattern cell through the registry', () => {
    __resetCellRegistryForTests();
    registerBuiltinCells();

    const named = new Set(
      detectCellTranscriptions(
        'deployed abc1234 and main is 3 commits behind staging',
      ).map((h) => h.cell),
    );
    expect(named.size).toBeGreaterThan(0);

    for (const cell of named) {
      expect(getCellUnchecked(cell), `pattern references unregistered cell "${cell}"`).toBeDefined();
    }
  });
});
