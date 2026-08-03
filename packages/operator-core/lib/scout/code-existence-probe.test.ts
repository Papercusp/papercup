import { describe, expect, it } from 'vitest';
import {
  extractAssertedPriorArt,
  extractDistinctiveTerms,
  probeCodeExistence,
  summariseCodeExistence,
  type CodeSearchDeps,
} from './code-existence-probe';

/** Terms only, for concise assertions. */
const terms = (text: string): string[] => extractDistinctiveTerms(text).map((t) => t.term);

/** A searcher with a fixed term -> files map; every other term misses. */
const fakeSearch = (table: Record<string, string[]>): CodeSearchDeps => ({
  search: async (term: string) => table[term] ?? [],
});

/**
 * CONTROL — a deliberately naive extractor, kept permanently in this file.
 *
 * It is what you get without the identifier/stoplist/boilerplate filtering: every
 * long word in the prose. The calibration assertions below require the REAL
 * extractor to reject what this one accepts. Without this control, "the extractor
 * returned some terms" would pass even if all the filtering were deleted.
 */
const naiveExtract = (text: string): string[] =>
  Array.from(new Set((text.match(/\b[A-Za-z][A-Za-z0-9_]{2,}\b/g) ?? []).filter((w) => w.length >= 8)));

/** The shape of a real Scout idea body — this is the EI-7303 case that motivated the module. */
const EI_7303_BODY = `
The Hive burns compute re-diagnosing identical recurring failures. Existing retry/backoff
logic reacts to individual failures without cross-recurrence memory. Caching keys on exact
inputs (UUIDs), so structurally-identical failures never dedupe.

**Mechanism:** an antibody library: on each red fire, compute a structural signature hash
from {error-class, tool/loop family}. Persist signature->remedy bindings via a new
\`antibodySignature\` binding. Nothing currently records this: no \`watchdogKey\` equivalent
exists for fire paths.

_Scout-generated. Source ideas: scout-idea-analogical-0-0._
`;

describe('extractDistinctiveTerms', () => {
  it('pulls the code-shaped vocabulary out of a real idea body', () => {
    const got = terms(EI_7303_BODY);
    // Backticked symbols are the author explicitly marking code.
    expect(got).toContain('watchdogKey');
    expect(got).toContain('antibodySignature');
  });

  it('CALIBRATION vs the naive control: rejects generic prose the control accepts', () => {
    const got = terms(EI_7303_BODY).map((t) => t.toLowerCase());
    const naive = naiveExtract(EI_7303_BODY).map((t) => t.toLowerCase());

    // The control sweeps up ordinary long words...
    expect(naive).toContain('recurring');
    expect(naive).toContain('structural');
    // ...and the real extractor must NOT, or every idea matches everything.
    expect(got).not.toContain('recurring');
    expect(got).not.toContain('structural');
    expect(got).not.toContain('individual');
  });

  it('strips Scout boilerplate so it is never probed', () => {
    // "Scout-generated" / "Source ideas" appear in EVERY idea; probing them would
    // return a hit for all of them and drown the real signal.
    const got = terms(EI_7303_BODY).map((t) => t.toLowerCase());
    expect(got).not.toContain('scout-generated');
    expect(got.some((t) => t.includes('scout-idea-analogical'))).toBe(false);
  });

  it('recognises source paths and group:verb tool names', () => {
    const got = terms('See `packages/operator-core/lib/scout/critics.ts`, reached via improvements:capture.');
    expect(got).toContain('packages/operator-core/lib/scout/critics.ts');
    expect(got).toContain('improvements:capture');
  });

  it('treats a backticked PHRASE as prose, not a symbol', () => {
    // `the work queue` is emphasis, not an identifier — probing it is meaningless.
    expect(terms('It writes to `the work queue` on each pass.')).not.toContain('the work queue');
  });

  it('drops generic engineering vocabulary that happens to be long', () => {
    const got = terms('The implementation requires configuration and documentation.').map((t) => t.toLowerCase());
    for (const w of ['implementation', 'configuration', 'documentation']) expect(got).not.toContain(w);
  });

  it('de-duplicates case-insensitively', () => {
    const got = terms('`watchdogKey` and watchdogKey again, plus `watchdogkey`.');
    expect(got.filter((t) => t.toLowerCase() === 'watchdogkey')).toHaveLength(1);
  });

  it('returns nothing for prose with no code-shaped vocabulary', () => {
    expect(terms('We should make the system better and faster for everyone.')).toEqual([]);
  });
});

