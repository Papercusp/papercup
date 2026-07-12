/**
 * Tests for the P-020 checkpoint-harvest leg (su-ideate-learning-substrate-2026-07-10).
 * Two halves:
 *   - the PURE core: boundInsight (title/body split + bounds), pickLexicalCoalesce
 *     (verbatim consecutive-wake repeat), pickSemanticCoalesce (guard verdict SCOPED
 *     to the agent's own harvest ids);
 *   - the IMPURE harvestInsight: files a lane:observation with the source-tag +
 *     attribution, coalesces a lexical / semantic repeat instead of piling, and
 *     the fail-open contract (kill switch / VITEST-inert / blank / dep errors all
 *     degrade to a { filed:false } verdict, never a throw, never blocking the caller).
 */
import { afterEach, describe, it, expect, vi } from 'vitest';

import {
  boundInsight,
  harvestInsight,
  pickLexicalCoalesce,
  pickSemanticCoalesce,
  classifyClaimStrength,
  applyClaimStrengthPrefix,
  isRefutation,
  isClaimIdentifyingRef,
  HARVEST_ORIGIN,
  HARVEST_KILL_ENV,
  MAX_INSIGHT_CHARS,
  MAX_TITLE_CHARS,
  REFUTED_PREFIX,
  type HarvestDeps,
  type RecentHarvest,
} from './checkpoint-harvest';
import type { CaptureImprovementResult } from './capture-core';
import type { SemanticDupeResult } from '../../agent-tools/work_items/semantic-dupe-guard';

function makeDeps(opts: {
  recent?: RecentHarvest[];
  created?: boolean;
  issueId?: string;
  hard?: string[];
  captureThrows?: boolean;
  loadThrows?: boolean;
  byRef?: RecentHarvest[];
  flagResult?: boolean;
} = {}): HarvestDeps & {
  capture: ReturnType<typeof vi.fn>;
  loadRecent: ReturnType<typeof vi.fn>;
  findSemanticDupes: ReturnType<typeof vi.fn>;
  findByRef: ReturnType<typeof vi.fn>;
  flagRefuted: ReturnType<typeof vi.fn>;
} {
  const capture = vi.fn(async (): Promise<CaptureImprovementResult> => {
    if (opts.captureThrows) throw new Error('PG down');
    return {
      ok: true,
      created: opts.created ?? true,
      possibleDuplicates: [],
      ...(opts.issueId ? { issue: { id: opts.issueId } as CaptureImprovementResult['issue'] } : {}),
    };
  });
  const loadRecent = vi.fn(async (): Promise<RecentHarvest[]> => {
    if (opts.loadThrows) throw new Error('PG down');
    return opts.recent ?? [];
  });
  const findSemanticDupes = vi.fn(async (): Promise<SemanticDupeResult | null> => ({
    hard: (opts.hard ?? []).map((id) => ({ id, title: id, state: 'open', harness: null, similarity: 0.95 })),
    soft: [],
    thresholds: { hard: 0.93, soft: 0.85 },
  }));
  const findByRef = vi.fn(async (): Promise<RecentHarvest[]> => opts.byRef ?? []);
  const flagRefuted = vi.fn(async (): Promise<boolean> => opts.flagResult ?? true);
  return { capture, loadRecent, findSemanticDupes, findByRef, flagRefuted };
}

const prevKill = process.env[HARVEST_KILL_ENV];
afterEach(() => {
  if (prevKill === undefined) delete process.env[HARVEST_KILL_ENV];
  else process.env[HARVEST_KILL_ENV] = prevKill;
});

