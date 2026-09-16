/**
 * The operator's direct-Postgres Project History provider (WI-10001548 defect A).
 *
 * The route's own suite covers status codes and the page block; this one covers the
 * READ underneath it — the pure mappers, and the provider driven through INJECTED
 * `query`/`git` seams so no database or repo is touched.
 *
 * Two behaviours here are deliberate asymmetries worth pinning, because both look
 * like bugs to a later reader and reverting either re-opens a shipped incident:
 *   - a `git` failure DEGRADES `loadCommits` to no commit links (commits enrich the
 *     record; the plans and their evidence ARE the record), whereas
 *   - `loadWorkItems` returns what Postgres gave it and lets the assembler refuse an
 *     all-empty resolve (WI-39831: 327 evidence-free stubs published as verified work).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  buildCommitLogArgs,
  commitLinksFor,
  createOperatorProjectHistorySource,
  parseCommitLog,
  repositoryFromRemoteUrl,
  workItemInputFromRow,
  PROJECT_HISTORY_MAX_PAGE_SIZE,
  PROJECT_HISTORY_PAGE_SIZE,
} from './project-history-source';

/** Built from char codes: a raw 0x1e/0x00 in source reds `lint:no-control-bytes`. */
const RS = String.fromCharCode(0x1e);
const NUL = String.fromCharCode(0x00);

function sourceWith(rows: Record<string, unknown>[][], git?: (args: readonly string[]) => Promise<string>) {
  const calls: { text: string; params: unknown[] }[] = [];
  let index = 0;
  return {
    calls,
    source: createOperatorProjectHistorySource({
      workspaceId: 'ws-test',
      harness: 'demo',
      repoRoot: '/repo',
      limit: 3,
      offset: 6,
      query: async (text, params) => {
        calls.push({ text, params });
        return rows[index++] ?? [];
      },
      git: async (args) => (git ? git(args) : ''),
    }),
  };
}

describe('repositoryFromRemoteUrl', () => {
  it.each([
    ['git@github.com:Papercusp/papercusp.git', 'https://github.com/Papercusp/papercusp'],
    ['https://github.com/Papercusp/papercusp.git', 'https://github.com/Papercusp/papercusp'],
    ['ssh://git@github.com/Papercusp/papercusp', 'https://github.com/Papercusp/papercusp'],
  ])('derives a browsable GitHub web URL from %s', (remote, webUrl) => {
    expect(repositoryFromRemoteUrl(remote, 'main')).toEqual({
      provider: 'github', url: remote, webUrl, defaultBranch: 'main',
    });
  });

  it('never guesses a web URL for a non-GitHub remote', () => {
    // A guessed URL 404s on every commit row, which is worse than no link at all.
    expect(repositoryFromRemoteUrl('git@gitlab.com:team/thing.git', 'main')).toMatchObject({
      provider: 'git', webUrl: null,
    });
  });

  it('returns null when there is no remote', () => {
    expect(repositoryFromRemoteUrl(null, 'main')).toBeNull();
    expect(repositoryFromRemoteUrl('   ', 'main')).toBeNull();
  });
});

