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

describe('the widened trigger (EI-19483245448673321)', () => {
  // CALIBRATION FIRST. If the control missed EVERYTHING it would "prove" every case
  // below for free, so assert its teeth before relying on its blindness.
  it('CALIBRATION: the literal-text control does catch a plain `detached: true`', () => {
    expect(LITERAL_TEXT_PREDICATE(RAW)).toBe(true);
  });

  it('FAILS `detached: <computed>` — the blind spot the literal-text control cannot see', () => {
    // green-checkpoint.ts:9289 in the real tree: `const detach = ...; { detached: detach }`.
    const computed = `
import { spawn } from 'node:child_process';
export function go(opts: { killOnTimeout?: boolean }) {
  const detach = opts.killOnTimeout === true;
  return spawn('node', ['w.js'], { stdio: 'ignore', detached: detach });
}`;
    expect(LITERAL_TEXT_PREDICATE(computed)).toBe(false); // ← the control is blind here
    expect(check(NEW, computed)).toBe(true); // ← the real predicate is not
  });

  it('FAILS a shorthand `{ detached }` — value unknown is not value-false', () => {
    const shorthand = `
import { spawn } from 'node:child_process';
export function go(detached: boolean) { return spawn('node', ['w.js'], { detached }); }`;
    expect(LITERAL_TEXT_PREDICATE(shorthand)).toBe(false);
    expect(check(NEW, shorthand)).toBe(true);
  });

  it('FAILS a handle PARKED ON A PROPERTY even with `detached: false`', () => {
    // local-whisper-service.ts in the real tree: a health-gated server kept in
    // module-scope `state`. It outlives the call inside the parent cgroup, which is
    // the hazard enrolment exists to prevent — and the old rule could not see it.
    const parked = `
import { spawn } from 'node:child_process';
const state: { child: unknown } = { child: null };
export function start() {
  const child = spawn('whisper-server', ['--port', '9000'], { detached: false });
  state.child = child;
}`;
    expect(LITERAL_TEXT_PREDICATE(parked)).toBe(false);
    expect(check(NEW, parked)).toBe(true);
  });

  it('FAILS a spawn assigned straight onto a property', () => {
    const direct = `
import { spawn } from 'node:child_process';
class Svc { proc: unknown = null; start() { this.proc = spawn('x', []); } }`;
    expect(check(NEW, direct)).toBe(true);
  });

  it('does NOT fail a handle merely RETURNED to the caller', () => {
    // A deliberate non-trigger: an awaited caller is the false-positive class the
    // ALLOWLIST header calls category (2). 9 sites measured; flagging them would
    // encode a rule the guard's own documentation says is wrong.
    const returned = `
import { spawn } from 'node:child_process';
export function run() { const child = spawn('git', ['status']); return child; }`;
    expect(check(NEW, returned)).toBe(false);
  });

  it('does NOT fail a `detached:` key on a DATA object in a file that also spawns', () => {
    // harness/git-stats.ts:883 — `detached: live.branch === null && ...` on a repo-status
    // object. Any WIDENED TEXT rule scores this an offender; the AST does not, because
    // the key is not in a spawn call's options argument. This is why the guard parses.
    const dataObject = `
import { spawn } from 'node:child_process';
export function status(live: { branch: string | null; head: string | null }) {
  spawn('git', ['rev-parse']);
  return { branch: live.branch, detached: live.branch === null && live.head !== null };
}`;
    expect(check(NEW, dataObject)).toBe(false);
  });

  it('self-excludes the enrolment primitives, so the fix is never read as the defect', () => {
    // managed-spawn.ts spawns and hands the handle back — that IS enrolment from the
    // inside. Without the exclusion a widened guard flags the remedy.
    const primitive = 'packages/operator-core/lib/task-manager/managed-spawn.ts';
    expect(check(primitive, RAW)).toBe(false);
    expect(spawnTriggers(primitive, RAW)).toEqual({
      detachedNotFalse: false,
      storedOnProperty: false,
    });
  });

  it('stays a strict SUPERSET: everything the literal-text control catches still fails', () => {
    expect(LITERAL_TEXT_PREDICATE(RAW) && check(NEW, RAW)).toBe(true);
  });
});

describe('KNOWN_DEFECTS hygiene', () => {
  // This map suppresses a FAILURE, so it is the one place a real hazard can go quiet.
  // It is deliberately governed harder than the allowlist rather than more softly.
  it('gives every entry a tracking ref, not just prose', () => {
    for (const [path, reason] of KNOWN_DEFECTS as Map<string, string>) {
      expect(reason, `${path} needs a real reason`).toBeTruthy();
      expect(reason.length, `${path}'s reason is too thin`).toBeGreaterThan(40);
      expect(reason, `${path} needs a WI-/EI- tracking ref — a parked defect with no`
        + ` owner is the blind spot this guard was widened to remove`).toMatch(/\b(WI|EI)-\d+/);
    }
  });

  it('stays tiny — a parking lot is not an allowlist', () => {
    expect(KNOWN_DEFECTS.size).toBeLessThanOrEqual(3);
  });

  it('never overlaps ALLOWLIST — an entry means one thing or the other', () => {
    for (const path of (KNOWN_DEFECTS as Map<string, string>).keys()) {
      expect(allow.has(path), `${path} is in BOTH maps`).toBe(false);
    }
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
