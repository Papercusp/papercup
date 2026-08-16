/**
 * Recurrence guard for the WI-39371 corrupted-git-store class.
 *
 * On 2026-08-15 an ad-hoc pre-push-guard install wrote its hook SCRIPT into git
 * REF paths — `<gitdir>/refs/hooks/pre-push` and `<gitdir>/logs/hooks/pre-push`
 * — across 16 module stores. Git reads those expecting an object id, finds
 * `#!/bin/sh`, and the repo becomes UNCLONABLE ("null OID" / "invalid sha1
 * pointer 0000…"). It went unnoticed until it blocked the submodule clone the
 * release gate needed, then took two sessions to trace. This test makes the
 * whole class fail loudly and immediately instead.
 *
 * Two halves, deliberately:
 *   (a) fixture tests pinning the predicate against known-good AND known-bad
 *       content — a PERMANENT falsifiability control, so the guard can never
 *       pass vacuously just because the predicate rotted; and
 *   (b) a live scan of this checkout's real git store.
 *
 * Proving (b) can actually fail needs NO tree mutation: the 36 real corrupt
 * files are preserved under `quarantine-misplaced-hook-refs-20260816/`, so point
 * the scan at them and watch it catch all 36 —
 *
 *   PAPERCUSP_GIT_STORE_GUARD_ROOT=~/papercupai-workspace/quarantine-misplaced-hook-refs-20260816 \
 *     npm run test:file -- packages/operator-core/lib/git-store-ref-integrity.test.ts
 *
 * That override is the one line that keeps this a tier-2 (copy-out) probe rather
 * than a tier-3 in-tree mutation, per CLAUDE.md's mutation-probe tiers.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitStoreFileKind, isValidGitStoreFile } from './git-store-ref-integrity.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Never `join(repoRoot, '.git')`: the gate and release checkouts are WORKTREES
 * whose `.git` is a FILE, so that path walks nothing and the guard passes
 * vacuously. All three checkouts share one common store, and only git resolves it.
 */
