/**
 * Unit + integration coverage for the shared git-history helper that
 * backs both the `/api/admin/plans/git/:op` route handler and the
 * `plans:history` / `plans:diff` agent tools.
 *
 * Pure pieces (`parseHistory`, slug/hash validation) get isolated unit
 * tests; the git invocation itself is exercised through the real
 * `agent-plan-tracking-2026-05-20.md` file, which is committed and has
 * real history. Falls back to a clean skip if `git` isn't on PATH.
 */

import { execFile } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  parseHistory,
  readPlanHistory,
  readPlanDiff,
  PLAN_GIT_SLUG_RE,
  PLAN_GIT_HASH_RE,
} from '../git-history';

function gitAvailable(): Promise<boolean> {
  return new Promise((r) => {
    execFile('git', ['--version'], (err) => r(!err));
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
  it('accepts canonical kebab-case slugs', () => {
    expect(PLAN_GIT_SLUG_RE.test('plans-admin-ui-2026-05-20')).toBe(true);
    expect(PLAN_GIT_SLUG_RE.test('a-b')).toBe(true);
  });

  it('rejects underscores, uppercase, leading/trailing hyphens, dots', () => {
    expect(PLAN_GIT_SLUG_RE.test('__test__')).toBe(false);
    expect(PLAN_GIT_SLUG_RE.test('Plans-Admin')).toBe(false);
    expect(PLAN_GIT_SLUG_RE.test('-leading')).toBe(false);
    expect(PLAN_GIT_SLUG_RE.test('trailing-')).toBe(false);
    expect(PLAN_GIT_SLUG_RE.test('dot.path')).toBe(false);
    expect(PLAN_GIT_SLUG_RE.test('../etc/passwd')).toBe(false);
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

describe('readPlanDiff — input validation', () => {
  it('rejects an invalid slug', async () => {
    const r = await readPlanDiff('Bad', 'abc1234');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('invalid_slug');
  });

  it('rejects a non-hex hash', async () => {
    const r = await readPlanDiff('plans-admin-ui-2026-05-20', 'not-hex-at-all');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('invalid_hash');
  });

  it('rejects an attempted shell injection via the hash', async () => {
    const r = await readPlanDiff('plans-admin-ui-2026-05-20', 'abc1; rm -rf /');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('invalid_hash');
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
