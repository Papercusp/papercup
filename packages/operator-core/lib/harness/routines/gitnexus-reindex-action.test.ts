/**
 * WI-6454 — the gitnexus re-index cadence policy.
 *
 * The two things worth pinning here are (a) the `--skip-agents-md` guard, which is the
 * difference between a maintenance job and one that corrupts every agent's prompt
 * source, and (b) the ORDER of the gates in `decideReindex` — the policy is only correct
 * if load outranks a missing index and the interval floor outranks staleness.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildAnalyzeArgs,
  decideReindex,
  readRegistryEntry,
  shouldSkipForHive,
  GITNEXUS_REPO_NAME,
  DEFAULT_MAX_LOAD_PER_CORE,
  DEFAULT_MIN_COMMITS_BEHIND,
  DEFAULT_MIN_INTERVAL_SEC,
  type ReindexDecisionInput,
} from './gitnexus-reindex-action';

/** A baseline that WOULD run, so each test can flip exactly one field. */
function baseInput(over: Partial<ReindexDecisionInput> = {}): ReindexDecisionInput {
  return {
    registered: true,
    commitsBehind: 50,
    loadPerCore: 0.5,
    secondsSinceIndexed: 4 * 3600,
    minCommitsBehind: DEFAULT_MIN_COMMITS_BEHIND,
    maxLoadPerCore: DEFAULT_MAX_LOAD_PER_CORE,
    minIntervalSec: DEFAULT_MIN_INTERVAL_SEC,
    ...over,
  };
}

describe('buildAnalyzeArgs', () => {
  it('ALWAYS passes --skip-agents-md (without it, analyze rewrites CLAUDE.md + AGENTS.md)', () => {
    expect(buildAnalyzeArgs('/repo', 'papercusp')).toContain('--skip-agents-md');
  });

  it('names the repo so the alias cannot collide with another checkout on the box', () => {
    const args = buildAnalyzeArgs('/repo', GITNEXUS_REPO_NAME);
    expect(args[args.indexOf('--name') + 1]).toBe(GITNEXUS_REPO_NAME);
  });

  it('analyzes the root it is given, not the process cwd', () => {
    expect(buildAnalyzeArgs('/some/root', 'x')).toContain('/some/root');
  });

  it('does not pass --force (that would defeat any staleness short-circuit analyze does)', () => {
    expect(buildAnalyzeArgs('/repo', 'x')).not.toContain('--force');
  });
});

describe('decideReindex', () => {
  it('runs when the graph is genuinely behind on an idle box', () => {
    const d = decideReindex(baseInput());
    expect(d.run).toBe(true);
    expect(d.reason).toContain('50 commits behind');
  });

  it('skips when the box is oversubscribed', () => {
    const d = decideReindex(baseInput({ loadPerCore: 2.0 }));
    expect(d.run).toBe(false);
    expect(d.reason).toContain('oversubscribed');
  });

  it('lets load OUTRANK a missing index — protecting the box beats a cold build', () => {
    // Ordering guard: a missing index is the most urgent functional condition, but a
    // 4-minute indexer is the worst thing to start on a queueing box. Deferring costs
    // one hour; piling on costs the whole fleet.
    const d = decideReindex(baseInput({ registered: false, loadPerCore: 3.0 }));
    expect(d.run).toBe(false);
    expect(d.reason).toContain('oversubscribed');
  });

  it('cold-builds when nothing is registered, bypassing the interval floor and staleness', () => {
    const d = decideReindex(baseInput({ registered: false, secondsSinceIndexed: 0, commitsBehind: 0 }));
    expect(d.run).toBe(true);
    expect(d.reason).toContain('cold build');
  });

  it('honours the interval floor even when many commits have landed', () => {
    // git-sync commits every few minutes, so commitsBehind climbs fast; the floor — not
    // the commit count — is what bounds steady-state cost.
    const d = decideReindex(baseInput({ secondsSinceIndexed: 10 * 60, commitsBehind: 500 }));
    expect(d.run).toBe(false);
    expect(d.reason).toContain('floor');
  });

  it('skips when nothing has changed', () => {
    const d = decideReindex(baseInput({ commitsBehind: 0 }));
    expect(d.run).toBe(false);
    expect(d.reason).toContain('0 commit(s) behind');
  });

  it('refreshes when the indexed commit is no longer in history (rebase/prune)', () => {
    const d = decideReindex(baseInput({ commitsBehind: null }));
    expect(d.run).toBe(true);
    expect(d.reason).toContain('not in the current history');
  });

  it('treats an unknown-age index as eligible rather than blocking on the floor', () => {
    const d = decideReindex(baseInput({ secondsSinceIndexed: null }));
    expect(d.run).toBe(true);
  });

  it('honours a trigger_config override of the load ceiling', () => {
    expect(decideReindex(baseInput({ loadPerCore: 2.0, maxLoadPerCore: 4 })).run).toBe(true);
  });

  it('applies the interval floor at the boundary, not just past it', () => {
    expect(decideReindex(baseInput({ secondsSinceIndexed: DEFAULT_MIN_INTERVAL_SEC - 1 })).run).toBe(false);
    expect(decideReindex(baseInput({ secondsSinceIndexed: DEFAULT_MIN_INTERVAL_SEC })).run).toBe(true);
  });
});

describe('readRegistryEntry', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gitnexus-reg-'));

  it('reads the named repo out of the registry array', () => {
    const f = join(dir, 'ok.json');
    writeFileSync(
      f,
      JSON.stringify([
        { name: 'other', lastCommit: 'aaa' },
        { name: 'papercusp', lastCommit: 'bbb', indexedAt: '2026-07-27T19:38:08.913Z' },
      ]),
    );
    expect(readRegistryEntry(f, 'papercusp')?.lastCommit).toBe('bbb');
  });

  it('returns null for an alias that is not registered', () => {
    const f = join(dir, 'missing.json');
    writeFileSync(f, JSON.stringify([{ name: 'other' }]));
    expect(readRegistryEntry(f, 'papercusp')).toBeNull();
  });

  // Every read failure must collapse to "no index" (⇒ build one), never throw a tick.
  it.each([
    ['absent file', null],
    ['unparseable json', '{not json'],
    ['not an array', '{"name":"papercusp"}'],
  ])('returns null on %s instead of throwing', (label, contents) => {
    const f = join(dir, `${String(label).replace(/\W/g, '')}.json`);
    if (contents != null) writeFileSync(f, contents);
    expect(readRegistryEntry(f, 'papercusp')).toBeNull();
  });
});

describe('shouldSkipForHive', () => {
  it('skips a per-hive harness — the graph indexes the operator-home repo', () => {
    const g = shouldSkipForHive('some-hive', 'papercusp');
    expect(g.skip).toBe(true);
  });

  it('runs for the operator-home harness', () => {
    expect(shouldSkipForHive('papercusp', 'papercusp').skip).toBe(false);
  });

  it('treats a blank slug (manual/legacy fire) as operator-home', () => {
    expect(shouldSkipForHive(undefined, 'papercusp').skip).toBe(false);
    expect(shouldSkipForHive('', 'papercusp').skip).toBe(false);
  });
});
