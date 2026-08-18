/**
 * affected-tests-changed-path-provenance.test.ts — EI-20812741760514969 regression guard.
 *
 * `scripts/affected-tests.mjs` with no `--changed-paths` derives its blast radius from git:
 * committed (`<base>...HEAD`) + working tree + untracked + dirty submodules. On the shared
 * fleet checkout that set is the whole fleet's work, and `origin/main` (the default base)
 * only fast-forwards on a green checkpoint — so a three-file edit was measured selecting 71
 * workspaces / 89 tasks while the agent's own `--changed-paths` probe said 5. Nothing
 * reported the mismatch: the only symptom was "this is slower than the estimate".
 *
 * The fix is DISCLOSURE, not narrowing — the wide set is correct for the green-checkpoint
 * gate, which certifies the whole candidate. So what is pinned here is that every run says
 * where its radius came from, and that an unscoped, tree-sized derivation says so loudly.
 *
 * NOTE ON CONTROLS. Every "no banner" assertion below is paired with a case that MUST
 * produce one, and every "banner" assertion with a case that must not. A one-directional
 * suite here would pass just as happily against a renderer that returned [] unconditionally
 * (or one that shouted on every run), which is the failure mode these guards exist to catch.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  summarizeDerivation,
  formatDerivationMarker,
  derivationBannerLines,
  dominantLeg,
  DERIVATION_MARKER,
  SHARED_TREE_PATH_WARN,
} from '../../../../scripts/lib/changed-path-provenance.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const AFFECTED_TESTS = resolve(REPO_ROOT, 'scripts/affected-tests.mjs');

/** Run the real CLI in its enumeration mode — it exits before any suite runs. */
function probe(args: string[]): { stdout: string; stderr: string; status: number | null } {
  const r = spawnSync('node', [AFFECTED_TESTS, ...args, '--print-affected'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  expect(r.status, `affected-tests --print-affected failed:\n${r.stderr}`).toBe(0);
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status };
}

function markerLines(stdout: string): string[] {
  return stdout.split('\n').filter((l) => l.startsWith(`${DERIVATION_MARKER} `));
}

function markerField(line: string, key: string): string | undefined {
  return line
    .split(' ')
    .find((tok) => tok.startsWith(`${key}=`))
    ?.slice(key.length + 1);
}

/** A tree-sized, unscoped derivation dominated by base drift — the measured live case. */
const LIVE_SHAPE = {
  source: 'git-status',
  total: 2274,
  legs: { committed: 2274, uncommitted: 2, untracked: 0, submoduleDirty: 1 },
  base: 'origin/main',
  baseCommitsBehind: 1536,
};

describe('changed-path provenance: the marker (EI-20812741760514969)', () => {
  it('reports the source, the deduped total, the legs and the base drift', () => {
    const line = formatDerivationMarker(summarizeDerivation(LIVE_SHAPE), {
      workspaces: 71,
      guards: 19,
      tasks: 90,
    });
    expect(line.startsWith(`${DERIVATION_MARKER} `)).toBe(true);
    expect(markerField(line, 'source')).toBe('git-status');
    expect(markerField(line, 'changedPaths')).toBe('2274');
    expect(markerField(line, 'committed')).toBe('2274');
    expect(markerField(line, 'uncommitted')).toBe('2');
    expect(markerField(line, 'base')).toBe('origin/main');
    expect(markerField(line, 'baseBehind')).toBe('1536');
    expect(markerField(line, 'workspaces')).toBe('71');
    expect(markerField(line, 'tasks')).toBe('90');
  });

  it('omits a leg it did not measure instead of reporting it as zero', () => {
    // A fabricated `committed=0` is indistinguishable from a real measurement of zero, and
    // this line's whole job is to say what was measured. `--all` shells no git at all.
    const line = formatDerivationMarker(summarizeDerivation({ source: 'all' }), {
      workspaces: 103,
    });
    expect(line).not.toMatch(/committed=/);
    expect(line).not.toMatch(/baseBehind=/);
    // Control: the same renderer DOES emit those fields when they were measured, so the
    // absence above is the omission rule and not a renderer that never emits legs.
    expect(formatDerivationMarker(summarizeDerivation(LIVE_SHAPE), {})).toMatch(/committed=/);
  });

  it('distinguishes "ran everything because you asked" from "because git failed"', () => {
    // Both run every workspace; only the second is a bug, and collapsing them is how the
    // EI-1989 degrade-to-everything hid in plain sight as a normal slow run.
    expect(markerField(formatDerivationMarker(summarizeDerivation({ source: 'all' }), {}), 'source')).toBe('all');
    expect(
      markerField(
        formatDerivationMarker(summarizeDerivation({ source: 'git-fallback-all' }), {}),
        'source',
      ),
    ).toBe('git-fallback-all');
  });
});

describe('changed-path provenance: the banner', () => {
  it('fires for an unscoped tree-sized derivation', () => {
    const lines = derivationBannerLines(summarizeDerivation(LIVE_SHAPE), {
      workspaces: 71,
      tasks: 90,
    });
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).toMatch(/--changed-paths/);
  });

  it('stays silent when the CALLER scoped the run', () => {
    const scoped = derivationBannerLines(
      summarizeDerivation({ source: 'explicit', total: LIVE_SHAPE.total }),
      { workspaces: 71 },
    );
    expect(scoped).toEqual([]);
    // Control: the identical total DOES warn when it was derived rather than named, so the
    // silence above is the scoped rule — not a threshold that swallows everything.
    expect(
      derivationBannerLines(summarizeDerivation(LIVE_SHAPE), { workspaces: 71 }).length,
    ).toBeGreaterThan(0);
  });

  it('stays silent for a handful of paths — that is the normal single-developer case', () => {
    const small = { ...LIVE_SHAPE, total: SHARED_TREE_PATH_WARN - 1, legs: { committed: SHARED_TREE_PATH_WARN - 1 } };
    expect(derivationBannerLines(summarizeDerivation(small), {})).toEqual([]);
    const atThreshold = { ...small, total: SHARED_TREE_PATH_WARN, legs: { committed: SHARED_TREE_PATH_WARN } };
    expect(derivationBannerLines(summarizeDerivation(atThreshold), {}).length).toBeGreaterThan(0);
  });

  it('names the leg that actually blew the radius up, both ways', () => {
    // This is the actionable half. A radius dominated by `committed` is BASE DRIFT — telling
    // that reader to go commit or revert dirty work sends them at the wrong lever. The filed
    // report assumed dirty work; the measurement was 2274 committed against 2 uncommitted.
    expect(dominantLeg(summarizeDerivation(LIVE_SHAPE))).toBe('committed');
    expect(derivationBannerLines(summarizeDerivation(LIVE_SHAPE), {}).join('\n')).toMatch(
      /base drift/i,
    );

    const dirtyTree = summarizeDerivation({
      source: 'git-status',
      total: 400,
      legs: { committed: 3, uncommitted: 300, untracked: 97, submoduleDirty: 0 },
      base: 'origin/main',
      baseCommitsBehind: 1,
    });
    expect(dominantLeg(dirtyTree)).toBe('uncommitted');
    expect(derivationBannerLines(dirtyTree, {}).join('\n')).not.toMatch(/base drift/i);
  });
});