describe('boundInsight — pure title/body split + bounds', () => {
  it('returns null for a blank / whitespace-only insight', () => {
    expect(boundInsight('')).toBeNull();
    expect(boundInsight('   \n\t ')).toBeNull();
  });

  it('a short single-line insight lives entirely in the title (no body)', () => {
    expect(boundInsight('claimHold releases on a cold recycle')).toEqual({
      title: 'claimHold releases on a cold recycle',
    });
  });

  it('a multi-line insight titles on the first line and keeps the full text as body', () => {
    const out = boundInsight('the guard fails open on a dims mismatch\nbecause harrier is 1024 not 384');
    expect(out?.title).toBe('the guard fails open on a dims mismatch');
    expect(out?.body).toBe('the guard fails open on a dims mismatch\nbecause harrier is 1024 not 384');
  });

  it('truncates an over-long title and body with an ellipsis', () => {
    // First line short (→ title carries it), then a long body that exceeds the body cap.
    const out = boundInsight(`headline that is a bit long ${'-'.repeat(140)}\n${'x'.repeat(2000)}`);
    expect(out?.title.length).toBeLessThanOrEqual(MAX_TITLE_CHARS);
    expect(out?.title.endsWith('…')).toBe(true);
    expect((out?.body ?? '').length).toBeLessThanOrEqual(MAX_INSIGHT_CHARS);
    expect(out?.body?.endsWith('…')).toBe(true);
  });
});

describe('pickLexicalCoalesce — pure verbatim-repeat detection', () => {
  const recent: RecentHarvest[] = [
    { id: 'EI-1', title: 'the sidecar answers in ~10ms when warm' },
    { id: 'EI-2', title: 'cold model load forfeits this read' },
  ];
  it('matches a verbatim / near-verbatim repeat above threshold', () => {
    expect(pickLexicalCoalesce('the sidecar answers in ~10ms when warm', recent)).toBe('EI-1');
  });
  it('returns null when nothing crosses the threshold', () => {
    expect(pickLexicalCoalesce('a completely unrelated durable discovery', recent)).toBeNull();
  });
  it('picks the highest-similarity recent row', () => {
    const rows: RecentHarvest[] = [
      { id: 'EI-a', title: 'the guard fails open on a dims mismatch today' },
      { id: 'EI-b', title: 'the guard fails open on a dims mismatch' },
    ];
    expect(pickLexicalCoalesce('the guard fails open on a dims mismatch', rows)).toBe('EI-b');
  });
});

describe('pickSemanticCoalesce — pure guard-verdict scoping', () => {
  it('coalesces only a hard hit that is one of the agent’s recent harvest ids', () => {
    expect(pickSemanticCoalesce([{ id: 'EI-9' }], new Set(['EI-9', 'EI-1']))).toBe('EI-9');
  });
  it('ignores a hard hit that is NOT a recent harvest row (unrelated open work-item)', () => {
    expect(pickSemanticCoalesce([{ id: 'WI-999' }], new Set(['EI-1']))).toBeNull();
  });
  it('returns null on no hard hits', () => {
    expect(pickSemanticCoalesce([], new Set(['EI-1']))).toBeNull();
  });
});

describe('classifyClaimStrength — pure lexical hedge/confirm classifier (EI-9941)', () => {
  it('classifies an explicit hedge as hypothesis', () => {
    expect(classifyClaimStrength('I suspect the keypair regen is the cause, unconfirmed')).toBe('hypothesis');
    expect(classifyClaimStrength('this is just a hypothesis at this point')).toBe('hypothesis');
    expect(classifyClaimStrength('candidate root cause: the merge cursor')).toBe('hypothesis');
  });
  it('classifies an explicit confirm marker as verified', () => {
    expect(classifyClaimStrength('confirmed via on-disk evidence: mtime unchanged')).toBe('verified');
    expect(classifyClaimStrength('landed + green, tested green on staging')).toBe('verified');
  });
  it('defaults to unspecified — a bare declarative claim (the EI-9881 failure mode) is NOT auto-verified', () => {
    expect(classifyClaimStrength('keypair-regen is the converged root cause of the replication stall')).toBe('unspecified');
  });
  it('prefers hypothesis when both hedge and confirm markers appear (conservative)', () => {
    expect(classifyClaimStrength('I confirmed the guess: possibly the merge cursor')).toBe('hypothesis');
  });
});

