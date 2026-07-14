/** residual-carry-pass (P-019): the transitional residual-LLM pass (interactive-
 *  only, ≤4K, provenance-tagging prompt, fail-soft) + the per-class miss-rate gate
 *  that recommends retiring the pass (→ unblocks P-022). Pure cores; live legs
 *  (maintenance-lane call + sampling harness) deferred to Phase-7 drills. */
import { describe, it, expect, vi } from 'vitest';
import {
  RESIDUAL_MAX_TOKENS,
  DEFAULT_MISS_RATE_PARAMS,
  buildResidualPassPrompt,
  parseResidualResponse,
  runResidualCarryPass,
  scoreResidualMissRate,
  type MissRateSample,
  type ResidualLlmFn,
} from './residual-carry-pass';

const json = (findings: unknown[]) => JSON.stringify({ findings });
const stubLlm = (reply: string): ResidualLlmFn => vi.fn(async () => reply);

describe('buildResidualPassPrompt — pure', () => {
  it('embeds stage-1 and dropped context and the strict-JSON provenance contract', () => {
    const p = buildResidualPassPrompt('STAGE ONE DOC', 'DROPPED RAW TURNS');
    expect(p).toContain('STAGE ONE DOC');
    expect(p).toContain('DROPPED RAW TURNS');
    expect(p).toContain('"provenance":"owner|self-imposed|peer|inferred|unknown"');
    // Measures completeness, never provenance — stage-1's ledger tags are authoritative.
    expect(p).toContain("Do NOT dispute STAGE-1's provenance tags");
    // The one live channel the stage-0 audit found.
    expect(p).toContain('owner directives/claims present in DROPPED CONTEXT');
  });
});

describe('parseResidualResponse — pure, tolerant', () => {
  it('parses a well-formed material finding', () => {
    const out = parseResidualResponse(
      json([{ text: 'owner said ship friday', provenance: 'owner', anchor: 'ship it friday', material: true }]),
    );
    expect(out).toEqual([
      { text: 'owner said ship friday', provenance: 'owner', anchor: 'ship it friday', material: true },
    ]);
  });

  it('strips a ```json fence and surrounding prose', () => {
    const raw = 'Here is the audit:\n```json\n' + json([{ text: 'x', material: true }]) + '\n```\ndone';
    const out = parseResidualResponse(raw);
    expect(out).toHaveLength(1);
    expect(out![0].text).toBe('x');
  });

  it('treats {"findings":[]} and {} as "stage-1 complete" (empty, not error)', () => {
    expect(parseResidualResponse('{"findings":[]}')).toEqual([]);
    expect(parseResidualResponse('{}')).toEqual([]);
  });

  it('normalizes an unknown provenance token and defaults a missing one to unknown', () => {
    const out = parseResidualResponse(
      json([
        { text: 'a', provenance: 'BOSS', material: true },
        { text: 'b', material: true },
      ]),
    );
    expect(out!.map((f) => f.provenance)).toEqual(['unknown', 'unknown']);
  });

  it('materiality defaults true when absent and is false ONLY on explicit false', () => {
    const out = parseResidualResponse(
      json([
        { text: 'implicit' },
        { text: 'explicit-false', material: false },
        { text: 'garbled', material: 'nope' },
      ]),
    );
    expect(out!.map((f) => f.material)).toEqual([true, false, true]);
  });

  it('nulls a blank/missing anchor and drops empty-text findings', () => {
    const out = parseResidualResponse(
      json([
        { text: '   ', material: true },
        { text: 'keep', anchor: '   ', material: true },
      ]),
    );
    expect(out).toHaveLength(1);
    expect(out![0]).toMatchObject({ text: 'keep', anchor: null });
  });

  it('returns null (⇒ parseError) on non-JSON and on a non-array findings field', () => {
    expect(parseResidualResponse('the model refused')).toBeNull();
    expect(parseResidualResponse('{"findings":"nope"}')).toBeNull();
    expect(parseResidualResponse('')).toBeNull();
  });
});

describe('runResidualCarryPass — interactive-only, fail-soft', () => {
  it('SKIPS a non-interactive session and never calls the LLM', async () => {
    const llm = stubLlm(json([]));
    const out = await runResidualCarryPass({
      sessionClass: 'omp-drone',
      interactive: false,
      stage1Doc: 's',
      droppedContext: 'd',
      llmFn: llm,
    });
    expect(out).toMatchObject({ ran: false, skippedReason: 'non-interactive', material: false, parseError: false });
    expect(llm).not.toHaveBeenCalled();
  });

  it('flags a material stage-1 miss from a valid response', async () => {
    const out = await runResidualCarryPass({
      sessionClass: 'claude-interactive',
      interactive: true,
      stage1Doc: 's',
      droppedContext: 'd',
      llmFn: stubLlm(json([{ text: 'dropped owner gate', provenance: 'owner', material: true }])),
    });
    expect(out.ran).toBe(true);
    expect(out.material).toBe(true);
    expect(out.parseError).toBe(false);
    expect(out.findings).toHaveLength(1);
    expect(out.promptChars).toBeGreaterThan(0);
  });

  it('reports no miss when the pass returns an empty findings array', async () => {
    const out = await runResidualCarryPass({
      sessionClass: 'claude-interactive',
      interactive: true,
      stage1Doc: 's',
      droppedContext: 'd',
      llmFn: stubLlm(json([])),
    });
    expect(out.material).toBe(false);
    expect(out.findings).toEqual([]);
    expect(out.parseError).toBe(false);
  });

  it('clamps maxTokens to ≤ RESIDUAL_MAX_TOKENS and threads sessionClass to the seam', async () => {
    const llm = vi.fn(async () => json([]));
    await runResidualCarryPass({
      sessionClass: 'claude-interactive',
      interactive: true,
      stage1Doc: 's',
      droppedContext: 'd',
      maxTokens: 10_000,
      llmFn: llm,
    });
    expect(llm).toHaveBeenCalledWith(
      expect.any(String),
      { maxTokens: RESIDUAL_MAX_TOKENS, sessionClass: 'claude-interactive' },
    );
  });

  it('a throwing LLM ⇒ parseError, ran:true, no throw, never blocks the compaction', async () => {
    const out = await runResidualCarryPass({
      sessionClass: 'claude-interactive',
      interactive: true,
      stage1Doc: 's',
      droppedContext: 'd',
      llmFn: vi.fn(async () => {
        throw new Error('maintenance lane 503');
      }),
    });
    expect(out).toMatchObject({ ran: true, parseError: true, material: false });
    expect(out.findings).toEqual([]);
  });

  it('an unparseable response ⇒ parseError (a blind boundary, not a false "no miss")', async () => {
    const out = await runResidualCarryPass({
      sessionClass: 'claude-interactive',
      interactive: true,
      stage1Doc: 's',
      droppedContext: 'd',
      llmFn: stubLlm('I could not complete the audit.'),
    });
    expect(out.parseError).toBe(true);
    expect(out.material).toBe(false);
  });
});

