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
  suggestDependsOnCells,
  MAX_DEPENDS_ON_SUGGESTIONS,
  CONTEXT_WINDOW,
} from './cell-transcription-detector';
import { cellTranscriptionHintResolvingCommits, commitResolverRepo, gitResolvesToCommit } from './git-commit-resolver';
import { execFileSync } from 'node:child_process';
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
    [
      'an explicit lock id in coordination prose',
      'please release the desktop-sidecar lock `cac76150`',
    ],
    ['an explicit lease token', 'the lease token cac76150 is live'],
    ['a lock-id prefix label', 'the lock-id prefix `cac76150` is live'],
    // A source checkout's HEAD is not the deployed pipeline position. The nearby
    // release/staging words belong to separate facts in the same report.
    ['a current source HEAD beside unrelated pipeline prose', 'current HEAD 2b95ba4eb7; release status remains red'],
    ['a source HEAD beside a staging note', 'source HEAD is 2b95ba4eb7, while staging source is ahead'],
    ['a historical root HEAD beside an origin divergence', 'Root HEAD cd9b060 was still ahead of direct origin/staging'],
    [
      'a future target-commit ancestry check beside pipeline words',
      'on next immutable checkpoint verdict, validate P-008 commit 13a4158ebd main/deployed ancestry',
    ],
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

  it('DOES fire when a root HEAD is explicitly described as deployed', () => {
    const hits = detectCellTranscriptions('Root HEAD cd9b060 is deployed to :3070');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.value).toBe('cd9b060');
  });

  it('DOES fire when a target commit is explicitly described as deployed', () => {
    const hits = detectCellTranscriptions('validate target commit abc1234 is deployed to :3070');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.value).toBe('abc1234');
  });

  it('still detects a release commit when it is not labeled as a lock or lease id', () => {
    const hits = detectCellTranscriptions('release commit cac76150 is live on :3070');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.value).toBe('cac76150');
  });

  it('does not classify a commit explicitly described as committed locally/on staging as deployed', () => {
    const text =
      'coord:send said commit e67fcd6c5 was committed locally/on staging and explicitly said the gate was deliberately paused';
    expect(detectCellTranscriptions(text)).toEqual([]);
    expect(cellTranscriptionHint(text)).toBeNull();
  });

  it('does not classify a work-item checkpoint contentHash as a deployed SHA', () => {
    const text = 'The implementation-start checkpoint is written (contentHash 562d3b6d9979)';
    expect(detectCellTranscriptions(text)).toEqual([]);
    expect(cellTranscriptionHint(text)).toBeNull();
  });

  it('does not classify an explicitly labeled Git blob hash as a deployed SHA', () => {
    const text = 'InboxPane staging blob 6183d5ee';
    expect(detectCellTranscriptions(text)).toEqual([]);
    expect(cellTranscriptionHint(text)).toBeNull();
  });

  it('does not classify a checkpoint hash from a coord summary with unrelated live-lock context', () => {
    const summary = 'WI-40905 checkpoint 721014582be1: waiting on two live Vite locks before final rebuild';
    const body =
      'Checkpoint 721014582be1 records the rejected torn artifact, root 81a24825be after git-sync, ' +
      'and the two remaining production paths live-locked by su-e9b139d9.';
    const text = `${summary}\n${body}`;
    const hits = detectCellTranscriptions(text);

    expect(hits.some((hit) => hit.value === '721014582be1')).toBe(false);
    expect(cellTranscriptionHint(text)).not.toContain('721014582be1');
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
 * P-007 — dependsOn SUGGESTIONS.
 *
 * Same precision-over-recall contract as the detector above, for the same EI-10949
 * reason, one notch sharper: these suggestions share a response with facts:assert's
 * genuinely load-bearing disclosures (truncation, unresolved dependencies, eviction,
 * the P-006 normalization receipt). A chatty suggestion here does not just annoy —
 * it devalues those. So the guards below are the subject under test, and a
 * suggestion that fires when it should not is a FAILURE, not a nuisance.
 */
describe('P-007 dependsOn suggestions — precision guards', () => {
  // The shared positive control. Every "does not suggest" test below is only
  // meaningful if this one still fires — otherwise a broken matcher would make the
  // whole block pass by suggesting nothing, ever.
  const TRANSCRIBING_BODY = 'main is 3 commits behind staging right now';

  it('POSITIVE CONTROL: suggests the cell whose value the body transcribes', () => {
    const out = suggestDependsOnCells(TRANSCRIBING_BODY);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].cell).toBe('git.pipelinePosition');
    // The evidence travels with the suggestion — that is what makes it checkable
    // against the text the caller just typed rather than taken on faith.
    expect(TRANSCRIBING_BODY).toContain(out[0].value);
    expect(out[0].what).toBeTruthy();
  });

  it('does NOT suggest a cell the caller ALREADY declared', () => {
    // Guard 2. Restating the caller's own input back to them as advice is the purest
    // form of the trust-tax EI-10949 describes.
    expect(suggestDependsOnCells(TRANSCRIBING_BODY, ['git.pipelinePosition'])).toEqual([]);
  });

  it('matches an already-declared cell despite case and surrounding whitespace', () => {
    // The declared list is caller-typed, so it arrives however they typed it. Missing a
    // match here re-suggests something they already declared, which is guard 2 failing
    // in the direction that is invisible until an agent complains about the noise.
    expect(suggestDependsOnCells(TRANSCRIBING_BODY, ['  GIT.PipelinePosition  '])).toEqual([]);
  });

  it('collapses repeated mentions of one cell into a SINGLE suggestion', () => {
    // Guard 3. The detector dedupes by cell+VALUE because it reports transcriptions;
    // a dependency is per-CELL, so three positions are still one dependency.
    const out = suggestDependsOnCells(
      'main is 3 commits behind staging, and staging is 12 commits behind, ' +
        'and we are behind by 40 commits overall',
    );
    expect(out.filter((s) => s.cell === 'git.pipelinePosition')).toHaveLength(1);
  });

  it('never returns more than the cap', () => {
    const out = suggestDependsOnCells(
      'deployed abc1234 is live and main is 3 commits behind staging and ' +
        'the release serving def5678 is running',
    );
    expect(out.length).toBeLessThanOrEqual(MAX_DEPENDS_ON_SUGGESTIONS);
  });

  it('does NOT suggest for a CITATION rather than a live-state claim', () => {
    // This is the guard that carries the most weight and the one most likely to rot:
    // it inherits the detector's context-window requirement. If the matcher were ever
    // loosened to fire on a bare value, this is the test that catches it — the
    // positive control above proves the [] here is a real refusal, not a dead matcher.
    expect(suggestDependsOnCells('the number 3 appears in the changelog')).toEqual([]);
  });

  it('does NOT suggest a plan content hash as a Git pipeline dependency', () => {
    // plans:get contentHash values are hex-shaped, but "plan v143/hash ... governs"
    // is plan metadata, not a deployment or serving-state claim. Keep this exact
    // acceptance-carry shape quiet so a stale plan fingerprint cannot arm
    // git.pipelinePosition invalidation.
    const body =
      'The body said plan v143/hash 65e44ddf6efb governs; that value is plans:get.contentHash, ' +
      'not a Git SHA, and the sentence says it governs the plan rather than deployment.';
    expect(detectCellTranscriptions(body)).toEqual([]);
    expect(suggestDependsOnCells(body)).toEqual([]);
  });

  it('is fail-soft on anything unparseable', () => {
    // An advisory that can throw turns facts:assert into an outage — the one failure
    // mode a tier-3 mechanism must not have.
    for (const bad of [null, undefined, 42, {}, [], '']) {
      expect(suggestDependsOnCells(bad as unknown)).toEqual([]);
    }
    expect(suggestDependsOnCells(TRANSCRIBING_BODY, undefined)).not.toEqual([]);
  });

  it('tolerates a malformed declared-cells list without dropping real suggestions', () => {
    // declaredCells is caller input reaching a pure helper; a null inside it must not
    // take out the suggestion path (and must not silently suppress every suggestion,
    // which would be a failure that looks exactly like "nothing to suggest").
    const out = suggestDependsOnCells(TRANSCRIBING_BODY, [
      null as unknown as string,
      '',
      '   ',
    ]);
    expect(out.length).toBeGreaterThan(0);
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
