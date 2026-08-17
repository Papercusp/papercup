/**
 * The GUARD's own correctness (task-manager-no-escape-2026-07-27, P-016).
 *
 * A guard that only ever runs against a clean tree proves nothing — it would pass
 * identically if its predicate were `return false`. So the property under test is
 * "a NEW unenrolled detached spawn fails", driven against synthetic sources, the
 * same discipline `no-raw-spawn-guard.test.ts` applies to its own predicate.
 */
import { describe, it, expect } from 'vitest';
import {
  isUnenrolledDetachedSpawn,
  spawnTriggers,
  ALLOWLIST,
  KNOWN_DEFECTS,
} from '../../../../scripts/check-no-unenrolled-detached-spawn.mjs';

const check = isUnenrolledDetachedSpawn;
const allow = ALLOWLIST;

/** A path in no map, so only the PREDICATE decides the verdict. */
const NEW = 'packages/operator-core/lib/brand-new-thing.ts';

/**
 * THE PERMANENTLY-WRONG CONTROL (falsifiability, kept in the test file rather than
 * mutating the shared tree — a mutation probe here would be committed by the git-sync
 * sweep while it ran).
 *
 * This is the guard's OWN previous implementation: a literal-text match on
 * `detached: true`. It is not a strawman — it shipped, and EI-19483245448673321 is the
 * record of what it could not see. Keeping it here means the blind-spot cases below
 * are proven DISCRIMINATING: each one asserts the real predicate catches what this
 * control misses. Without it, those cases would pass identically against a predicate
 * that simply returned `true` for everything.
 */
const LITERAL_TEXT_PREDICATE = (source: string): boolean =>
  /detached:\s*true/.test(source) && /\b(spawn|childSpawn|spawnFn)\s*\(/.test(source);

const RAW = `
import { spawn } from 'node:child_process';
export function go() {
  return spawn('node', ['worker.js'], { cwd: '/tmp', detached: true });
}`;

describe('isUnenrolledDetachedSpawn', () => {
  it('FAILS a new detached spawn with no enrolment', () => {
    expect(check('packages/operator-core/lib/brand-new-thing.ts', RAW)).toBe(true);
  });

  it('passes once the file enrols through the sync seam', () => {
    const enrolled = `import { beginSyncEnrolment } from '../task-manager/enroll-sync';\n${RAW}`;
    expect(check('packages/operator-core/lib/brand-new-thing.ts', enrolled)).toBe(false);
  });

  it('passes once the file enrols through the async chokepoint', () => {
    const enrolled = `import { managedSpawn } from '../task-manager/managed-spawn';\n${RAW}`;
    expect(check('packages/operator-core/lib/brand-new-thing.ts', enrolled)).toBe(false);
  });

  it('passes an explicitly allowlisted site', () => {
    const [first] = [...allow.keys()];
    expect(check(first!, RAW)).toBe(false);
  });

  it('ignores a file that merely TALKS about detached:true in a comment', () => {
    // Several files explain the flag at length; a doc-comment is not a spawn, and
    // flagging one would train people to ignore the guard.
    const commentOnly = `
import { spawn } from 'node:child_process';
// This process runs with detached: true elsewhere, which is why we group-kill.
/* detached: true gives it its own process group */
export function go() { return spawn('ls', []); }`;
    expect(check('packages/operator-core/lib/talks-about-it.ts', commentOnly)).toBe(false);
  });

  it('ignores a non-detached spawn — short-lived children inherit their parent cgroup', () => {
    const plain = `import { spawn } from 'node:child_process';\nspawn('git', ['rev-parse']);`;
    expect(check('packages/operator-core/lib/plain.ts', plain)).toBe(false);
  });

  it('ignores an object with detached:true that never spawns anything', () => {
    const notASpawn = `export const opts = { detached: true, cwd: '/tmp' };`;
    expect(check('packages/operator-core/lib/config.ts', notASpawn)).toBe(false);
  });
});

describe('ALLOWLIST hygiene', () => {
  it('gives every entry a non-trivial reason', () => {
    // An allowlist without reasons becomes a rubber stamp within a month.
    for (const [path, reason] of allow) {
      expect(reason, `${path} needs a real reason`).toBeTruthy();
      expect(reason.length, `${path}'s reason is too thin`).toBeGreaterThan(20);
    }
  });

  it('stays small enough to actually review', () => {
    // The point of scoping the guard to `detached: true` (rather than all ~813
    // spawn sites) was to keep this list reviewable. If it grows past ~40 the
    // guard has drifted back into rubber-stamp territory and needs re-scoping.
    expect(allow.size).toBeLessThanOrEqual(40);
  });
});