describe('scoreResidualMissRate — per-class retirement gate', () => {
  const clean = (cls: string, n: number): MissRateSample[] =>
    Array.from({ length: n }, () => ({ sessionClass: cls, material: false }));

  it('recommends retirement for a class with ≥minSample parsed samples and zero misses', () => {
    const rep = scoreResidualMissRate(clean('claude-interactive', 30));
    const c = rep.perClass.find((x) => x.sessionClass === 'claude-interactive')!;
    expect(c).toMatchObject({ n: 30, materialCount: 0, errorCount: 0, missRate: 0, retire: true });
    expect(rep.retirableClasses).toEqual(['claude-interactive']);
  });

  it('does NOT retire below minSample even with zero misses', () => {
    const rep = scoreResidualMissRate(clean('claude-interactive', 29));
    expect(rep.perClass[0].retire).toBe(false);
    expect(rep.retirableClasses).toEqual([]);
  });

  it('does NOT retire a class with a material miss (miss-rate > epsilon=0)', () => {
    const samples = [...clean('claude-interactive', 40), { sessionClass: 'claude-interactive', material: true }];
    const rep = scoreResidualMissRate(samples);
    const c = rep.perClass[0];
    expect(c.materialCount).toBe(1);
    expect(c.missRate).toBeCloseTo(1 / 41);
    expect(c.retire).toBe(false);
  });

  it('excludes parseErrors from the miss-rate denominator but counts them as blind', () => {
    const samples: MissRateSample[] = [
      ...clean('c', 20),
      ...Array.from({ length: 4 }, () => ({ sessionClass: 'c', material: false, parseError: true })),
    ];
    const rep = scoreResidualMissRate(samples, { epsilon: 0, minSample: 20, maxErrorFraction: 0.1 });
    const c = rep.perClass[0];
    expect(c.n).toBe(24);
    expect(c.errorCount).toBe(4);
    expect(c.missRate).toBe(0); // 0 material / 20 parsed
    // 4/24 = 16.7% error fraction > 10% ⇒ blind ⇒ no retirement despite 0 miss-rate.
    expect(c.retire).toBe(false);
  });

  it('drops skipped (ran:false) samples entirely', () => {
    const samples: MissRateSample[] = [
      ...clean('c', 30),
      ...Array.from({ length: 100 }, () => ({ sessionClass: 'c', material: true, ran: false })),
    ];
    const rep = scoreResidualMissRate(samples);
    const c = rep.perClass[0];
    expect(c.n).toBe(30);
    expect(c.retire).toBe(true);
  });

  it('a class with only parseErrors has missRate 1 (unknown) and never retires', () => {
    const samples: MissRateSample[] = Array.from({ length: 50 }, () => ({
      sessionClass: 'blind',
      material: false,
      parseError: true,
    }));
    const rep = scoreResidualMissRate(samples);
    const c = rep.perClass[0];
    expect(c.missRate).toBe(1);
    expect(c.retire).toBe(false);
  });

  it('honors a custom epsilon that tolerates a small nonzero rate', () => {
    const samples = [...clean('c', 99), { sessionClass: 'c', material: true }];
    const strict = scoreResidualMissRate(samples); // epsilon 0
    const lenient = scoreResidualMissRate(samples, { epsilon: 0.02, minSample: 30, maxErrorFraction: 0.1 });
    expect(strict.perClass[0].retire).toBe(false); // 1/100 = 0.01 > 0
    expect(lenient.perClass[0].retire).toBe(true); // 0.01 ≤ 0.02
  });

  it('aggregates and sorts multiple classes independently', () => {
    const rep = scoreResidualMissRate([
      ...clean('zeta', 30),
      ...clean('alpha', 5),
      { sessionClass: 'alpha', material: true },
    ]);
    expect(rep.perClass.map((c) => c.sessionClass)).toEqual(['alpha', 'zeta']);
    expect(rep.retirableClasses).toEqual(['zeta']);
  });

  it('exposes the documented default gate params', () => {
    expect(DEFAULT_MISS_RATE_PARAMS).toEqual({ epsilon: 0, minSample: 30, maxErrorFraction: 0.1 });
  });
});
