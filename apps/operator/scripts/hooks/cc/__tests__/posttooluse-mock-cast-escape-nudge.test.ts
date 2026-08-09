/**
 * posttooluse-mock-cast-escape-nudge — the author-time half of the
 * `lint:mock-cast-escape` ratchet (WI-37497; the burn-down half was WI-37495).
 *
 * THE POINT OF THIS FILE: the ratchet has now been burned down twice
 * (EI-19452618085391226: 1121 -> 1061 on 2026-08-03; WI-37495: 1113 -> 1076 on
 * 2026-08-09) and climbed back both times, the second time freezing `main` as the
 * SOLE holder of a red gate. A guard already existed; nothing told the author. So
 * the assertion that matters is not "the hook is well-formed" but **it FIRES on the
 * real thing** — exercised against the REAL exported `findMockCastEscapesInText`
 * from scripts/check-mock-cast-escape.mjs, never a stand-in. A hook wired to a
 * re-implemented regex would be the third mitigation that measures the wrong
 * population.
 *
 * THE NEGATIVE CASES CARRY EQUAL WEIGHT, and two of them are load-bearing:
 * `x as unknown as T` and a bare `const x = y as never` are NOT counted by the
 * ratchet. Measured while triaging WI-37495: a hand-grep on `as never|as unknown as`
 * counts 7656 tree-wide against the guard's 1113 — a DIFFERENT POPULATION. If this
 * hook ever starts firing on those, it is nudging about casts that cost the gate
 * nothing, and a nudge that cries wolf is one agents learn to ignore.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

// __dirname = <repo>/apps/operator/scripts/hooks/cc/__tests__ — six levels down.
const ROOT = resolve(__dirname, '../../../../../..');
const HOOK = resolve(__dirname, '../posttooluse-mock-cast-escape-nudge.mjs');
const SUBJECT = resolve(ROOT, 'packages/operator-core/lib/x.test.ts');

type Escape = { line: number; verb: string; kind: 'never' | 'any'; snippet: string };

/** The REAL matcher — the whole value of this suite is that it is not a fake. */
async function realFinder() {
  const mod = await import(`file://${resolve(ROOT, 'scripts/check-mock-cast-escape.mjs')}`);
  return mod.findMockCastEscapesInText as (t: string) => Escape[];
}

async function loadHook() {
  return (await import(`file://${HOOK}`)) as {
    nudgeFor: (p: string, deps?: Record<string, unknown>) => Promise<string | null>;
    isCandidateFile: (p: string) => boolean;
    newEscapes: (b: Escape[], a: Escape[]) => Escape[];
  };
}

/** Deps that use the REAL finder but inject file content, so no tree write is needed. */
async function depsWith(before: string, after: string) {
  const find = await realFinder();
  return {
    exists: () => true,
    sizeOf: () => 100,
    readFile: () => after,
    showHead: () => before,
    loadFinder: async () => find,
  };
}

describe('mock-cast-escape nudge — fires on a real ratchet increase', () => {
  it('FIRES when an `as never` mock cast is added, naming the delta and the new site', async () => {
    const hook = await loadHook();
    const out = await hook.nudgeFor(
      SUBJECT,
      await depsWith(
        'vi.mocked(load).mockResolvedValue({ a: 1 } as never);',
        'vi.mocked(load).mockResolvedValue({ a: 1 } as never);\nvi.mocked(read).mockResolvedValue({ b: 2 } as never);',
      ),
    );
    expect(out).not.toBeNull();
    expect(out).toContain('+1');
    expect(out).toContain('1 → 2');
    // The NEW site, not the pre-existing one.
    expect(out).toContain('{ b: 2 } as never');
    expect(out).not.toContain('{ a: 1 } as never');
    // It must name the alternatives, since the author is the only one who can choose them.
    expect(out).toContain('typed-mock.ts');
    // And must never counsel the one action that would defeat the ratchet.
    expect(out).toContain('Do NOT raise .mock-cast-escape-baseline.json');
  });

  it('FIRES on `as any` too — the guard counts both kinds', async () => {
    const hook = await loadHook();
    const out = await hook.nudgeFor(
      SUBJECT,
      await depsWith('const x = 1;', 'vi.mocked(load).mockResolvedValue({ a: 1 } as any);'),
    );
    expect(out).not.toBeNull();
    expect(out).toContain('as any');
  });

  it('FIRES for a BRAND-NEW test file with no HEAD version — the deliberate divergence from the strand nudge', async () => {
    // A new interface cannot strand pre-existing construction sites, so the sibling hook
    // skips a missing HEAD. A brand-new test file full of `as never` raises the count and
    // reds the gate exactly like an edit to an existing file, so skipping it here would
    // leave the most likely breach path uncovered while looking complete.
    const hook = await loadHook();
    const deps = await depsWith('', 'vi.mocked(load).mockResolvedValue({ a: 1 } as never);');
    const out = await hook.nudgeFor(SUBJECT, { ...deps, showHead: () => null });
    expect(out).not.toBeNull();
    expect(out).toContain('0 → 1');
  });

  it('reports the true total when several are added at once', async () => {
    const hook = await loadHook();
    const after = [
      'vi.mocked(a).mockResolvedValue(1 as never);',
      'vi.mocked(b).mockReturnValue(2 as never);',
      'vi.mocked(c).mockRejectedValueOnce(3 as never);',
    ].join('\n');
    const out = await hook.nudgeFor(SUBJECT, await depsWith('const x = 1;', after));
    expect(out).not.toBeNull();
    expect(out).toContain('+3');
    expect(out).toContain('0 → 3');
  });
});

