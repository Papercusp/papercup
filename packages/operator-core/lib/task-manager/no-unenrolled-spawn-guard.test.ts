/**
 * The GUARD's own correctness (task-manager-no-escape-2026-07-27, P-016).
 *
 * A guard that only ever runs against a clean tree proves nothing — it would pass
 * identically if its predicate were `return false`. So the property under test is
 * "a NEW unenrolled detached spawn fails", driven against synthetic sources, the
 * same discipline `no-raw-spawn-guard.test.ts` applies to its own predicate.
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error — .mjs guard script, no type declarations
import { isUnenrolledDetachedSpawn, ALLOWLIST } from '../../../../scripts/check-no-unenrolled-detached-spawn.mjs';

const check = isUnenrolledDetachedSpawn as (rel: string, src: string) => boolean;
const allow = ALLOWLIST as Map<string, string>;

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
