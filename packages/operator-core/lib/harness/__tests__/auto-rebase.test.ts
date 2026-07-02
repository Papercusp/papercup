/**
 * autoRebaseOnPush — §16.3 auto-rebase-on-push.
 *
 * All side effects are injected via module mocks: `git` (node:child_process
 * execFile) and the org PG pool (getOrgPg). The pure escalation/stash-ref
 * builders (sync-with-main-types) run for real.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface GitCfg {
  fetchFail?: boolean;
  rebaseErr?: string | null; // error message thrown by `git rebase origin/main`; null = success
  diffFiles?: string[]; // files returned by `git diff --diff-filter=U`
  pushFail?: boolean;
}

let gitCalls: string[][] = [];
const sqlUnsafe = vi.fn(async (..._args: unknown[]) => [] as unknown[]);

function makeExecFile(cfg: GitCfg) {
  return (_cmd: string, args: string[], _opts: unknown, cb: (e: Error | null, r?: { stdout: string; stderr: string }) => void) => {
    gitCalls.push(args);
    const ok = (stdout = '') => cb(null, { stdout, stderr: '' });
    const fail = (msg: string) => cb(Object.assign(new Error(msg), { stderr: msg }));
    const sub = args[0];
    if (sub === 'fetch') return cfg.fetchFail ? fail('could not fetch') : ok();
    if (sub === 'rebase' && args[1] === 'origin/main') return cfg.rebaseErr ? fail(cfg.rebaseErr) : ok();
    if (sub === 'rebase' && args[1] === '--abort') return ok();
    if (sub === 'diff') return ok((cfg.diffFiles ?? []).join('\n'));
    if (sub === 'push') return cfg.pushFail ? fail('push rejected') : ok();
    return ok();
  };
}

async function loadAutoRebase(cfg: GitCfg, opts: { sqlThrows?: boolean } = {}) {
  gitCalls = [];
  sqlUnsafe.mockReset();
  if (opts.sqlThrows) sqlUnsafe.mockImplementation(async () => { throw new Error('PG down'); });
  else sqlUnsafe.mockImplementation(async () => []);
  vi.doMock('node:child_process', () => ({ execFile: makeExecFile(cfg) }));
  vi.doMock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql: { unsafe: sqlUnsafe } }) }));
  const mod = await import('../auto-rebase');
  return mod.autoRebaseOnPush;
}

beforeEach(() => {
  vi.resetModules();
  vi.spyOn(Date, 'now').mockReturnValue(1000); // deterministic stash-ref timestamp
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('node:child_process');
  vi.doUnmock('@papercusp/db-org');
});

const BASE = { repoPath: '/repo', featureId: 'F-42', harnessSlug: 'myharness' };
const unsafeCalls = () => sqlUnsafe.mock.calls.map((c) => String(c[0]));

describe('autoRebaseOnPush', () => {
  it('clean rebase → { ok: true }, no escalation / no stash push', async () => {
    const run = await loadAutoRebase({ rebaseErr: null });
    const res = await run({ ...BASE, githubUserId: 7 });
    expect(res).toEqual({ ok: true });
    // No escalation row written on a clean rebase.
    expect(unsafeCalls().some((q) => /harness_escalations/.test(q))).toBe(false);
    expect(gitCalls.some((a) => a[0] === 'push')).toBe(false);
  });

  it('fetch failure → { ok: false, reason: "fetch_failed" } and never rebases', async () => {
    const run = await loadAutoRebase({ fetchFail: true });
    const res = await run(BASE);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('fetch_failed');
    expect(gitCalls.some((a) => a[0] === 'rebase' && a[1] === 'origin/main')).toBe(false);
  });

  it('non-conflict rebase error → aborts + { ok: false, reason: "unknown" }', async () => {
    const run = await loadAutoRebase({ rebaseErr: 'fatal: some other git error', diffFiles: [] });
    const res = await run(BASE);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('unknown');
    expect(gitCalls.some((a) => a[0] === 'rebase' && a[1] === '--abort')).toBe(true);
  });

  it('conflict → typed result + stash push + escalation row + feature reset', async () => {
    const run = await loadAutoRebase({ rebaseErr: 'CONFLICT (content): merge conflict in a.ts', diffFiles: ['a.ts', 'b.ts'] });
    const res = await run({ ...BASE, githubUserId: 123 });
    expect(res.ok).toBe(false);
    if (!res.ok && res.reason === 'conflict') {
      expect(res.conflicted_files).toEqual(['a.ts', 'b.ts']);
      expect(res.stash_ref).toBe('wip/conflict-F-42-1000');
      expect(res.escalation_slug).toBe('myharness');
    } else {
      throw new Error('expected conflict result');
    }
    // rebase aborted before stash push
    expect(gitCalls.some((a) => a[0] === 'rebase' && a[1] === '--abort')).toBe(true);
    // WIP pushed to the stash ref
    expect(gitCalls.some((a) => a[0] === 'push' && a.includes('HEAD:refs/heads/wip/conflict-F-42-1000'))).toBe(true);
    // escalation row INSERTed with rebase_conflict shape
    expect(unsafeCalls().some((q) => /INSERT INTO harness_shared\.harness_escalations/.test(q))).toBe(true);
    // feature reset to in_queue + working_users cleared
    expect(unsafeCalls().some((q) => /UPDATE .*\.features/.test(q) && /in_queue/.test(q))).toBe(true);
  });

  it('conflict without githubUserId → no feature-reset UPDATE', async () => {
    const run = await loadAutoRebase({ rebaseErr: 'CONFLICT in x', diffFiles: ['x.ts'] });
    const res = await run(BASE);
    expect(res.ok).toBe(false);
    expect(unsafeCalls().some((q) => /UPDATE .*\.features/.test(q))).toBe(false);
  });

  it('escalation write failure is non-fatal — still returns the conflict result', async () => {
    const run = await loadAutoRebase({ rebaseErr: 'CONFLICT in x', diffFiles: ['x.ts'] }, { sqlThrows: true });
    const res = await run({ ...BASE, githubUserId: 9 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('conflict');
  });

  // Edge case (formerly a bug): `git rebase` reports a CONFLICT in stderr but
  // `git diff --diff-filter=U` lists zero unmerged files (submodule conflicts,
  // or the `rebase --abort` clearing the index before we read it). Previously
  // autoRebaseOnPush threw out of buildRebaseConflictEscalation (non-empty
  // assert). Now it falls back to a sentinel path so the conflict still
  // escalates + the feature still resets, rather than throwing.
  it('CONFLICT text with zero unmerged files escalates gracefully with a sentinel path (no throw)', async () => {
    const run = await loadAutoRebase({ rebaseErr: 'CONFLICT (content): merge conflict', diffFiles: [] });
    const res = await run({ ...BASE, githubUserId: 5 });
    expect(res.ok).toBe(false);
    if (!res.ok && res.reason === 'conflict') {
      expect(res.conflicted_files).toHaveLength(1);
      expect(res.conflicted_files[0]).toMatch(/unidentified/i);
    } else {
      throw new Error('expected a graceful conflict result, not ' + JSON.stringify(res));
    }
    // the conflict still lands an escalation + resets the feature
    expect(unsafeCalls().some((q) => /INSERT INTO harness_shared\.harness_escalations/.test(q))).toBe(true);
    expect(unsafeCalls().some((q) => /UPDATE .*\.features/.test(q) && /in_queue/.test(q))).toBe(true);
  });
});