describe('mock-cast-escape nudge — measures the GUARD’s population, not a grep', () => {
  it('is SILENT for `as unknown as T` — counted by a hand-grep, NOT by the ratchet', async () => {
    // This is the exact error made while triaging WI-37495: `as never|as unknown as`
    // counts 7656 tree-wide against the guard's 1113.
    const hook = await loadHook();
    const out = await hook.nudgeFor(
      SUBJECT,
      await depsWith('const x = 1;', 'const store = fake as unknown as PgL2Store;'),
    );
    expect(out).toBeNull();
  });

  it('is SILENT for an `as never` OUTSIDE a mock call — the ratchet only counts mock arguments', async () => {
    const hook = await loadHook();
    const out = await hook.nudgeFor(SUBJECT, await depsWith('const x = 1;', 'const y = someValue as never;'));
    expect(out).toBeNull();
  });

  it('is SILENT for the literal text "as never" inside a STRING — the guard masks strings', async () => {
    const hook = await loadHook();
    const out = await hook.nudgeFor(
      SUBJECT,
      await depsWith('const x = 1;', 'expect(msg).toBe("do not write as never");'),
    );
    expect(out).toBeNull();
  });
});

describe('mock-cast-escape nudge — stays silent when it should', () => {
  it('is SILENT when an escape is REMOVED (a burn-down must not nag its author)', async () => {
    const hook = await loadHook();
    const out = await hook.nudgeFor(
      SUBJECT,
      await depsWith(
        'vi.mocked(a).mockResolvedValue(1 as never);\nvi.mocked(b).mockResolvedValue(2 as never);',
        'vi.mocked(a).mockResolvedValue(1 as never);',
      ),
    );
    expect(out).toBeNull();
  });

  it('is SILENT when the count is unchanged but the code moved', async () => {
    const hook = await loadHook();
    const out = await hook.nudgeFor(
      SUBJECT,
      await depsWith(
        'vi.mocked(a).mockResolvedValue(1 as never);',
        '// a new comment\nvi.mocked(a).mockResolvedValue(1 as never);',
      ),
    );
    expect(out).toBeNull();
  });

  it('is SILENT for an ordinary edit that adds no cast', async () => {
    const hook = await loadHook();
    const out = await hook.nudgeFor(
      SUBJECT,
      await depsWith('const x = 1;', 'const x = 1;\nexport const NOTE = 2;'),
    );
    expect(out).toBeNull();
  });

  it('skips a non-test file without invoking git at all', async () => {
    const hook = await loadHook();
    const deps = await depsWith('const x = 1;', 'vi.mocked(a).mockResolvedValue(1 as never);');
    const out = await hook.nudgeFor(resolve(ROOT, 'packages/operator-core/lib/x.ts'), {
      ...deps,
      showHead: () => {
        throw new Error('git must not be consulted for a non-test file');
      },
    });
    expect(out).toBeNull();
  });

  it('matches exactly the guard’s own file population', async () => {
    const hook = await loadHook();
    expect(hook.isCandidateFile('a/b.test.ts')).toBe(true);
    expect(hook.isCandidateFile('a/b.test.tsx')).toBe(true);
    expect(hook.isCandidateFile('a/b.ts')).toBe(false);
    expect(hook.isCandidateFile('a/b.tsx')).toBe(false);
    expect(hook.isCandidateFile('a/b.d.ts')).toBe(false);
  });
});

describe('mock-cast-escape nudge — the new-site diff', () => {
  it('attributes ONE new site when an identical snippet is duplicated', async () => {
    // Line numbers shift under any edit above them, so the diff is a multiset over
    // snippet text: N before and N+1 after must yield exactly one new site.
    const hook = await loadHook();
    const line = 'vi.mocked(a).mockResolvedValue(1 as never);';
    const find = await realFinder();
    const before = find(line);
    const after = find(`${line}\n${line}`);
    expect(before).toHaveLength(1);
    expect(after).toHaveLength(2);
    expect(hook.newEscapes(before, after)).toHaveLength(1);
  });
});

describe('mock-cast-escape nudge — fails open, never disturbs an edit', () => {
  it('returns null (never throws) when the guard cannot be resolved', async () => {
    const hook = await loadHook();
    const deps = await depsWith('const x = 1;', 'vi.mocked(a).mockResolvedValue(1 as never);');
    await expect(hook.nudgeFor(SUBJECT, { ...deps, loadFinder: async () => null })).resolves.toBeNull();
  });

  it('the shipped --self-test passes (the hook is executable and self-consistent)', () => {
    const out = execFileSync('node', [HOOK, '--self-test'], { encoding: 'utf8' });
    expect(out).toContain('all cases passed');
  });
});
