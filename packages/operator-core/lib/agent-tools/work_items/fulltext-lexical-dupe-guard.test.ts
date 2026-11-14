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
