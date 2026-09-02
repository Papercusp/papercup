import { describe, expect, it } from 'vitest';
import {
  MIN_REQUIREMENT_QUOTE_CHARS,
  requirementDispositionShortfall,
} from './requirement-disposition';

/**
 * P-021 / D-014. The properties under test are the two the design rests on:
 *
 *   1. VERBATIM, not paraphrase — the substring test is the whole mechanism, because it
 *      converts silent narrowing from something a reviewer must notice into something a
 *      string comparison catches.
 *   2. FAIL-OPEN — every ambiguity resolves to "cannot judge", because a false shortfall
 *      teaches the fleet the signal is noise while a false clean verdict merely leaves
 *      today's behaviour in place. The two errors are not symmetric.
 */

// A realistic originating body: long enough to state requirements (>= MIN_SOURCE_CHARS),
// and deliberately LINE-WRAPPED, because an honest quote spanning a wrap is the case a
// naive substring test would call fabricated.
const SOURCE = [
  'Bind `testResult` to a real `test_runs` row via the already-stamped',
  'PAPERCUSP_TEST_RUN_GROUP, and require that run to be a PASS. Today any non-empty',
  'string satisfies the check, including "3 failed". The resolution must be generous:',
  'only the agent\'s most recent run is judged, and a window resolving to more than one',
  'run group is refused outright because no column says which group is ours.',
].join('\n');

// Deliberately NOT `as const`: that widens to a readonly tuple, which is not assignable
// to the schema's mutable `filesChanged?: string[]`.
const CODE_SHAPED = { filesChanged: ['packages/operator-core/lib/thing.ts'] };

const probe = (files: string[] = []) => ({
  repoRoots: ['/repo'],
  exists: (abs: string) => files.some((f) => abs === `/repo/${f}`),
});

describe('the ABSENT check is scoped to the self-contradictory population (D-019)', () => {
  const deferredClose = { sourceText: SOURCE, declaresDeferredWork: true, probe: probe() };

  it('fires when a close declares deferred work but says which part of the ask was left', () => {
    expect(requirementDispositionShortfall(CODE_SHAPED, deferredClose)?.kind).toBe('absent');
  });

  it('stays silent when the close declares NO deferred work', () => {
    // The whole scoping decision: demanding a disposition from every code-shaped close
    // would reclassify 2,053 closes/week, which is a policy call and not a coherence
    // check. Only a close that contradicts itself is judged.
    expect(
      requirementDispositionShortfall(CODE_SHAPED, { ...deferredClose, declaresDeferredWork: false }),
    ).toBeUndefined();
  });

  it('stays silent for a close that names no files — not the population D-014 is about', () => {
    expect(requirementDispositionShortfall({ verifiedHow: 'unit' }, deferredClose)).toBeUndefined();
  });

  it('stays silent when the originating body is too thin to state a requirement', () => {
    // Demanding a quote from a title-only item would not produce evidence, it would
    // produce FABRICATED evidence — the failure `filesChanged` already exhibits.
    expect(
      requirementDispositionShortfall(CODE_SHAPED, { ...deferredClose, sourceText: 'Fix the thing.' }),
    ).toBeUndefined();
    expect(
      requirementDispositionShortfall(CODE_SHAPED, { ...deferredClose, sourceText: null }),
    ).toBeUndefined();
  });
});

describe('the VERBATIM test is what catches silent narrowing', () => {
  const opts = { sourceText: SOURCE, probe: probe(['thing.ts']) };

  it('accepts a literal span even when it spans a line wrap in the source', () => {
    // Whitespace is normalised on BOTH sides precisely so an honest quote pulled across a
    // wrapped line does not read as fabricated.
    expect(
      requirementDispositionShortfall(
        {
          ...CODE_SHAPED,
          requirementDisposition: [
            {
              requirement: 'require that run to be a PASS. Today any non-empty string satisfies the check',
              disposition: 'implemented',
              citations: ['thing.ts'],
            },
          ],
        },
        opts,
      ),
    ).toBeUndefined();
  });

  it('flags a PARAPHRASE that reads as full delivery', () => {
    // The measured failure shape: "make the retry robust" becomes "added a retry". Every
    // word here appears in the source; the CLAIM does not.
    const found = requirementDispositionShortfall(
      {
        ...CODE_SHAPED,
        requirementDisposition: [
          {
            requirement: 'bind the test result to a run and check it passes',
            disposition: 'implemented',
            citations: ['thing.ts'],
          },
        ],
      },
      opts,
    );
    expect(found?.kind).toBe('unfaithful');
    expect(found?.notQuotedFromSource).toEqual(['bind the test result to a run and check it passes']);
  });

  it('flags a quote too short to be a distinct requirement', () => {
    // Closes the gaming vector: a single word is a substring of almost any body, which
    // would make the substring test trivially satisfiable.
    const short = 'a PASS';
    expect(short.length).toBeLessThan(MIN_REQUIREMENT_QUOTE_CHARS);
    expect(SOURCE).toContain(short); // it WOULD pass a naive substring test
    const found = requirementDispositionShortfall(
      { ...CODE_SHAPED, requirementDisposition: [{ requirement: short, disposition: 'implemented', citations: ['thing.ts'] }] },
      opts,
    );
    expect(found?.notQuotedFromSource).toEqual([short]);
  });

  it('does not judge quotes at all when there is no source to judge against', () => {
    expect(
      requirementDispositionShortfall(
        {
          ...CODE_SHAPED,
          requirementDisposition: [
            { requirement: 'a requirement nobody can check', disposition: 'implemented', citations: ['thing.ts'] },
          ],
        },
        { sourceText: 'too thin', probe: probe(['thing.ts']) },
      ),
    ).toBeUndefined();
  });
});

