/**
 * Unit + integration coverage for the shared git-history helper. Its sole
 * remaining consumer is the `revisions-backfill` — plans are PG-canonical
 * (plans-pg-canonical-migration-2026-06-03) and the `docs/plans/*.md` files
 * were git-rm'd, so the helper reconstructs each plan's pre-removal history
 * from git (`log --follow` + `show <hash>:<path>`). The old `plans:history`
 * / `plans:diff` tools and the `/api/admin/plans/git/:op` route were deleted
 * in that migration.
 *
 * Pure pieces (`parseHistory`, slug/hash validation) get isolated unit
 * tests; the git invocation itself is exercised through the real (now
 * removed-at-HEAD but fully historied) `agent-plan-tracking-2026-05-20.md`
 * plan. Falls back to a clean skip if `git` isn't on PATH.
 */

import { execFile } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  parseHistory,
  readPlanHistory,
  readPlanFileAtCommit,
  PLAN_GIT_SLUG_RE,
  PLAN_GIT_HASH_RE,
} from '../git-history';

/**
 * WI-3831: `git --version` only proves the binary is on PATH, not that CWD is
 * inside an actual repository — a release SOURCE BUNDLE ships without `.git`
 * (papercusp-desktop/bin/stage-source-tree.sh excludes it) but keeps `git` on
 * PATH there, so the old check let these tests run, shell out to `git log
 * --follow`, get "not a git repository", and fail `r.ok === true`. Check the
 * property that actually matters.
 */
function gitAvailable(): Promise<boolean> {
  return new Promise((r) => {
    execFile('git', ['rev-parse', '--is-inside-work-tree'], (err, stdout) => {
      r(!err && stdout.trim() === 'true');
    });
  });
}

/**
 * EI-8537: a SHALLOW checkout (`git rev-parse --is-shallow-repository` →
 * true) truncates history at its clone/fetch-depth boundary — on this repo's
 * shared dev-box checkouts (staging + the release/checkpoint worktrees, all
 * confirmed shallow) that boundary sits WELL AFTER the pre-PG-canonical-
 * migration commits that touched `agent-plan-tracking-2026-05-20.md` (its
 * real historical path was `apps/operator/docs/plans/...`, reachable via
 * `--all`/`main` but not from a shallow `staging` HEAD) — so `git log
 * --follow` on that path genuinely, deterministically returns zero commits
 * here, no matter how healthy `readPlanHistory` is. CI runs `fetch-depth: 0`
 * (test.yml) and gets full, real coverage of this exact assertion; a shallow
 * dev box cannot, so it skips cleanly here — mirroring the existing
 * `gitAvailable()` skip immediately below, not a weakened assertion.
 */
function isShallowRepo(): Promise<boolean> {
  return new Promise((r) => {
    execFile('git', ['rev-parse', '--is-shallow-repository'], (err, stdout) => {
      if (err) return r(false);
      r(stdout.trim() === 'true');
    });
  });
}

describe('parseHistory', () => {
  it('returns [] for empty stdout', () => {
    expect(parseHistory('')).toEqual([]);
  });

  it('parses NUL-separated lines', () => {
    const line = ['abc1234', 'Alice', '2026-05-20T10:00:00Z', 'first commit'].join('\x00');
    expect(parseHistory(line)).toEqual([
      { hash: 'abc1234', author: 'Alice', date: '2026-05-20T10:00:00Z', subject: 'first commit' },
    ]);
  });

  it('handles a subject that contains NUL — joins the trailing pieces back', () => {
    const line = ['h1', 'A', 'd', 'subject\x00with\x00nul'].join('\x00');
    const [c] = parseHistory(line);
    expect(c.subject).toBe('subject\x00with\x00nul');
  });

  it('skips blank lines between records', () => {
    const a = ['h1', 'A', 'd1', 's1'].join('\x00');
    const b = ['h2', 'B', 'd2', 's2'].join('\x00');
    expect(parseHistory(`${a}\n\n${b}\n`)).toHaveLength(2);
  });

  it('returns four fields even when later columns are absent', () => {
    expect(parseHistory('justhash')).toEqual([
      { hash: 'justhash', author: '', date: '', subject: '' },
    ]);
  });
});