describe('probeCodeExistence', () => {
  it('THE REGRESSION: flags an idea whose proposed mechanism already exists', async () => {
    // EI-7303 proposed inventing signature->remedy bindings. watchdogKey already
    // implemented it, engineered directly and so invisible to the idea-corpus check.
    const deps = fakeSearch({
      watchdogKey: ['lib/issues-engineer.ts', 'lib/scorecard-emission-pulse.ts'],
    });
    const report = await probeCodeExistence(EI_7303_BODY, deps);

    expect(report.searched).toBe(true);
    const hit = report.matches.find((m) => m.term === 'watchdogKey');
    expect(hit).toBeDefined();
    expect(hit?.strength).toBe('strong');
    expect(hit?.fileCount).toBe(2);
    expect(summariseCodeExistence(report)).toContain('possible existing surface');
  });

  it('grades ubiquitous vocabulary WEAK so it cannot masquerade as prior art', async () => {
    const deps = fakeSearch({ watchdogKey: Array.from({ length: 400 }, (_, i) => `f${i}.ts`) });
    const report = await probeCodeExistence(EI_7303_BODY, deps, { ubiquitousFileCount: 150 });
    expect(report.matches.find((m) => m.term === 'watchdogKey')?.strength).toBe('weak');
    expect(summariseCodeExistence(report)).toContain('weak signal');
  });

  it('sorts strong before weak, most specific first', async () => {
    const deps = fakeSearch({
      watchdogKey: ['a.ts', 'b.ts', 'c.ts'],
      antibodySignature: ['only.ts'],
    });
    const report = await probeCodeExistence(EI_7303_BODY, deps, { ubiquitousFileCount: 2 });
    expect(report.matches[0]?.term).toBe('antibodySignature'); // strong, 1 file
    expect(report.matches[0]?.strength).toBe('strong');
    expect(report.matches.at(-1)?.strength).toBe('weak'); // watchdogKey, 3 >= 2
  });

  it('reports a genuine miss as searched:true with no matches', async () => {
    const report = await probeCodeExistence(EI_7303_BODY, fakeSearch({}));
    expect(report.searched).toBe(true);
    expect(report.matches).toEqual([]);
    expect(summariseCodeExistence(report)).toContain('no existing surface found');
  });

  it('ZERO-WORK FALSE GREEN: text with no distinctive terms is searched:false, not a miss', async () => {
    // Regression. This previously returned searched:true having never called the
    // backend — a probe that did no work reporting as one that found nothing.
    // Same class as `tsc -p .` checking zero files and exiting clean.
    //
    // It matters most for the ideas it is worst on: text with no greppable
    // vocabulary is exactly where prior art is hardest to find, so those items
    // would have collected the cleanest "nothing found" in the backlog.
    let called = 0;
    const deps: CodeSearchDeps = {
      search: async () => {
        called += 1;
        return [];
      },
    };
    const report = await probeCodeExistence('we should make the thing better somehow', deps);

    expect(report.terms).toEqual([]);
    expect(called).toBe(0); // the backend really was never called...
    expect(report.searched).toBe(false); // ...so it must not claim it searched
    expect(report.unavailableReason).toContain('never called');
    expect(summariseCodeExistence(report)).toContain('NOT evidence of absence');
  });

  it('CONTROL: the zero-terms guard does not fire on text that DOES yield terms', async () => {
    // Without this, the assertion above would also pass if extraction broke
    // entirely and every report became searched:false.
    const report = await probeCodeExistence(EI_7303_BODY, fakeSearch({}));
    expect(report.terms.length).toBeGreaterThan(0);
    expect(report.searched).toBe(true);
  });

  it('FAILS OPEN: a throwing searcher is never reported as "nothing found"', async () => {
    // The whole point of the module is preventing a false "no prior art exists".
    // A probe outage must be distinguishable from a real miss.
    const deps: CodeSearchDeps = {
      search: async () => {
        throw new Error('git grep unavailable');
      },
    };
    const report = await probeCodeExistence(EI_7303_BODY, deps);

    expect(report.searched).toBe(false);
    expect(report.matches).toEqual([]);
    expect(report.unavailableReason).toContain('git grep unavailable');

    const summary = summariseCodeExistence(report);
    expect(summary).toContain('UNAVAILABLE');
    expect(summary).toContain('NOT evidence of absence');
    // Must never read like the genuine-miss wording above.
    expect(summary).not.toContain('no existing surface found');
  });

  it('bounds the number of probed terms', async () => {
    const probed: string[] = [];
    const deps: CodeSearchDeps = {
      search: async (t) => {
        probed.push(t);
        return [];
      },
    };
    const body = Array.from({ length: 40 }, (_, i) => `\`someSymbol${i}Name\``).join(' ');
    const report = await probeCodeExistence(body, deps, { maxTerms: 5 });
    expect(probed).toHaveLength(5);
    expect(report.terms).toHaveLength(5);
  });

  it('caps retained example paths', async () => {
    const deps = fakeSearch({ watchdogKey: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'] });
    const report = await probeCodeExistence(EI_7303_BODY, deps, { maxExamples: 2 });
    const hit = report.matches.find((m) => m.term === 'watchdogKey');
    expect(hit?.examples).toHaveLength(2);
    expect(hit?.fileCount).toBe(5); // count is the full total, not the capped sample
  });

  it('handles an empty body without searching — and SAYS it did not search', async () => {
    // This test used to assert `called === false` and `searched === true` on
    // consecutive lines: "the backend never ran" and "the backend ran" at once.
    // The contradiction was the bug, recorded as an expectation.
    let called = false;
    const deps: CodeSearchDeps = {
      search: async () => {
        called = true;
        return [];
      },
    };
    const report = await probeCodeExistence('', deps);
    expect(called).toBe(false);
    expect(report.searched).toBe(false);
    expect(report.unavailableReason).toContain('never called');
    expect(report.matches).toEqual([]);
  });
});

describe('self-id leg', () => {
  it('reports files citing the item OWN id, and leads the summary with it', async () => {
    // An implementation usually names the item it closed in its docstring, which
    // makes this the highest-precision of the three legs.
    const deps = fakeSearch({ 'EI-7303': ['lib/scout/antibody-store.ts'] });
    const report = await probeCodeExistence(EI_7303_BODY, deps, { selfId: 'EI-7303' });

    expect(report.selfIdHits).toEqual(['lib/scout/antibody-store.ts']);
    const summary = summariseCodeExistence(report);
    expect(summary).toContain('LIKELY ALREADY IMPLEMENTED');
    expect(summary).toContain('lib/scout/antibody-store.ts');
  });

  it('leaves selfIdHits undefined when nothing cites the id', async () => {
    const report = await probeCodeExistence(EI_7303_BODY, fakeSearch({}), { selfId: 'EI-7303' });
    expect(report.selfIdHits).toBeUndefined();
    expect(summariseCodeExistence(report)).not.toContain('LIKELY ALREADY IMPLEMENTED');
  });

  it('is skipped entirely when no selfId is supplied', async () => {
    const probed: string[] = [];
    const deps: CodeSearchDeps = {
      search: async (t) => {
        probed.push(t);
        return [];
      },
    };
    await probeCodeExistence(EI_7303_BODY, deps);
    expect(probed).not.toContain('EI-7303');
  });
});

describe('asserted prior art — "the filings confess"', () => {
  // Observed live (su-b9269a31, msg msdmrkli): EI-7526's summary OPENS by naming the
  // prior art. A screen that only greps symbols never reads that sentence.
  const EI_7526_OPENING =
    'Existing EI-7347 tooling detects actor-less signals reactively, but nothing gates them at emit time. See also WI-2374.';

  it('extracts work-item ids the author named', () => {
    const got = extractAssertedPriorArt(EI_7526_OPENING, 'EI-7526');
    const ids = got.filter((a) => a.kind === 'work-item-id').map((a) => a.ref);
    expect(ids).toContain('EI-7347');
    expect(ids).toContain('WI-2374');
  });

  it('excludes the item OWN id — that is the self-id leg, not a citation', () => {
    // Counting it would make every single item look like it cites prior art.
    const got = extractAssertedPriorArt('EI-7526 proposes a gate; see EI-7347.', 'EI-7526');
    expect(got.map((a) => a.ref)).not.toContain('EI-7526');
    expect(got.map((a) => a.ref)).toContain('EI-7347');
  });

  it('leads the summary with the named ids', () => {
    const report = {
      terms: [],
      matches: [],
      searched: true,
      assertedPriorArt: extractAssertedPriorArt(EI_7526_OPENING, 'EI-7526'),
    };
    const summary = summariseCodeExistence(report);
    expect(summary).toContain('AUTHOR NAMES PRIOR ART');
    expect(summary).toContain('EI-7347');
  });

  it('THE FALSE POSITIVE: a bare "existing <X>" complaint must NOT drive a verdict', () => {
    // EI-7303 opens "Existing retry/backoff logic reacts to individual failures
    // WITHOUT cross-recurrence memory" — the author calling the existing mechanism
    // INADEQUATE, i.e. motivation, the opposite of conceding prior art. Letting the
    // phrase kind reach the headline would mislabel most ideas as already-built.
    const asserted = extractAssertedPriorArt(EI_7303_BODY, 'EI-7303');
    expect(asserted.some((a) => a.kind === 'existing-phrase')).toBe(true); // still captured...
    expect(asserted.some((a) => a.kind === 'work-item-id')).toBe(false); // ...but no id

    const summary = summariseCodeExistence({
      terms: [],
      matches: [],
      searched: true,
      assertedPriorArt: asserted,
    });
    expect(summary).not.toContain('AUTHOR NAMES PRIOR ART'); // must fall through
  });

  it('carries a context fragment so a reader can judge without re-opening the item', () => {
    const got = extractAssertedPriorArt(EI_7526_OPENING, 'EI-7526');
    const hit = got.find((a) => a.ref === 'EI-7347');
    expect(hit?.context).toContain('detects actor-less signals');
  });

  it('needs no backend at all — survives a total retrieval outage', async () => {
    // The code-shaped term is here so line 2 of the assertions can prove the
    // lexical leg genuinely TRIED and failed, rather than short-circuiting on
    // "no candidates" — two different roads to searched:false (see the
    // zero-terms regression test below).
    const body = `${EI_7526_OPENING} The proposed gate lives in \`emitTimeSignalGate\`.`;
    const deps: CodeSearchDeps = {
      search: async () => {
        throw new Error('grep down');
      },
    };
    const report = await probeCodeExistence(body, deps, { selfId: 'EI-7526' });

    expect(report.terms).toContain('emitTimeSignalGate'); // the lexical leg really tried
    expect(report.searched).toBe(false); // ...and really failed
    expect(report.assertedPriorArt?.some((a) => a.ref === 'EI-7347')).toBe(true); // leg 4 survived it
    expect(summariseCodeExistence(report)).toContain('AUTHOR NAMES PRIOR ART');
  });
});

describe('semantic leg — kept SEPARATE from the lexical leg', () => {
  const semanticDeps = (): CodeSearchDeps => ({
    search: async () => [],
    searchSemantic: async () => [
      { ref: 'lib/issues-engineer.ts', score: 0.82, excerpt: 'findIssuesByWatchdogKeys' },
      { ref: 'lib/severe-event-broadcast.ts', score: 0.71 },
    ],
  });

  it('THE INVARIANT: semantic hits are NEVER merged into the lexical matches', async () => {
    // Merging would make each leg's precision unmeasurable, which is the whole
    // reason the legs are reported apart (su-b9269a31, msg msdmgp4s).
    const report = await probeCodeExistence(EI_7303_BODY, semanticDeps());

    expect(report.matches).toEqual([]); // lexical genuinely found nothing
    expect(report.semantic).toHaveLength(2);
    expect(report.semanticSearched).toBe(true);
    // No semantic ref may appear in the lexical set.
    const lexicalRefs = report.matches.flatMap((m) => m.examples);
    for (const s of report.semantic ?? []) expect(lexicalRefs).not.toContain(s.ref);
  });

  it('reports both legs distinguishably in the summary', async () => {
    const summary = summariseCodeExistence(await probeCodeExistence(EI_7303_BODY, semanticDeps()));
    expect(summary).toContain('no existing surface found'); // the lexical verdict
    expect(summary).toContain('semantic leg'); // ...clearly labelled as the other leg
    expect(summary).toContain('lib/issues-engineer.ts');
  });

  it('distinguishes "not configured" from "configured and found nothing"', async () => {
    const notConfigured = await probeCodeExistence(EI_7303_BODY, fakeSearch({}));
    expect(notConfigured.semanticSearched).toBeUndefined();
    expect(notConfigured.semantic).toBeUndefined();

    const foundNothing = await probeCodeExistence(EI_7303_BODY, {
      search: async () => [],
      searchSemantic: async () => [],
    });
    expect(foundNothing.semanticSearched).toBe(true);
    expect(foundNothing.semantic).toEqual([]);
    expect(summariseCodeExistence(foundNothing)).toContain('semantic leg: no near surface');
  });

  it('FAILS OPEN independently of the lexical leg', async () => {
    // A semantic outage must not suppress a real lexical hit, nor read as absence.
    const deps: CodeSearchDeps = {
      search: async (t) => (t === 'watchdogKey' ? ['lib/issues-engineer.ts'] : []),
      searchSemantic: async () => {
        throw new Error('embedder down');
      },
    };
    const report = await probeCodeExistence(EI_7303_BODY, deps);

    expect(report.semanticSearched).toBe(false);
    expect(report.searched).toBe(true); // lexical unaffected
    expect(report.matches.find((m) => m.term === 'watchdogKey')).toBeDefined();
    expect(summariseCodeExistence(report)).toContain('semantic leg UNAVAILABLE');
  });

  it('caps retained semantic matches', async () => {
    const deps: CodeSearchDeps = {
      search: async () => [],
      searchSemantic: async () => Array.from({ length: 20 }, (_, i) => ({ ref: `r${i}.ts`, score: 0.5 })),
    };
    const report = await probeCodeExistence(EI_7303_BODY, deps, { maxSemanticMatches: 3 });
    expect(report.semantic).toHaveLength(3);
  });
});

describe('plan-slug leg (leg 5)', () => {
  const PLAN = { slug: 'self-improvement-consume-edges-2026-06-12', status: 'shipped' };
  const CONSUMER_IDEA = 'Monitoring signals fire but bind no acting consumer.';

  it('stays undefined when the dep is not configured — never a fabricated empty', async () => {
    const report = await probeCodeExistence(EI_7303_BODY, { search: async () => [] });
    expect(report.planSlugs).toBeUndefined();
  });

  it('reports matches in its OWN field, never unioned into matches or semantic', async () => {
    const report = await probeCodeExistence(CONSUMER_IDEA, {
      search: async () => [],
      searchPlans: async () => [PLAN],
    });
    expect(report.planSlugs?.searched).toBe(true);
    expect(report.planSlugs?.planMatches.map((m) => m.slug)).toEqual([PLAN.slug]);
    // The separation that keeps each leg's precision measurable.
    expect(report.matches).toEqual([]);
    expect(report.semantic).toBeUndefined();
  });

  it('survives a lexical outage — the legs are independent', async () => {
    const report = await probeCodeExistence(CONSUMER_IDEA, {
      search: async () => {
        throw new Error('git grep down');
      },
      searchPlans: async () => [PLAN],
    });
    expect(report.searched).toBe(false); // lexical is out...
    expect(report.planSlugs?.searched).toBe(true); // ...plan leg still answered
    expect(report.planSlugs?.planMatches).toHaveLength(1);
  });

  it('survives the zero-terms early return — the leg is carried on EVERY path', async () => {
    // Text with no greppable vocabulary: the lexical leg never calls its backend,
    // and that early return must not drop the plan leg's answer on the floor.
    const report = await probeCodeExistence('signals fire but bind no acting consumer', {
      search: async () => [],
      searchPlans: async () => [PLAN],
    });
    expect(report.searched).toBe(false);
    expect(report.unavailableReason).toMatch(/never called/);
    expect(report.planSlugs?.planMatches).toHaveLength(1);
  });

  it('fails open when the plan backend throws, without disturbing the lexical leg', async () => {
    const report = await probeCodeExistence(EI_7303_BODY, {
      search: async () => ['a.ts'],
      searchPlans: async () => {
        throw new Error('plan store unreachable');
      },
    });
    expect(report.planSlugs?.searched).toBe(false);
    expect(report.planSlugs?.planMatches).toEqual([]);
    expect(report.searched).toBe(true);
  });

  it('appends to the summary as CONTEXT — it never becomes the verdict', async () => {
    // A self-id hit is a high-precision leg and must keep the headline; the plan
    // leg may only add to it. Reversing this would let a token-overlap inference
    // outrank the strongest signal the screen has.
    const report = await probeCodeExistence(
      CONSUMER_IDEA,
      {
        search: async () => ['packages/operator-core/lib/orphaned-dispatch.ts'],
        searchPlans: async () => [PLAN],
      },
      { selfId: 'EI-9999' },
    );
    expect(report.selfIdHits).toBeDefined(); // the high-precision leg did fire
    const summary = summariseCodeExistence(report);
    expect(summary.startsWith('LIKELY ALREADY IMPLEMENTED')).toBe(true);
    expect(summary).toContain('plan-slug leg');
    expect(summary).toContain(PLAN.slug);
  });
});
