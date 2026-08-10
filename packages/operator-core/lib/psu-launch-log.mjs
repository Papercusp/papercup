/**
 * The ONE derivation of a psu launch's BOOT LOG path — WI-37841.
 *
 * WHY THIS EXISTS
 *
 * A HUD "+ New session" launch that dies before psu registers can only ever be
 * reported as "This session's launch failed — its terminal closed before the
 * session came online." That copy is a fixed string because the failure verdict
 * is DERIVED, not stored: `isFailedTerminalLaunch(row)` is just
 * `display='terminal' AND ended_at IS NOT NULL AND session_id IS NULL`
 * (adv-sessions.ts). It knows THAT the launch failed and structurally cannot
 * know WHY — the one artifact naming the cause is whatever psu printed on its
 * way out, and that went to the spawned window's pty and nowhere else.
 *
 * The cost is measured, not theoretical: that single banner has consumed TWO
 * full forensic sessions for TWO DIFFERENT underlying causes (WI-37743's
 * pre-pinned-owner 409, and the 2026-08-10T22:40Z pair of dead rows). Each time,
 * the message that would have answered it in one read had already been printed —
 * to a window nobody could read afterwards.
 *
 * WHY THIS FILE IS PLAIN .mjs
 *
 * Three parties need the SAME path and none of them can be handed it by another:
 *   • `apps/operator/scripts/psu-launcher.mjs` — the WRITER. Bare `node`,
 *     unbundled, cannot import TypeScript.
 *   • `…/endpoint-route/routes/adv/launch-su.ts` — passes it to
 *     `keepWindowOpenOnFailure` as the receipt path, so a failure that happens
 *     BEFORE node even runs (psu not on PATH, a broken login shell) still lands
 *     in the same file the launcher would have written.
 *   • the READER that surfaces the tail on the failed-launch banner.
 *
 * Same shape (and same reasoning) as `su-tier-roles.mjs`: plain ESM here plus a
 * `.d.mts` sibling so TypeScript callers stay typechecked with no build step. A
 * copy on each side would be three path expressions that drift silently, and the
 * failure mode is the quiet one — the writer logging to a path no reader reads,
 * which is indistinguishable from "the launch left no evidence".
 *
 * KEYED BY COORD OWNER ID, deliberately. The id is PRE-PINNED by launch-su
 * before the spawn (`psu --owner-id=…`), so it is the one handle that exists on
 * both sides of a launch that never came online — the adv_sessions row has no
 * session_id and no pid yet, and there is nothing else to key on. It is also
 * unique per launch, so each launch owns its own file and no launch can ever
 * read another's diagnostic.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Directory under `~/.papercusp` holding per-launch boot logs. */
export const PSU_LAUNCH_LOG_DIRNAME = 'psu-launch-logs';

/**
 * Max bytes captured per launch. The FIRST N bytes, not a ring — a boot failure
 * announces itself within a few lines, and taking the head keeps the writer a
 * plain bounded append with no buffering. A healthy session simply saturates the
 * cap with boot chatter and stops writing; its log is never read, because only a
 * FAILED launch is ever surfaced.
 */
export const PSU_LAUNCH_LOG_MAX_BYTES = 64 * 1024;

/** Max chars handed to a UI surface from the tail of a log. */
export const PSU_LAUNCH_LOG_TAIL_CHARS = 1200;

/** Logs older than this are pruned on the next launch (best-effort). */
export const PSU_LAUNCH_LOG_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Coord owner ids this module will build a path from.
 *
 * This guard is SECURITY, not tidiness: the value becomes a path segment AND is
 * interpolated into a shell one-liner by launch-su. A rejected id returns `null`
 * everywhere rather than throwing — no launch has ever been worth failing over a
 * diagnostic side-channel, and a null path degrades exactly to today's behaviour
 * (no log, the pre-WI-37841 status quo).
 */
const OWNER_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** The per-workspace-home directory holding launch boot logs. */
export function psuLaunchLogRoot(home = homedir()) {
  return join(home, '.papercusp', PSU_LAUNCH_LOG_DIRNAME);
}

/**
 * The boot-log path for `ownerId`, or `null` when the id is absent or not a
 * plain identifier (see OWNER_ID_RE). Pure — creates nothing.
 */
export function psuLaunchLogPath(ownerId, { home = homedir() } = {}) {
  if (typeof ownerId !== 'string' || !OWNER_ID_RE.test(ownerId)) return null;
  return join(psuLaunchLogRoot(home), `${ownerId}.log`);
}

/**
 * Delete boot logs older than {@link PSU_LAUNCH_LOG_TTL_MS}. Best-effort and
 * bounded: owner ids are unique per launch, so this directory would otherwise
 * accrete one small file per launch forever. Never throws — pruning is
 * housekeeping, and a launch must not fail because a stale log resisted
 * deletion.
 */
export function prunePsuLaunchLogs({ home = homedir(), now = Date.now(), ttlMs = PSU_LAUNCH_LOG_TTL_MS, max = 500 } = {}) {
  const dir = psuLaunchLogRoot(home);
  let removed = 0;
  try {
    if (!existsSync(dir)) return 0;
    for (const name of readdirSync(dir).slice(0, max)) {
      if (!name.endsWith('.log')) continue;
      const file = join(dir, name);
      try {
        if (now - statSync(file).mtimeMs > ttlMs) {
          rmSync(file, { force: true });
          removed += 1;
        }
      } catch {
        // one unreadable entry must not abort the sweep
      }
    }
  } catch {
    return removed;
  }
  return removed;
}

/**
 * Read the tail of a launch's boot log, or `null` when there is none.
 *
 * `null` and `''` mean DIFFERENT things and callers must keep them apart: null =
 * no log exists (an old launch, a pre-WI-37841 binary, a rejected owner id), so
 * say nothing; empty = the launch ran and printed nothing, which is itself a
 * finding. Neither is ever an error — this is read on a display path.
 */
export function readPsuLaunchLogTail(ownerId, { home = homedir(), chars = PSU_LAUNCH_LOG_TAIL_CHARS } = {}) {
  const file = psuLaunchLogPath(ownerId, { home });
  if (!file) return null;
  try {
    return readFileSync(file, 'utf8').trim().slice(-chars);
  } catch {
    return null;
  }
}

/**
 * Ensure the log directory exists and return the path to write, or null.
 * Separated from {@link psuLaunchLogPath} so the pure path derivation stays
 * side-effect-free for the READERS, which must never create a directory just by
 * asking a question.
 */
export function ensurePsuLaunchLogPath(ownerId, { home = homedir() } = {}) {
  const file = psuLaunchLogPath(ownerId, { home });
  if (!file) return null;
  try {
    mkdirSync(psuLaunchLogRoot(home), { recursive: true });
    return file;
  } catch {
    return null;
  }
}