describe('slug + hash validation regexes', () => {
  it('accepts kebab-case, uppercase (BRIEF-/HANDOFF-), and dotted slugs', () => {
    expect(PLAN_GIT_SLUG_RE.test('plans-admin-ui-2026-05-20')).toBe(true);
    expect(PLAN_GIT_SLUG_RE.test('a-b')).toBe(true);
    // The regex was widened to the canonical VALID_PLAN_SLUG char set so
    // non-kebab plan slugs (uppercase BRIEF-*/HANDOFF-*, dotted) backfill too.
    expect(PLAN_GIT_SLUG_RE.test('BRIEF-pg-canonical-migration')).toBe(true);
    expect(PLAN_GIT_SLUG_RE.test('HANDOFF-2026-06-04')).toBe(true);
    expect(PLAN_GIT_SLUG_RE.test('dot.path')).toBe(true);
  });

  it('rejects leading/trailing punctuation, spaces, slashes, traversal', () => {
    // Anchored ends (first+last must be alphanumeric) block a leading `-`
    // (git flag injection) and pure-dot/`..` traversal; `/` is never allowed.
    expect(PLAN_GIT_SLUG_RE.test('__test__')).toBe(false); // leading underscore
    expect(PLAN_GIT_SLUG_RE.test('-leading')).toBe(false);
    expect(PLAN_GIT_SLUG_RE.test('trailing-')).toBe(false);
    expect(PLAN_GIT_SLUG_RE.test('a/b')).toBe(false);
    expect(PLAN_GIT_SLUG_RE.test('../etc/passwd')).toBe(false);
    expect(PLAN_GIT_SLUG_RE.test('Bad Slug!')).toBe(false);
  });

  it('accepts 4–40 hex chars (any case) as a hash', () => {
    expect(PLAN_GIT_HASH_RE.test('a1b2')).toBe(true);
    expect(PLAN_GIT_HASH_RE.test('A1B2C3')).toBe(true);
    expect(PLAN_GIT_HASH_RE.test('0123456789abcdef0123456789abcdef01234567')).toBe(true);
  });

  it('rejects non-hex / too-short / too-long / shell-special', () => {
    expect(PLAN_GIT_HASH_RE.test('abc')).toBe(false);
    expect(PLAN_GIT_HASH_RE.test('xyz1')).toBe(false);
    expect(PLAN_GIT_HASH_RE.test('0123456789abcdef0123456789abcdef012345678')).toBe(false);
    expect(PLAN_GIT_HASH_RE.test('a1b2;rm -rf')).toBe(false);
  });
});

describe('readPlanHistory — input validation', () => {
  it('rejects an invalid slug (no shelling out)', async () => {
    const r = await readPlanHistory('Bad Slug!');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('invalid_slug');
  });

  it('returns an empty commit list for a slug whose file does not exist', async () => {
    // Valid-looking slug but no such plan file.
    const r = await readPlanHistory('never-existed-plan-9999-12-31');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.commits).toEqual([]);
  });
});

describe('readPlanHistory — real history (when git is available)', () => {
  it('returns at least one commit for agent-plan-tracking-2026-05-20', async () => {
    if (!(await gitAvailable())) {
      // Skip cleanly on CI runners without git.
      return;
    }
    const r = await readPlanHistory('agent-plan-tracking-2026-05-20', { limit: 5 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      if (r.commits.length === 0 && (await isShallowRepo())) {
        // EI-8537: shallow dev-box checkout — see isShallowRepo() doc above.
        return;
      }
      // Tracked plan with real history — expect ≥1 commit; cap was 5.
      expect(r.commits.length).toBeGreaterThan(0);
      expect(r.commits.length).toBeLessThanOrEqual(5);
      const c = r.commits[0]!;
      expect(c.hash).toMatch(/^[0-9a-f]{40}$/);
      expect(c.date).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(typeof c.subject).toBe('string');
      expect(typeof c.author).toBe('string');
    }
  });
});

describe('readPlanFileAtCommit — input validation', () => {
  it('rejects an invalid slug before shelling out', async () => {
    const r = await readPlanFileAtCommit('Bad Slug!', 'abc1234');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('invalid_slug');
  });

  it('rejects a non-hex hash', async () => {
    const r = await readPlanFileAtCommit('plans-admin-ui-2026-05-20', 'not-hex');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('invalid_hash');
  });

  it('rejects a shell-injection attempt in the hash', async () => {
    const r = await readPlanFileAtCommit('plans-admin-ui-2026-05-20', 'abc1; rm -rf /');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('invalid_hash');
  });
});

describe('readPlanFileAtCommit — real content (when git is available)', () => {
  it('reconstructs a plan snapshot from a historical commit', async () => {
    if (!(await gitAvailable())) return;
    // The plan file was git-rm'd at HEAD (PG-canonical migration), so the
    // newest commit touching the path is the deletion (empty blob). Walk
    // history and reconstruct the first commit that still has content —
    // exactly what the revisions-backfill does.
    const hist = await readPlanHistory('agent-plan-tracking-2026-05-20', { limit: 20 });
    if (!hist.ok || hist.commits.length === 0) return;
    let reconstructed = '';
    for (const commit of hist.commits) {
      const r = await readPlanFileAtCommit('agent-plan-tracking-2026-05-20', commit.hash);
      expect(r.ok).toBe(true); // never errors — absent blob → empty content
      if (r.ok && r.content.length > 0) {
        reconstructed = r.content;
        break;
      }
    }
    expect(reconstructed.length).toBeGreaterThan(0);
    expect(reconstructed).toContain('slug: agent-plan-tracking-2026-05-20');
  });

  it('returns empty content (not an error) for a path absent at a commit', async () => {
    if (!(await gitAvailable())) return;
    const hist = await readPlanHistory('agent-plan-tracking-2026-05-20', { limit: 1 });
    if (!hist.ok || hist.commits.length === 0) return;
    // A valid-looking slug whose file never existed at that commit —
    // the cat-file probe fails cleanly → empty content, not an error.
    const r = await readPlanFileAtCommit(
      'never-existed-plan-9999-12-31',
      hist.commits[0]!.hash,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.content).toBe('');
  });
});
