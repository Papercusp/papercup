import { describe, it, expect, vi } from 'vitest';

import {
  attributeKinds,
  toJudgeCandidates,
  parseContradictionVerdict,
  runContradictionLeg,
  createGatewayContradictionJudge,
  DOC_CONTRADICTION_JUDGE_MODEL,
} from './doc-contradiction-scan';
import { ANTHROPIC_JUDGE_MODEL } from '../memory/anthropic-judge';
import type { DocOverlapFinding, DocSectionRef } from './doc-section-overlap';
import type { JudgeSection } from './doc-contradiction-judge';

const ref = (slug: string, anchor = '', sourceKey = 'papercusp-guidance'): DocSectionRef => ({
  sourceKey,
  slug,
  anchor,
});

const finding = (
  a: string,
  b: string,
  refA: DocSectionRef,
  refB: DocSectionRef,
  similarity = 0.99,
): DocOverlapFinding => ({
  a,
  b,
  groupA: `${refA.sourceKey}::${refA.slug}`,
  groupB: `${refB.sourceKey}::${refB.slug}`,
  similarity,
  refA,
  refB,
  sameSource: refA.sourceKey === refB.sourceKey,
  appliedThreshold: 0.88,
});

describe('attributeKinds', () => {
  it('attaches a kind to every finding without dropping any', () => {
    const findings = [
      finding('id-a', 'id-b', ref('prompts/x'), ref('prompts/y')),
      finding('id-c', 'id-d', ref('tool-guidance/z'), ref('harness/memory', '', 'papercusp-engineering')),
    ];
    const kinded = attributeKinds(
      findings,
      new Map([
        ['id-a', 'Shared block › Tone'],
        ['id-b', 'Shared block › Tone'],
        ['id-c', 'Tool guidance: z › When'],
        ['id-d', 'Memory › Choosing the right layer'],
      ]),
    );
    expect(kinded).toHaveLength(2);
    expect(kinded[0].kind).toBe('rehomed-copy');
    expect(kinded[1].kind).toBe('cross-kind');
    // The deterministic leg's own fields survive intact.
    expect(kinded[0].similarity).toBe(0.99);
    expect(kinded[0].appliedThreshold).toBe(0.88);
  });

  it('a MISSING title degrades the verdict — it never manufactures a confident copy', () => {
    // Two absent titles are two absences, not evidence of a shared origin.
    const kinded = attributeKinds([finding('id-a', 'id-b', ref('prompts/x'), ref('prompts/y'))], new Map());
    expect(kinded[0].kind).not.toBe('rehomed-copy');
    expect(kinded[0].confident).toBe(false);
  });
});

describe('toJudgeCandidates', () => {
  it('carries similarity and kind through to the judged leg', () => {
    const kinded = attributeKinds(
      [finding('id-a', 'id-b', ref('prompts/x'), ref('prompts/y'), 0.93)],
      new Map([
        ['id-a', 'T › S'],
        ['id-b', 'T › S'],
      ]),
    );
    expect(toJudgeCandidates(kinded)).toEqual([
      { a: 'id-a', b: 'id-b', similarity: 0.93, kind: 'rehomed-copy' },
    ]);
  });
});

describe('parseContradictionVerdict', () => {
  it('parses a clean JSON verdict', () => {
    expect(parseContradictionVerdict('{"contradicts": true, "reason": "A says X, B says not-X"}')).toEqual({
      contradicts: true,
      reason: 'A says X, B says not-X',
    });
  });

  it('parses JSON embedded in prose or a fenced block', () => {
    expect(
      parseContradictionVerdict('Sure!\n```json\n{"contradicts": false, "reason": ""}\n```\n'),
    ).toEqual({ contradicts: false, reason: '' });
  });

  it('returns NULL for anything not recognisably a verdict — never a false "no"', () => {
    // An unparseable answer is a judge ERROR. Coercing it to
    // `{contradicts:false}` is exactly how an inert judge reads as a clean
    // corpus, which is the failure this whole leg is built around.
    expect(parseContradictionVerdict('I cannot determine that.')).toBeNull();
    expect(parseContradictionVerdict('{"reason": "no boolean here"}')).toBeNull();
    expect(parseContradictionVerdict('{ not json at all }')).toBeNull();
    expect(parseContradictionVerdict('')).toBeNull();
    expect(parseContradictionVerdict(undefined as unknown as string)).toBeNull();
  });

  it('tolerates a missing reason on a positive verdict without discarding it', () => {
    expect(parseContradictionVerdict('{"contradicts": true}')).toEqual({ contradicts: true, reason: '' });
  });
});

