/**
 * fulltext-lexical-dupe-guard.test — EI-19298062354262754: work_items:create's
 * advisory reuse of improvements:capture's own search-first dedup (full-text
 * search + title-token Jaccard, no embedding, no recency window), always
 * advisory (never blocks), and fail-open on every error mode (mirrors
 * semantic-dupe-guard.test.ts / recent-lexical-dupe-guard.test.ts's contract).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  findFulltextLexicalDupes,
  type FulltextLexicalDupeDeps,
  type FulltextLexicalDupeRow,
} from './fulltext-lexical-dupe-guard';

const row = (id: string, title: string, state = 'open', scope = 'harness:papercusp'): FulltextLexicalDupeRow => ({
  id,
  title,
  state,
  scope,
});

const depsWith = (rows: FulltextLexicalDupeRow[]): FulltextLexicalDupeDeps => ({
  searchIssues: async () => rows,
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

  it('a candidate below DUP_THRESHOLD (0.6) is not surfaced', async () => {
    const r = await findFulltextLexicalDupes(
      { title: 'alpha bravo charlie delta echo foxtrot golf' },
      depsWith([row('EI-1', 'alpha zulu')]), // 1-token overlap out of ~8 union — well under 0.6
    );
    expect(r).toEqual([]);
  });

  it('derives harness from scope (harness:<slug> vs operator)', async () => {
    const r = await findFulltextLexicalDupes(
      { title: 'shared concern' },
      depsWith([row('EI-1', 'shared concern', 'open', 'operator')]),
    );
    expect(r).not.toBeNull();
    expect(r![0].harness).toBeNull();
  });

  it('passes the title through to searchIssues', async () => {
    const calls: Array<{ query: string; limit?: number }> = [];
    const deps: FulltextLexicalDupeDeps = {
      searchIssues: async (query, limit) => {
        calls.push({ query, limit });
        return [];
      },
    };
    await findFulltextLexicalDupes({ title: 'a fresh title' }, deps);
    expect(calls).toEqual([{ query: 'a fresh title', limit: 20 }]);
  });
});

describe('fail-open — every failure mode returns null (create proceeds)', () => {
  it('search throw', async () => {
    const deps: FulltextLexicalDupeDeps = {
      searchIssues: async () => {
        throw new Error('db down');
      },
    };
    expect(await findFulltextLexicalDupes({ title: 't' }, deps)).toBeNull();
  });

  it('budget expiry: a hung search forfeits the verdict instead of blocking the create', async () => {
    vi.useFakeTimers();
    try {
      const deps: FulltextLexicalDupeDeps = {
        searchIssues: () => new Promise<FulltextLexicalDupeRow[]>(() => {}), // never settles
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
      searchIssues: async () => {
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
