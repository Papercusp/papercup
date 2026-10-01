// EI-18750303030034478 — name an ACTIVE in-tree mutation-probe window on a failing raw test run.
//
// `scripts/mutation-probe.sh --in-tree` deliberately breaks a tracked file for the length of a
// guard run. A peer's `npm run test:file` / `npm run test:affected` in the same checkout can read
// that mutant and report a red with zero connection to the peer's own change (measured twice: a
// ledger row on 2026-07-26 and a peer's two-markdown-file `test:affected` on 2026-08-10). The
// ledger half is already fixed (`PAPERCUSP_MUTATION_PROBE=1` stamps `source='mutation-probe'`) and
// `testing:run` refuses fenced tests (`mutation-probe-fence.ts`), but the raw CLI routes cannot
// query the file-lock store — so they read the probe's OWN filesystem marker instead.
//
// THE MARKER. The probe publishes `<admission dir>/original.manifest` — four NUL-terminated
// fields `<checkout root> <subject> <snapshot> <owner pid>` — BEFORE it mutates anything and
// removes it only AFTER the verified restore, so the file exists exactly while a mutant may be in
// the tree. The directory name is `/tmp/papercusp-mutation-probe-<uid>-<sha256(realpath root)>`,
// mirrored from the literal in `mutation-probe.sh` and pinned to it by
// `packages/operator-core/lib/mutation-probe-window.test.ts` so the two cannot drift apart.
//
// This is a DIAGNOSTIC, never a gate: it can only add one line to a failing run's output. It
// cannot mask or excuse a red, and a missing/unreadable marker reads as "no window", never as an
// error — the instrument must not be able to fail a run.
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * The admission directory `mutation-probe.sh` uses for one physical checkout.
 *
 * @param {string} checkoutRoot git toplevel of the checkout (symlinks are resolved, as the script does)
 * @param {{ uid?: number, tmpDir?: string }} [options] `tmpDir` is `/tmp` because the script hard-codes it
 * @returns {string}
 */
export function mutationProbeAdmissionDir(checkoutRoot, { uid, tmpDir = '/tmp' } = {}) {
  const resolvedUid = uid ?? (typeof process.getuid === 'function' ? process.getuid() : 0);
  const key = createHash('sha256').update(realpathSync(checkoutRoot)).digest('hex');
  return join(tmpDir, `papercusp-mutation-probe-${resolvedUid}-${key}`);
}

/**
 * @param {number} pid
 * @returns {boolean} true when the process exists (EPERM still means it exists)
 */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return /** @type {NodeJS.ErrnoException} */ (error).code === 'EPERM';
  }
}

/**
 * Read the live mutation-probe window for a checkout, if any.
 *
 * `state` is `active` (owner alive — the subject is mutated right now), `orphaned` (owner died
 * mid-window — the mutant may STILL be in the file until the next probe recovers it) or
 * `unreadable` (a marker exists but is not the four-field shape; the subject is unknown).
 * Returns `null` for "no marker", and for any failure to look — never throws.
 *
 * @param {string} checkoutRoot
 * @param {{ uid?: number, tmpDir?: string, now?: () => number }} [options]
 * @returns {{ state: 'active' | 'orphaned' | 'unreadable', subject: string | null, ownerPid: number | null, ageSec: number | null, manifestPath: string } | null}
 */
export function readMutationProbeWindow(checkoutRoot, options = {}) {
  let manifestPath;
  try {
    manifestPath = join(mutationProbeAdmissionDir(checkoutRoot, options), 'original.manifest');
  } catch {
    return null;
  }
  let raw;
  let mtimeMs;
  try {
    raw = readFileSync(manifestPath, 'latin1');
    mtimeMs = statSync(manifestPath).mtimeMs;
  } catch {
    return null;
  }
  const now = (options.now ?? Date.now)();
  const ageSec = Math.max(0, Math.round((now - mtimeMs) / 1000));
  // The writer terminates EVERY field with NUL, so a well-formed file splits into 4 fields + ''.
  const fields = raw.split('\0');
  const trailing = fields.pop();
  const subject = fields[1];
  const ownerPid = Number(fields[3]);
  if (trailing !== '' || fields.length !== 4 || !subject || !Number.isInteger(ownerPid) || ownerPid < 1) {
    return { state: 'unreadable', subject: null, ownerPid: null, ageSec, manifestPath };
  }
  return { state: pidAlive(ownerPid) ? 'active' : 'orphaned', subject, ownerPid, ageSec, manifestPath };
}

/**
 * One greppable line naming the window, or `''` when there is none.
 *
 * @param {ReturnType<typeof readMutationProbeWindow>} window
 * @param {string} checkoutRoot used only to print the subject repo-relative
 * @returns {string}
 */
export function formatMutationProbeWindow(window, checkoutRoot) {
  if (!window) return '';
  const subject = window.subject ? relative(checkoutRoot, window.subject) || window.subject : 'unknown';
  const meaning =
    window.state === 'active'
      ? 'an in-tree mutation probe has DELIBERATELY broken that file right now'
      : window.state === 'orphaned'
        ? 'a mutation probe died mid-window, so that file may STILL be mutated until the next probe recovers it'
        : 'a mutation-probe marker exists but could not be parsed, so the mutated file is unknown';
  return (
    `TEST_FILE_MUTATION_PROBE_WINDOW state=${window.state} subject=${subject} ` +
    `ownerPid=${window.ownerPid ?? 'unknown'} ageSec=${window.ageSec ?? 'unknown'} — ${meaning}. ` +
    'A red that names it, or a file that imports it, may be probe evidence rather than a regression in your change: ' +
    're-run in isolation once the window closes before attributing it (`testing:run` fences this; raw test:file/test:affected cannot).'
  );
}