describe('createGatewayContradictionJudge', () => {
  it('returns NULL with no credential — it never answers "no contradiction"', async () => {
    // The counterpart of `createAnthropicJudge`'s silent no-op, inverted on
    // purpose: that one returns an empty finding set indistinguishable from a
    // healthy result (EI-18746586784230719). This returns null, which the
    // judged leg counts as an error and refuses to call clean.
    const judge = createGatewayContradictionJudge({ apiKey: '' });
    const section = (id: string): JudgeSection => ({ id, title: id, content: id });
    await expect(judge({ a: section('a'), b: section('b') })).resolves.toBeNull();
  });

  it('asks the same live model as the memory judge, never a retired Claude 3.x id (WI-10004165)', () => {
    // The judge pinned claude-3-5-haiku-latest after it was retired: every call
    // 404'd into a null, so the leg could never find anything on any host.
    expect(DOC_CONTRADICTION_JUDGE_MODEL).toBe(ANTHROPIC_JUDGE_MODEL);
    expect(DOC_CONTRADICTION_JUDGE_MODEL).not.toMatch(/^claude-3/);
  });
});

describe('runContradictionLeg', () => {
  const findings = [
    finding('id-a', 'id-b', ref('prompts/x'), ref('prompts/y'), 0.99),
    finding('id-c', 'id-d', ref('tool-guidance/z'), ref('tool-guidance/w'), 0.90),
  ];
  const titles = new Map([
    ['id-a', 'Shared › Tone'],
    ['id-b', 'Shared › Tone'],
    ['id-c', 'Tool guidance: z › Chaining'],
    ['id-d', 'Tool guidance: w › Chaining'],
  ]);
  const sections = new Map<string, JudgeSection>(
    ['id-a', 'id-b', 'id-c', 'id-d'].map((id) => [id, { id, title: id, content: `body ${id}` }]),
  );

  it('kinds EVERY finding but only judges the pairs above the judge threshold', async () => {
    const judge = vi.fn(async () => ({ contradicts: false, reason: '' }));
    const { kinded, report } = await runContradictionLeg({
      findings,
      judgeThreshold: 0.95,
      maxJudged: 10,
      deps: {
        enabled: async () => true,
        judgeAvailable: () => true,
        loadTitles: async () => titles,
        loadSections: async () => sections,
        judge,
      },
    });
    // Kinds are free and the report buckets on them, so every finding gets one.
    expect(kinded).toHaveLength(2);
    expect(kinded.map((k) => k.kind)).toEqual(['rehomed-copy', 'sibling-surface']);
    // Only the 0.99 pair costs a call — cheap by construction.
    expect(judge).toHaveBeenCalledTimes(1);
    expect(report.census.candidatesIn).toBe(2);
    expect(report.census.eligible).toBe(1);
    expect(report.inconclusive).toBeNull();
  });

  it('a DISABLED flag still kinds the findings, and reports inconclusive', async () => {
    const judge = vi.fn();
    const { kinded, report } = await runContradictionLeg({
      findings,
      judgeThreshold: 0.95,
      maxJudged: 10,
      deps: {
        enabled: async () => false,
        judgeAvailable: () => true,
        loadTitles: async () => titles,
        loadSections: async () => sections,
        judge,
      },
    });
    // The deterministic half of the leg is unaffected by the LLM flag.
    expect(kinded).toHaveLength(2);
    expect(judge).not.toHaveBeenCalled();
    expect(report.inconclusive).toMatch(/DISABLED/);
  });

  it('propagates a contradiction with its kind attached', async () => {
    const { report } = await runContradictionLeg({
      findings,
      judgeThreshold: 0.95,
      maxJudged: 10,
      deps: {
        enabled: async () => true,
        judgeAvailable: () => true,
        loadTitles: async () => titles,
        loadSections: async () => sections,
        judge: async () => ({ contradicts: true, reason: 'A mandates, B forbids' }),
      },
    });
    expect(report.contradictions).toHaveLength(1);
    expect(report.contradictions[0].kind).toBe('rehomed-copy');
    expect(report.contradictions[0].reason).toBe('A mandates, B forbids');
  });
});