describe('changed-path provenance: through the real CLI', () => {
  it('emits exactly one marker for an explicit path set, and no banner', () => {
    const { stdout, stderr } = probe(['--changed-paths', 'scripts/lint-tsc.mjs']);
    const lines = markerLines(stdout);
    expect(lines).toHaveLength(1);
    expect(markerField(lines[0], 'source')).toBe('explicit');
    expect(markerField(lines[0], 'changedPaths')).toBe('1');
    expect(Number(markerField(lines[0], 'workspaces'))).toBeGreaterThan(0);
    expect(stderr).not.toMatch(/blast radius was DERIVED FROM THE TREE/);
  });

  it('reports the git-derived source, and its count matches the selection it printed', () => {
    const { stdout, stderr } = probe([]);
    const lines = markerLines(stdout);
    expect(lines).toHaveLength(1);
    const line = lines[0];
    // A git failure degrades to every workspace; that is a different source and a different
    // (louder) reading, so accept either rather than pinning a tree state we do not control.
    expect(['git-status', 'git-fallback-all']).toContain(markerField(line, 'source'));

    const printed = stdout.split('\n').filter((l) => l.startsWith('AFFECTED_WS\t')).length;
    expect(
      Number(markerField(line, 'workspaces')),
      'the marker must describe the SAME selection the run printed — a provenance line that ' +
        'reports a different scope than the one that executes is worse than none',
    ).toBe(printed);

    if (markerField(line, 'source') === 'git-status') {
      expect(markerField(line, 'base')).toBeTruthy();
      const total = Number(markerField(line, 'changedPaths'));
      // Both directions are pinned: tree-sized ⇒ the banner fires; small ⇒ it must not.
      // (A clean checkout — the green-checkpoint's own — legitimately takes the second.)
      if (total >= SHARED_TREE_PATH_WARN) {
        expect(stderr).toMatch(/blast radius was DERIVED FROM THE TREE/);
        expect(stderr).toMatch(/--changed-paths/);
      } else {
        expect(stderr).not.toMatch(/blast radius was DERIVED FROM THE TREE/);
      }
    }
  });

  it('says `all` when the caller asked for every workspace', () => {
    const { stdout } = probe(['--all']);
    const lines = markerLines(stdout);
    expect(lines).toHaveLength(1);
    expect(markerField(lines[0], 'source')).toBe('all');
  });
});