describe('workItemInputFromRow', () => {
  it('prefers the plan_item attachment over the weaker source_plan_slug stamp', () => {
    const item = workItemInputFromRow({
      feature_id: 'WI-1', title: 'Ship it', item_kind: 'bug', status: 'done',
      closed_ts: new Date('2026-09-01T00:00:00.000Z'),
      authority: 'committed',
      payload: { plan_item: { plan_slug: 'authoritative-plan' }, _completionEvidence: { summary: 'Verified.' } },
      source_plan_slug: 'weaker-stamp',
    });
    expect(item).toMatchObject({
      id: 'WI-1',
      kind: 'bug',
      completedAt: '2026-09-01T00:00:00.000Z',
      completionAuthority: 'committed',
      completionSummary: 'Verified.',
      planSlugs: ['authoritative-plan'],
    });
  });

  it('falls back to source_plan_slug, and to plan-ledger membership when neither exists', () => {
    expect(workItemInputFromRow({ feature_id: 'WI-2', title: 'T', source_plan_slug: 'stamped' }))
      .toMatchObject({ planSlugs: ['stamped'] });
    // `undefined` is not the same as `[]`: it tells the assembler to attach the item
    // wherever a plan's markdown references its id, keeping the plan ledger the
    // membership authority. `[]` would attach it nowhere.
    expect(workItemInputFromRow({ feature_id: 'WI-3', title: 'T' })?.planSlugs).toBeUndefined();
  });

  it('drops a row with no id or no title rather than emitting a half-record', () => {
    expect(workItemInputFromRow({ feature_id: 'WI-4' })).toBeNull();
    expect(workItemInputFromRow({ title: 'orphan' })).toBeNull();
    expect(workItemInputFromRow({ feature_id: '  ', title: 'T' })).toBeNull();
  });

  it('defaults an absent kind/state instead of emitting undefined', () => {
    expect(workItemInputFromRow({ feature_id: 'WI-5', title: 'T' }))
      .toMatchObject({ kind: 'work-item', state: 'unknown', completionAuthority: 'work-item-ledger' });
  });
});

describe('buildCommitLogArgs', () => {
  it('greps for the page ids only, never walking the whole graph', () => {
    const args = buildCommitLogArgs(['WI-1', 'EI-2']);
    const grep = args.find((arg) => arg.startsWith('--grep='));
    expect(grep).toBe('--grep=(^|[^A-Za-z0-9-])(WI-1|EI-2)([^0-9]|$)');
    expect(args).toContain('--extended-regexp');
  });

  it('escapes regex metacharacters so an id cannot widen the pattern', () => {
    // `-` is deliberately NOT in the escape class — it is literal outside a character
    // class, and escaping it would be a no-op. `.` and `*` are what would widen it.
    const grep = buildCommitLogArgs(['WI-1.*']).find((arg) => arg.startsWith('--grep='));
    expect(grep).toContain('WI-1\\.\\*');
    expect(grep).not.toContain('WI-1.*)');
  });
});

describe('parseCommitLog', () => {
  const commit = (sha: string, files: string) =>
    `${RS}${sha}${NUL}subject${NUL}2026-09-01T00:00:00Z${NUL}body WI-1${NUL}${files}`;

  it('parses records and de-duplicates the file list', () => {
    const parsed = parseCommitLog(commit('a'.repeat(40), 'b.ts\na.ts\na.ts\n'));
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.files).toEqual(['a.ts', 'b.ts']);
  });

  it('skips a malformed record instead of guessing at it', () => {
    const raw = `${RS}not-a-sha${NUL}x${RS}${'b'.repeat(40)}${NUL}s${NUL}t${NUL}body${NUL}f.ts`;
    expect(parseCommitLog(raw).map((entry) => entry.sha)).toEqual(['b'.repeat(40)]);
  });

  it('returns nothing for empty output rather than throwing', () => {
    expect(parseCommitLog('')).toEqual([]);
  });
});

describe('commitLinksFor', () => {
  const requested = new Set(['WI-1', 'WI-2', 'WI-3']);

  it('grades a trailer as authoritative and a bare mention as a body reference', () => {
    // git-sync authors commit messages here, so prose citing an id is common and must
    // not be presented as the same grade of evidence as a trailer the committer wrote.
    const links = commitLinksFor('Fixes WI-2 along the way\n\nPapercusp-Work-Item: WI-1\n', requested);
    expect(links).toEqual(expect.arrayContaining([
      { workItemId: 'WI-1', attribution: 'authoritative' },
      { workItemId: 'WI-2', attribution: 'body-reference' },
    ]));
  });

  it('never double-lists an id that is both trailered and mentioned', () => {
    const links = commitLinksFor('Touches WI-1\n\nPapercusp-Work-Item: WI-1\n', requested);
    expect(links).toEqual([{ workItemId: 'WI-1', attribution: 'authoritative' }]);
  });

  it('ignores ids outside the requested page', () => {
    expect(commitLinksFor('Papercusp-Work-Item: WI-999\nalso WI-42\n', requested)).toEqual([]);
  });
});

