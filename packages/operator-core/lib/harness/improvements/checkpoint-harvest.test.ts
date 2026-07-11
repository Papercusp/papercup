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
  HARVEST_ORIGIN,
  HARVEST_KILL_ENV,
  MAX_INSIGHT_CHARS,
  MAX_TITLE_CHARS,
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
} = {}): HarvestDeps & {
  capture: ReturnType<typeof vi.fn>;
  loadRecent: ReturnType<typeof vi.fn>;
  findSemanticDupes: ReturnType<typeof vi.fn>;
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
  return { capture, loadRecent, findSemanticDupes };
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