describe('applyClaimStrengthPrefix — pure title stamping (EI-9941)', () => {
  it('prefixes a hypothesis / verified title and leaves unspecified untouched', () => {
    expect(applyClaimStrengthPrefix('the merge cursor never advances', 'hypothesis')).toBe('[hypothesis] the merge cursor never advances');
    expect(applyClaimStrengthPrefix('the merge cursor never advances', 'verified')).toBe('[verified] the merge cursor never advances');
    expect(applyClaimStrengthPrefix('the merge cursor never advances', 'unspecified')).toBe('the merge cursor never advances');
  });
  it('is idempotent — does not double-prefix an already-prefixed title', () => {
    expect(applyClaimStrengthPrefix('[hypothesis] X', 'hypothesis')).toBe('[hypothesis] X');
  });
  it('re-bounds to MAX_TITLE_CHARS so the prefix never pushes the total over the cap', () => {
    const long = 'x'.repeat(MAX_TITLE_CHARS);
    const out = applyClaimStrengthPrefix(long, 'hypothesis');
    expect(out.length).toBeLessThanOrEqual(MAX_TITLE_CHARS);
    expect(out.startsWith('[hypothesis] ')).toBe(true);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('isRefutation — pure refutation-signal classifier (EI-9941)', () => {
  it('detects refutation language', () => {
    expect(isRefutation('withdrawing the keypair hypothesis, already refuted on-disk')).toBe(true);
    expect(isRefutation('ruled out: not the root cause')).toBe(true);
    expect(isRefutation('that was a dead end')).toBe(true);
  });
  it('does not flag an unrelated / confirming statement', () => {
    expect(isRefutation('confirmed the merge cursor never advances')).toBe(false);
    expect(isRefutation('a durable claimHold discovery worth a future agent')).toBe(false);
  });
});

describe('harvestInsight — impure leg (fail-open, coalesce, source-tag)', () => {
  const base = {
    insight: 'a durable claimHold discovery worth a future agent',
    createdBy: 'su-01293',
    source: 'loop-checkpoint' as const,
    filedByRole: 'su',
    ref: 'loop:checkpoint',
    sourceHive: 'papercusp',
    harness: 'papercusp',
  };

  it('files a fresh insight as a source-tagged lane:observation with attribution', async () => {
    const deps = makeDeps({ recent: [], created: true, issueId: 'EI-100' });
    const res = await harvestInsight(base, deps);
    expect(res).toEqual({ filed: true, issueId: 'EI-100' });
    expect(deps.capture).toHaveBeenCalledTimes(1);
    const arg = deps.capture.mock.calls[0][0];
    expect(arg.lane).toBe('observation');
    expect(arg.createdBy).toBe('su-01293');
    expect(arg.filedByRole).toBe('su');
    expect(arg.scope).toBe('harness:papercusp');
    expect(arg.payloadExtra.origin).toBe(HARVEST_ORIGIN);
    expect(arg.payloadExtra.harvestSource).toBe('loop-checkpoint');
    expect(arg.payloadExtra.observation).toEqual({ refs: ['loop:checkpoint'], sourceHive: 'papercusp' });
    // EI-9941: a bare declarative insight (no hedge/confirm marker) files UNPREFIXED
    // but still carries the machine-queryable claim-strength + provenance.
    expect(arg.title).toBe(base.insight);
    expect(arg.payloadExtra.claimStrength).toBe('unspecified');
    expect(arg.payloadExtra.provenance).toEqual({ statedBy: 'su-01293', source: 'loop-checkpoint', filedByRole: 'su' });
  });

  it('EI-9941: prefixes the filed title when the insight carries an explicit hedge', async () => {
    const deps = makeDeps({ recent: [], issueId: 'EI-200' });
    const res = await harvestInsight({ ...base, insight: 'I suspect this is the root cause, unconfirmed' }, deps);
    expect(res).toEqual({ filed: true, issueId: 'EI-200' });
    const arg = deps.capture.mock.calls[0][0];
    expect(arg.title).toBe('[hypothesis] I suspect this is the root cause, unconfirmed');
    expect(arg.payloadExtra.claimStrength).toBe('hypothesis');
  });

  // A CLAIM ref — the only ref refutation propagation may fire through (EI-10593).
  const claimRef = { ...base, ref: 'wi:WI-4070', source: 'work-item-completion' as const };

  it('EI-9941: a refutation flags every prior harvested row tagged with the same CLAIM ref, then still files its own observation', async () => {
    const deps = makeDeps({
      recent: [],
      issueId: 'EI-300',
      byRef: [{ id: 'EI-9881', title: 'keypair-regen is the converged root cause' }],
    });
    const res = await harvestInsight(
      { ...claimRef, insight: 'Withdrawing the keypair hypothesis — already refuted on-disk (mtime unchanged)' },
      deps,
    );
    expect(res).toEqual({ filed: true, issueId: 'EI-300' });
    expect(deps.findByRef).toHaveBeenCalledWith('wi:WI-4070', 'papercusp');
    expect(deps.flagRefuted).toHaveBeenCalledTimes(1);
    expect(deps.flagRefuted.mock.calls[0][0]).toBe('EI-9881');
    expect(deps.flagRefuted.mock.calls[0][1]).toMatchObject({ by: 'su-01293' });
    // The refutation's own observation still gets filed (never suppressed).
    expect(deps.capture).toHaveBeenCalledTimes(1);
  });

  // ---------------------------------------------------------------------------
  // EI-10593 — THE REGRESSION THAT ACTUALLY HAPPENED. The pre-fix test asserted
  // findByRef was called with 'loop:checkpoint' and handed the mock ONE perfectly
  // on-topic prior row — so it proved the plumbing and was blind to the fact that the
  // real query, joined on a ref every agent's every checkpoint shares, returns 20
  // unrelated rows belonging to other agents. It flagged 40 true observations across
  // 11 authors, and propagated 0 true refutations, before anyone noticed.
  //
  // Mocking a selector cannot reveal a selector that does not select. So these guards
  // assert the DECISION (does it propagate at all?), never the call plumbing.
  // ---------------------------------------------------------------------------

  it('EI-10593: a refutation on the loop:checkpoint SOURCE TAG propagates NOTHING — the ref names no claim', async () => {
    const deps = makeDeps({
      recent: [],
      issueId: 'EI-303',
      // What the live query would really return for this ref: other agents' unrelated rows.
      byRef: [
        { id: 'EI-10356', title: 'the privacy surface is complete 5/5' },
        { id: 'EI-10384', title: 'the repo secrets-guard hook blocks literal credential shapes' },
      ],
    });
    const res = await harvestInsight(
      { ...base, insight: 'AGE graph recall: ruled out, a dead end — the benchmark verdict is REJECT' },
      deps,
    );
    // The refutation's own observation still files — only the PROPAGATION is withheld.
    expect(res).toEqual({ filed: true, issueId: 'EI-303' });
    expect(deps.findByRef).not.toHaveBeenCalled();
    expect(deps.flagRefuted).not.toHaveBeenCalled();
  });

  it('EI-10593: isClaimIdentifyingRef — only a ref that NAMES a claim opens the destructive path', () => {
    expect(isClaimIdentifyingRef('wi:WI-4070')).toBe(true);
    expect(isClaimIdentifyingRef('wi:EI-10593')).toBe(true);
    // Source tags: shared by every agent's every checkpoint ⇒ zero entropy ⇒ never.
    expect(isClaimIdentifyingRef('loop:checkpoint')).toBe(false);
    expect(isClaimIdentifyingRef('work-item-completion')).toBe(false);
    // Unknown shapes fail CLOSED — an allowlist, so a future ref cannot silently
    // re-open a cross-agent destructive write by simply being unrecognized.
    expect(isClaimIdentifyingRef('wi:')).toBe(false);
    expect(isClaimIdentifyingRef('plan:some-slug-2026-07-12')).toBe(false);
    expect(isClaimIdentifyingRef('')).toBe(false);
    expect(isClaimIdentifyingRef(undefined)).toBe(false);
  });

  it('EI-10593: the gate is on the REF, not on the wording — a claim ref still propagates the same insight', async () => {
    // Same refutation text as the source-tag case above; only the ref differs. This is
    // what proves the gate discriminates on the selector rather than on the prose.
    const deps = makeDeps({ recent: [], issueId: 'EI-304', byRef: [{ id: 'EI-9881', title: 'x' }] });
    await harvestInsight(
      { ...claimRef, insight: 'AGE graph recall: ruled out, a dead end — the benchmark verdict is REJECT' },
      deps,
    );
    expect(deps.flagRefuted).toHaveBeenCalledTimes(1);
    expect(deps.flagRefuted.mock.calls[0][0]).toBe('EI-9881');
  });

  it('EI-9941: does not probe for refutation targets when there is no ref', async () => {
    const { ref: _ref, ...noRef } = base;
    const deps = makeDeps({ recent: [], issueId: 'EI-301' });
    await harvestInsight({ ...noRef, insight: 'this claim was refuted on-disk' }, deps);
    expect(deps.findByRef).not.toHaveBeenCalled();
  });

  it('EI-9941: a flagRefuted failure fails open — the new observation still files', async () => {
    const deps = makeDeps({ recent: [], issueId: 'EI-302', byRef: [{ id: 'EI-9881', title: 'x' }] });
    deps.flagRefuted.mockRejectedValueOnce(new Error('PG down'));
    const res = await harvestInsight({ ...claimRef, insight: 'ruled out: not the root cause after all' }, deps);
    expect(res).toEqual({ filed: true, issueId: 'EI-302' });
  });

  it('coalesces a lexical (verbatim consecutive-wake) repeat — does NOT file', async () => {
    const deps = makeDeps({ recent: [{ id: 'EI-7', title: base.insight }] });
    const res = await harvestInsight(base, deps);
    expect(res).toEqual({ filed: false, reason: 'coalesced', coalescedWith: 'EI-7' });
    expect(deps.capture).not.toHaveBeenCalled();
  });

  it('coalesces a re-WORDED repeat via the semantic guard, scoped to the harvest set', async () => {
    // A recent row whose TITLE does not lexically match (so the lexical pass misses),
    // but the guard returns it as a hard hit ⇒ coalesce.
    const deps = makeDeps({ recent: [{ id: 'EI-42', title: 'totally different wording here' }], hard: ['EI-42'] });
    const res = await harvestInsight(base, deps);
    expect(res).toEqual({ filed: false, reason: 'coalesced', coalescedWith: 'EI-42' });
    expect(deps.capture).not.toHaveBeenCalled();
  });

  it('files when the semantic hard hit is NOT one of the agent’s harvest rows', async () => {
    const deps = makeDeps({ recent: [{ id: 'EI-42', title: 'totally different wording' }], hard: ['WI-unrelated'], issueId: 'EI-101' });
    const res = await harvestInsight(base, deps);
    expect(res).toEqual({ filed: true, issueId: 'EI-101' });
    expect(deps.capture).toHaveBeenCalledTimes(1);
  });

  it('fails open to a file when loadRecent throws (recent treated as empty)', async () => {
    const deps = makeDeps({ loadThrows: true, issueId: 'EI-102' });
    const res = await harvestInsight(base, deps);
    expect(res).toEqual({ filed: true, issueId: 'EI-102' });
  });

  it('returns { filed:false, reason:error } — never throws — when capture throws', async () => {
    const deps = makeDeps({ captureThrows: true });
    await expect(harvestInsight(base, deps)).resolves.toEqual({ filed: false, reason: 'error' });
  });

  it('reports not-created when the capture declined (created:false)', async () => {
    const deps = makeDeps({ created: false });
    expect(await harvestInsight(base, deps)).toEqual({ filed: false, reason: 'not-created' });
  });

  it('skips a blank insight (no capture)', async () => {
    const deps = makeDeps({});
    expect(await harvestInsight({ ...base, insight: '   ' }, deps)).toEqual({ filed: false, reason: 'blank' });
    expect(deps.capture).not.toHaveBeenCalled();
  });

  it('honors the PAPERCUSP_SU_CHECKPOINT_HARVEST=off kill switch even with deps', async () => {
    process.env[HARVEST_KILL_ENV] = 'off';
    const deps = makeDeps({});
    expect(await harvestInsight(base, deps)).toEqual({ filed: false, reason: 'disabled' });
    expect(deps.capture).not.toHaveBeenCalled();
  });

  it('is VITEST-inert (no deps injected) — never touches the real embedder/PG', async () => {
    expect(await harvestInsight(base)).toEqual({ filed: false, reason: 'vitest-inert' });
  });
});