function resolveGitCommonDir(): string | null {
  const override = process.env.PAPERCUSP_GIT_STORE_GUARD_ROOT;
  if (override) return override;
  try {
    return execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: HERE,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

// Loose objects are the bulk of a store and can never be refs — pruning them
// during descent is what keeps this scan cheap (~1.3k files instead of ~100k).
const PRUNE_DIRS = new Set(['objects', 'lfs', 'annex']);
const FILE_BUDGET = 20_000;
const READ_CAP = 64 * 1024;

function collectStoreFiles(dir: string, out: string[] = []): string[] {
  if (out.length >= FILE_BUDGET) return out;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // unreadable dir — skip, never fail the walk
  }
  for (const entry of entries) {
    if (out.length >= FILE_BUDGET) break;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!PRUNE_DIRS.has(entry.name)) collectStoreFiles(full, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

describe('git-store ref/log content predicate', () => {
  it('accepts what git actually writes', () => {
    expect(isValidGitStoreFile('ref', 'a'.repeat(40))).toBe(true); // SHA-1 loose ref
    expect(isValidGitStoreFile('ref', `${'0123456789abcdef'.repeat(4)}\n`)).toBe(true); // SHA-256
    expect(isValidGitStoreFile('ref', 'ref: refs/heads/staging\n')).toBe(true); // symbolic
    expect(isValidGitStoreFile('log', '')).toBe(true); // an empty reflog is legal
    expect(
      isValidGitStoreFile('log', `${'a'.repeat(40)} ${'b'.repeat(40)} Someone <x@y> 1 +0000\tpush\n`),
    ).toBe(true);
    // The entry that CREATES a ref carries an all-zero old id — valid, not a null OID.
    expect(isValidGitStoreFile('log', `${'0'.repeat(40)} ${'b'.repeat(40)} S <x@y> 1 +0000\tbranch\n`)).toBe(
      true,
    );
  });

  it('does not flag a reflog whose last line was cut off by a bounded read', () => {
    // Regression: the live scan reads a bounded head, which slices the final
    // line mid-sha. Validating that stump reported two healthy stores as
    // corrupt and would have red-gated the fleet.
    const line = `${'a'.repeat(40)} ${'b'.repeat(40)} S <x@y> 1 +0000\tpush\n`;
    // Cut mid-SHA, which is where the real failure landed ("…eb58bd0ad72"):
    // a cut later in the line leaves the leading id intact and proves nothing.
    const cut = line.repeat(3).slice(0, line.length * 2 + 11);
    expect(isValidGitStoreFile('log', cut, { truncated: true })).toBe(true);
    // …and WITHOUT the flag the stump is (correctly) unparseable — which is
    // exactly why the caller must pass it.
    expect(isValidGitStoreFile('log', cut)).toBe(false);
  });

  it('REJECTS a hook script written to a ref path — the WI-39371 corruption itself', () => {
    const hook = '#!/bin/sh\n# INSTALLED 2026-08-15 by fleet leader\necho "PUSH BLOCKED"\nexit 1\n';
    expect(isValidGitStoreFile('ref', hook)).toBe(false);
    expect(isValidGitStoreFile('log', hook)).toBe(false);
  });

  it('REJECTS the other ways a ref goes null', () => {
    expect(isValidGitStoreFile('ref', '')).toBe(false); // empty => "null OID"
    expect(isValidGitStoreFile('ref', '   \n')).toBe(false);
    expect(isValidGitStoreFile('ref', 'not-a-sha\n')).toBe(false);
    expect(isValidGitStoreFile('ref', `${'a'.repeat(39)}\n`)).toBe(false); // too short
    expect(isValidGitStoreFile('ref', `${'g'.repeat(40)}\n`)).toBe(false); // not hex
  });

  it('classifies a path by the invariant it is subject to, logs before refs', () => {
    expect(gitStoreFileKind('refs/heads/staging')).toBe('ref');
    expect(gitStoreFileKind('modules/libs/sse/refs/hooks/pre-push')).toBe('ref');
    expect(gitStoreFileKind('logs/refs/heads/staging')).toBe('log'); // a reflog, not a ref
    expect(gitStoreFileKind('logs/hooks/pre-push')).toBe('log');
    expect(gitStoreFileKind('hooks/pre-push')).toBeNull(); // the LEGITIMATE guard hook
    expect(gitStoreFileKind('packed-refs')).toBeNull();
    expect(gitStoreFileKind('config')).toBeNull();
  });
});

describe('this checkout\'s git store has no corrupted refs or reflogs (WI-39371)', () => {
  it('contains only ref-shaped content under refs/ and logs/', () => {
    const storeDir = resolveGitCommonDir();

    // A guard that cannot find its subject must FAIL, never silently pass: a
    // vacuous green here is exactly how this corruption survived undetected.
    expect(storeDir, 'could not resolve the git common dir — cannot assert the invariant').not.toBeNull();
    expect(existsSync(storeDir!), `resolved git store does not exist: ${storeDir}`).toBe(true);

    const files = collectStoreFiles(storeDir!);
    expect(
      files.length,
      `walked ${storeDir} and found no files at all — the scan is not looking at a real store`,
    ).toBeGreaterThan(0);

    const offenders: string[] = [];
    let inspected = 0;
    for (const file of files) {
      const rel = relative(storeDir!, file);
      const kind = gitStoreFileKind(rel);
      if (!kind) continue;
      inspected++;
      let head: string;
      try {
        head = readFileSync(file, 'utf8').slice(0, READ_CAP);
      } catch {
        continue; // unreadable file — not evidence of corruption
      }
      // A busy reflog exceeds the cap, and the cut lands mid-line — say so, or
      // the fragment reads as corruption.
      if (!isValidGitStoreFile(kind, head, { truncated: head.length === READ_CAP })) {
        offenders.push(`${rel}  [${kind}] starts: ${JSON.stringify(head.slice(0, 60))}`);
      }
    }

    // Report the bound rather than letting a truncated walk read as a clean zero.
    expect(
      files.length,
      `scan hit its ${FILE_BUDGET}-file budget, so a clean result would be a FLOOR, not a total`,
    ).toBeLessThan(FILE_BUDGET);

    expect(
      offenders,
      offenders.length
        ? 'Files under a git store\'s refs/ or logs/ must hold ONLY an object id, a symbolic ref, ' +
            'or reflog lines. Anything else makes the repo UNCLONABLE ("null OID" / "invalid sha1 ' +
            'pointer 0000…") — WI-39371, where a pre-push hook script was written to these paths ' +
            'in 16 module stores. Do NOT delete: move each file out (reversible quarantine), then ' +
            're-run `git fsck --connectivity-only` on that store.\n  ' +
            offenders.join('\n  ')
        : `inspected ${inspected} ref/log files under ${storeDir}`,
    ).toEqual([]);
  });
});