describe('`implemented` owes a citation that RESOLVES', () => {
  const entry = (citations?: string[]) => ({
    ...CODE_SHAPED,
    requirementDisposition: [
      {
        requirement: 'require that run to be a PASS',
        disposition: 'implemented' as const,
        ...(citations ? { citations } : {}),
      },
    ],
  });
  const opts = { sourceText: SOURCE, probe: probe(['real.ts']) };

  it('accepts a citation that exists in the tree', () => {
    expect(requirementDispositionShortfall(entry(['real.ts']), opts)).toBeUndefined();
  });

  it('flags a citation that resolves to nothing', () => {
    expect(requirementDispositionShortfall(entry(['imaginary.ts']), opts)?.implementedWithoutResolvingCitation)
      .toEqual(['require that run to be a PASS']);
  });

  it('flags an `implemented` entry carrying no citation at all', () => {
    expect(requirementDispositionShortfall(entry(), opts)?.implementedWithoutResolvingCitation)
      .toEqual(['require that run to be a PASS']);
  });

  it('tolerates a line anchor — a wrong line number is not a fabricated citation', () => {
    expect(requirementDispositionShortfall(entry(['real.ts:120']), opts)).toBeUndefined();
    expect(requirementDispositionShortfall(entry(['real.ts:120-140']), opts)).toBeUndefined();
  });

  it('never judges a glob or an absolute path — unjudgeable must not read as fabricated', () => {
    expect(requirementDispositionShortfall(entry(['packages/**/*.ts']), opts)).toBeUndefined();
    expect(requirementDispositionShortfall(entry(['/elsewhere/file.ts']), opts)).toBeUndefined();
  });

  it('never judges citations when no repo root resolved', () => {
    // An explicit empty roots list means "I could not resolve a root, do not guess".
    expect(
      requirementDispositionShortfall(entry(['imaginary.ts']), { sourceText: SOURCE, probe: { repoRoots: [] } }),
    ).toBeUndefined();
    expect(
      requirementDispositionShortfall(entry(['imaginary.ts']), {
        sourceText: SOURCE,
        probe: { repoRoots: [null, undefined] },
      }),
    ).toBeUndefined();
  });

  it('stays silent when the fs probe throws', () => {
    expect(
      requirementDispositionShortfall(entry(['boom.ts']), {
        sourceText: SOURCE,
        probe: {
          repoRoots: ['/repo'],
          exists: () => {
            throw new Error('EIO');
          },
        },
      }),
    ).toBeUndefined();
  });
});

describe('`deferred` owes a filed follow-up ref', () => {
  const deferredEntry = (followUp?: string) => ({
    ...CODE_SHAPED,
    requirementDisposition: [
      {
        requirement: 'require that run to be a PASS',
        disposition: 'deferred' as const,
        ...(followUp ? { followUp } : {}),
      },
    ],
  });
  const opts = { sourceText: SOURCE, probe: probe() };

  it('accepts a work-item ref', () => {
    expect(requirementDispositionShortfall(deferredEntry('EI-123456'), opts)).toBeUndefined();
    expect(requirementDispositionShortfall(deferredEntry('filed as WI-2142114'), opts)).toBeUndefined();
  });

  it('flags a deferral nobody filed — indistinguishable from work silently dropped', () => {
    expect(requirementDispositionShortfall(deferredEntry(), opts)?.deferredWithoutFollowUp)
      .toEqual(['require that run to be a PASS']);
    expect(requirementDispositionShortfall(deferredEntry('later'), opts)?.deferredWithoutFollowUp)
      .toEqual(['require that run to be a PASS']);
  });

  it('asks nothing of `not-applicable` / `rejected` beyond the verbatim quote', () => {
    // Those dispositions assert no code and file no follow-up, so demanding either would
    // manufacture evidence rather than check it.
    expect(
      requirementDispositionShortfall(
        {
          ...CODE_SHAPED,
          requirementDisposition: [
            { requirement: 'require that run to be a PASS', disposition: 'not-applicable' },
            { requirement: 'refused outright because no column says which group is ours', disposition: 'rejected' },
          ],
        },
        opts,
      ),
    ).toBeUndefined();
  });
});

describe('a fully faithful disposition is silent', () => {
  it('returns undefined when every entry passes every check', () => {
    expect(
      requirementDispositionShortfall(
        {
          ...CODE_SHAPED,
          requirementDisposition: [
            {
              requirement: 'require that run to be a PASS',
              disposition: 'implemented',
              citations: ['real.ts'],
            },
            {
              requirement: 'only the agent\'s most recent run is judged',
              disposition: 'deferred',
              followUp: 'EI-999888',
            },
          ],
        },
        { sourceText: SOURCE, probe: probe(['real.ts']) },
      ),
    ).toBeUndefined();
  });
});
