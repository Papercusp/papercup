/**
 * fulltext-lexical-dupe-guard.test — EI-19298062354262754: work_items:create's
 * advisory reuse of the unified work-item search-first dedup (full-text
 * search + title/summary-token Jaccard, no embedding, no recency window), always
 * advisory (never blocks), and fail-open on every error mode (mirrors
 * semantic-dupe-guard.test.ts / recent-lexical-dupe-guard.test.ts's contract).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  findFulltextLexicalDupes,
  type FulltextLexicalDupeDeps,
  type FulltextLexicalDupeRow,
} from './fulltext-lexical-dupe-guard';

const row = (
  id: string,
  title: string,
  state = 'open',
  harness: string | null = 'papercusp',
  summary?: string,
): FulltextLexicalDupeRow => ({
  id,
  title,
  ...(summary === undefined ? {} : { summary }),
  state,
  harness,
});

const depsWith = (rows: FulltextLexicalDupeRow[]): FulltextLexicalDupeDeps => ({
  searchWorkItems: async () => rows,
});

describe('failure diagnostics', () => {
  it('retains the completeness failure reason and does not mistake it for a clean empty result', async () => {
    const observed = vi.fn();
    const deps: FulltextLexicalDupeDeps = {
      searchWorkItems: async () => ({ complete: false, items: [], reason: 'candidate-limit-exceeded' }),
    };
    expect(await findFulltextLexicalDupes({ title: 't' }, deps, observed)).toBeNull();
    expect(observed).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'unavailable', reason: 'incomplete-coverage', detail: 'candidate-limit-exceeded', phase: 'candidate-search',
    }));
    expect(await findFulltextLexicalDupes({ title: 't' }, depsWith([]), observed)).toEqual([]);
    expect(observed).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: 'ok', reason: 'complete' }));
  });

  it('distinguishes timeout from query errors and emits a timeout only once despite late rejection', async () => {
    vi.useFakeTimers();
    try {
      const observed = vi.fn();
      let reject!: (error: Error) => void;
      const deps: FulltextLexicalDupeDeps = {
        searchWorkItems: () => new Promise((_, rejectSearch) => { reject = rejectSearch; }),
      };
      const pending = findFulltextLexicalDupes({ title: 't' }, deps, observed);
      await vi.advanceTimersByTimeAsync(1500);
      expect(await pending).toBeNull();
      expect(observed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ reason: 'budget-expired', elapsedMs: 1500 }));
      reject(new Error('late failure'));
      await vi.advanceTimersByTimeAsync(1);
      expect(observed).toHaveBeenCalledTimes(1);
      const failed: FulltextLexicalDupeDeps = { searchWorkItems: async () => { throw new Error('search failed'); } };
      expect(await findFulltextLexicalDupes({ title: 't' }, failed, observed)).toBeNull();
      expect(observed).toHaveBeenLastCalledWith(expect.objectContaining({
        reason: 'error', error: { name: 'Error', message: 'search failed' },
      }));
    } finally { vi.useRealTimers(); }
  });

  it('keeps a successful verdict even when its diagnostic consumer throws', async () => {
    expect(await findFulltextLexicalDupes({ title: 't' }, depsWith([]), () => { throw new Error('observer failed'); })).toEqual([]);
  });

  it('attributes an exhausted budget to seed preparation when it has not finished', async () => {
    vi.useFakeTimers();
    try {
      const observed = vi.fn();
      const deps: FulltextLexicalDupeDeps = {
        searchWorkItems: (_query, opts) => {
          opts?.onPhase?.('indexable-terms');
          return new Promise(() => {});
        },
      };
      const pending = findFulltextLexicalDupes({ title: 'seed preparation' }, deps, observed);
      await vi.advanceTimersByTimeAsync(1500);
      expect(await pending).toBeNull();
      expect(observed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        reason: 'budget-expired', phase: 'indexable-terms', elapsedMs: 1500, phaseElapsedMs: 1500,
      }));
    } finally { vi.useRealTimers(); }
  });

  it('excludes earlier seed preparation from the timed-out candidate-query phase', async () => {
    vi.useFakeTimers();
    try {
      const observed = vi.fn();
      const deps: FulltextLexicalDupeDeps = {
        searchWorkItems: async (_query, opts) => {
          opts?.onPhase?.('indexable-terms');
          await new Promise((resolve) => setTimeout(resolve, 1100));
          opts?.onPhase?.('candidate-query');
          return new Promise(() => {});
        },
      };
      const pending = findFulltextLexicalDupes({ title: 'candidate query' }, deps, observed);
      await vi.advanceTimersByTimeAsync(1500);
      expect(await pending).toBeNull();
      expect(observed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        reason: 'budget-expired', phase: 'candidate-query', elapsedMs: 1500, phaseElapsedMs: 400,
      }));
    } finally { vi.useRealTimers(); }
  });

  it('preserves a successful verdict after both query phases and measures scoring separately', async () => {
    vi.useFakeTimers();
    try {
      const observed = vi.fn();
      const deps: FulltextLexicalDupeDeps = {
        searchWorkItems: async (_query, opts) => {
          opts?.onPhase?.('indexable-terms');
          await new Promise((resolve) => setTimeout(resolve, 700));
          opts?.onPhase?.('candidate-query');
          await new Promise((resolve) => setTimeout(resolve, 400));
          return [];
        },
      };
      const pending = findFulltextLexicalDupes({ title: 'completed query' }, deps, observed);
      await vi.advanceTimersByTimeAsync(1100);
      expect(await pending).toEqual([]);
      expect(observed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        outcome: 'ok', reason: 'complete', phase: 'score-candidates', elapsedMs: 1100, phaseElapsedMs: 0,
      }));
    } finally { vi.useRealTimers(); }
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('classification (advisory-only)', () => {
  it('the paraphrased-refile case: a differently-worded but same-bug title is caught', async () => {
    // Real case from the filing bug (EI-19298062354262754): "coord:orient dropping
    // a fleet leader's leaderBrief" vs "leaderBrief serialized late and cut" share
    // enough tokens to clear the 0.6 Jaccard floor even though neither embeds the
    // other's id nor was created in the same 10-minute window.
    const r = await findFulltextLexicalDupes(
      { title: 'coord:orient truncates a fleet leader leaderBrief mid-array' },
      depsWith([row('EI-1', 'coord:orient drops a fleet leader leaderBrief truncates mid-array')]),
    );
    expect(r).not.toBeNull();
    expect(r!.map((c) => c.id)).toEqual(['EI-1']);
    expect(r![0].source).toBe('lexical-fulltext');
    expect(r![0].similarity).toBeGreaterThanOrEqual(0.6);
  });

  it('returns [] (not null) when nothing close — "screened, no dupes"', async () => {
    const r = await findFulltextLexicalDupes(
      { title: 'totally unrelated concern' },
      depsWith([row('EI-1', 'a completely different bug about something else entirely')]),
    );
    expect(r).toEqual([]);
  });

  it('excludes the item itself (excludeId) even if it would otherwise self-match', async () => {
    const r = await findFulltextLexicalDupes(
      { title: 'same exact title here', excludeId: 'EI-9' },
      depsWith([row('EI-9', 'same exact title here')]),
    );
    expect(r).toEqual([]);
  });

  it('filters out TERMINAL-state candidates (done/dropped/resolved/closed)', async () => {
    const r = await findFulltextLexicalDupes(
      { title: 'flaky test in the release gate' },
      depsWith([
        row('EI-1', 'flaky test in the release gate', 'done'),
        row('EI-2', 'flaky test in the release gate', 'resolved'),
        row('EI-3', 'flaky test in the release gate', 'dropped'),
        row('EI-4', 'flaky test in the release gate', 'open'),
      ]),
    );
    expect(r).not.toBeNull();
    expect(r!.map((c) => c.id)).toEqual(['EI-4']);
  });

  it('sorts by similarity desc and caps at top-3', async () => {
    const rows = [
      row('EI-1', 'alpha bravo charlie delta echo'),
      row('EI-2', 'alpha bravo charlie delta echo foxtrot'),
      row('EI-3', 'alpha bravo charlie'),
      row('EI-4', 'alpha bravo'),
      row('EI-5', 'alpha bravo charlie delta'),
    ];
    const r = await findFulltextLexicalDupes({ title: 'alpha bravo charlie delta echo' }, depsWith(rows));
    expect(r).not.toBeNull();
    expect(r!.length).toBeLessThanOrEqual(3);
    for (let i = 1; i < r!.length; i++) expect(r![i - 1].similarity).toBeGreaterThanOrEqual(r![i].similarity);
  });

  it('keeps a qualifying match after more than fifty lower-similarity candidates', async () => {
    const query = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet';
    const crowd = Array.from({ length: 80 }, (_, i) => row(
      'F-DECOY-' + i,
      'crowded result ' + i,
      'open',
      'papercusp',
      query + ' noiseone noisetwo noisethree noisefour noisefive noisesix noiseseven noiseeight noisenine noiseeleven',
    ));
    const r = await findFulltextLexicalDupes(
      { title: query },
      depsWith([...crowd, row('F-REAL', 'alpha bravo charlie delta echo foxtrot golf hotel')]),
    );
    expect(r?.map((candidate) => candidate.id)).toEqual(['F-REAL']);
  });

  it('a candidate below DUP_THRESHOLD (0.6) is not surfaced', async () => {
    const r = await findFulltextLexicalDupes(
      { title: 'alpha bravo charlie delta echo foxtrot golf' },
      depsWith([row('EI-1', 'alpha zulu')]), // 1-token overlap out of ~8 union — well under 0.6
    );
    expect(r).toEqual([]);
  });

  it('keeps the normalized harness from either work-item family', async () => {
    const r = await findFulltextLexicalDupes(
      { title: 'shared concern' },
      depsWith([row('F-1', 'shared concern', 'open', 'potato-storefront')]),
    );
    expect(r).not.toBeNull();
    expect(r![0].harness).toBe('potato-storefront');
  });

  it('catches a cross-family candidate returned by the unified search seam', async () => {
    const r = await findFulltextLexicalDupes(
      { title: 'build potato storefront app' },
      depsWith([row('F-1', 'scope', 'open', 'papercusp', 'build potato storefront app')]),
    );
    expect(r).not.toBeNull();
    expect(r!.map((candidate) => candidate.id)).toEqual(['F-1']);
  });

  it('uses title and summary together so summary-only overlap is surfaced', async () => {
    const calls: string[] = [];
    const deps: FulltextLexicalDupeDeps = {
      searchWorkItems: async (query) => {
        calls.push(query);
        return [row('WI-1', 'scope decision', 'open', 'papercusp', 'can you make me an app for selling potatoes')];
      },
    };
    const r = await findFulltextLexicalDupes(
      { title: 'build storefront', summary: 'can you make me an app for selling potatoes' },
      deps,
    );
    expect(r).not.toBeNull();
    expect(r!.map((candidate) => candidate.id)).toEqual(['WI-1']);
    expect(calls).toEqual(['build storefront\ncan you make me an app for selling potatoes']);
  });

  it('passes the combined title and summary through to the unified search seam', async () => {
    const calls: string[] = [];
    const deps: FulltextLexicalDupeDeps = {
      searchWorkItems: async (query) => {
        calls.push(query);
        return [];
      },
    };
    await findFulltextLexicalDupes({ title: 'a fresh title', summary: 'body words' }, deps);
    expect(calls).toEqual(['a fresh title\nbody words']);
  });
});

describe('fail-open — every failure mode returns null (create proceeds)', () => {
  it('search throw', async () => {
    const deps: FulltextLexicalDupeDeps = {
      searchWorkItems: async () => {
        throw new Error('db down');
      },
    };
    expect(await findFulltextLexicalDupes({ title: 't' }, deps)).toBeNull();
  });

  it('an incomplete bounded candidate set is not reported as a clean no-duplicate result', async () => {
    const deps: FulltextLexicalDupeDeps = { searchWorkItems: async () => null };
    expect(await findFulltextLexicalDupes({ title: 'known existing phrase here' }, deps)).toBeNull();
  });

  it('budget expiry: a hung search forfeits the verdict instead of blocking the create', async () => {
    vi.useFakeTimers();
    try {
      const deps: FulltextLexicalDupeDeps = {
        searchWorkItems: () => new Promise<FulltextLexicalDupeRow[]>(() => {}), // never settles
      };
      const p = findFulltextLexicalDupes({ title: 't' }, deps);
      await vi.advanceTimersByTimeAsync(1600);
      expect(await p).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('kill switch PAPERCUSP_WI_FULLTEXT_DUPE=off short-circuits before any query', async () => {
    vi.stubEnv('PAPERCUSP_WI_FULLTEXT_DUPE', 'off');
    let touched = false;
    const deps: FulltextLexicalDupeDeps = {
      searchWorkItems: async () => {
        touched = true;
        return [];
      },
    };
    expect(await findFulltextLexicalDupes({ title: 't' }, deps)).toBeNull();
    expect(touched).toBe(false);
  });

  it('inert under vitest WITHOUT injected deps (never hits real PG in unrelated tests)', async () => {
    expect(await findFulltextLexicalDupes({ title: 't' })).toBeNull();
  });
});