describe('the provider', () => {
  it('scopes and paginates the plan read, and filters rubric + archived plans', async () => {
    const { source, calls } = sourceWith([[{ plan_slug: 'a', content: '# a', updated_at: null }]]);
    const plans = await source.provider.loadPlans();

    expect(calls[0]?.params).toEqual(['ws-test', 'demo', 3, 6]);
    expect(calls[0]?.text).toContain("template IS DISTINCT FROM 'rubric'");
    expect(calls[0]?.text).toContain('archived IS NOT TRUE');
    // The canonical projection path, not any path on this box: it is what the parser
    // falls back to for a slug when the plan's frontmatter omits one.
    expect(plans).toEqual([{ markdown: '# a', filePath: 'docs/plans/a.md', updatedAt: null }]);
  });

  it('drops a plan row with empty markdown rather than emitting an unparseable plan', async () => {
    const { source } = sourceWith([[
      { plan_slug: 'a', content: '', updated_at: null },
      { plan_slug: null, content: '# b', updated_at: null },
      { plan_slug: 'c', content: '# c', updated_at: null },
    ]]);
    expect((await source.provider.loadPlans()).map((plan) => plan.filePath)).toEqual(['docs/plans/c.md']);
  });

  it('short-circuits an empty id list without touching the database or git', async () => {
    const { source, calls } = sourceWith([]);
    expect(await source.provider.loadWorkItems?.([])).toEqual([]);
    expect(await source.provider.loadCommits?.([])).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('degrades to no commit links when git fails, instead of failing the page', async () => {
    const { source } = sourceWith([], () => Promise.reject(new Error('index.lock held mid-sweep')));
    await expect(source.provider.loadCommits?.(['WI-1'])).resolves.toEqual([]);
  });

  it('keeps only commits that actually link to a requested id', async () => {
    const raw = [
      `${RS}${'a'.repeat(40)}${NUL}s${NUL}2026-09-01T00:00:00Z${NUL}Papercusp-Work-Item: WI-1${NUL}a.ts`,
      `${RS}${'b'.repeat(40)}${NUL}s${NUL}2026-09-01T00:00:00Z${NUL}unrelated sweep${NUL}b.ts`,
    ].join('');
    const { source } = sourceWith([], () => Promise.resolve(raw));
    const commits = await source.provider.loadCommits?.(['WI-1']);

    expect(commits).toHaveLength(1);
    expect(commits?.[0]).toMatchObject({
      sha: 'a'.repeat(40),
      // Local commits here are pushed by git-sync on a schedule, so a local commit is
      // not yet proof of a remote one; claiming `confirmed` would be a lie.
      remoteStatus: 'unknown',
      links: [{ workItemId: 'WI-1', attribution: 'authoritative' }],
    });
  });

  it('counts plans through the SAME filter the page read uses', async () => {
    const { source, calls } = sourceWith([[{ total: 1448 }]]);
    expect(await source.countPlans()).toBe(1448);
    // A total computed under different predicates would make `hasMore` lie.
    expect(calls[0]?.text).toContain("template IS DISTINCT FROM 'rubric'");
    expect(calls[0]?.params).toEqual(['ws-test', 'demo']);
  });

  it('coerces a driver-stringified count', async () => {
    const { source } = sourceWith([[{ total: '42' }]]);
    expect(await source.countPlans()).toBe(42);
  });

  it('treats a missing remote as a document without links, not a failure', async () => {
    const { source } = sourceWith([], () => Promise.reject(new Error('no such remote')));
    await expect(source.detectRepository()).resolves.toBeNull();
  });

  it('strips the origin/ prefix from the default branch', async () => {
    const git = vi.fn(async (args: readonly string[]) => (
      args[0] === 'remote' ? 'git@github.com:Papercusp/demo.git\n' : 'origin/main\n'
    ));
    const { source } = sourceWith([], git);
    await expect(source.detectRepository()).resolves.toMatchObject({ defaultBranch: 'main' });
  });
});

describe('page sizing', () => {
  it('keeps the default page well under the hard cap', () => {
    expect(PROJECT_HISTORY_PAGE_SIZE).toBeLessThan(PROJECT_HISTORY_MAX_PAGE_SIZE);
  });
});
