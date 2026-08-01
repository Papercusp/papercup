/**
 * gc-verify-instances — reap abandoned `scripts/verify-tauri-headless.sh` instances.
 *
 * WHY (owner ask 2026-08-01: "how do we fix this from recurring — a cleanup sweep that
 * would detect this?"). Measured on the dev box that day:
 *
 *     288 /tmp/verify-tauri-headless.* work dirs   →   300 GB
 *     /tmp 80% full (5.8T of 7.3T)
 *     one --boot-only instance running since Jul 19 (8 days), holding Xvfb :93,
 *     a webview and an operator sidecar
 *
 * Each work dir carries a frozen `spa` bundle snapshot (~1GB), so DISK is the dominant
 * cost — not the display/port starvation the first report assumed.
 *
 * ⚠ AND THE LEAK WAS UNIVERSAL, not a `--boot-only` problem. The obvious story — "the
 * `-- <cmd>` form tears itself down, `--boot-only` returns without teardown, so only
 * the latter leaks" — is what the first report said and it is WRONG. Measured: the
 * youngest leaked dir was 100h old, meaning even clean runs left theirs behind. The
 * reason is that `teardown()` only ever killed PROCESSES; the single `rm -rf` in the
 * whole script was for the isolated-PG datadir. Displays were already reclaimed
 * opportunistically (EI-18738872670541790), which is why the process side looked
 * handled while disk quietly grew. So the ROOT fix is in the script — teardown now
 * drops `$WORK/spa` (WI-6684) — and this sweep exists for what a trap can never cover:
 *
 *   - the accumulated backlog (288 dirs at first run),
 *   - runs SIGKILLed before the trap fires,
 *   - `--boot-only` callers that die/compact/forget and never run the printed stop.sh,
 *   - the kilobyte log husks that deliberately survive teardown for post-mortems.
 *
 * ── DESIGN: INVOKE THE EXISTING TEARDOWN, NEVER REIMPLEMENT IT ───────────────────
 *
 * Every work dir contains a generated `stop.sh` that already encodes four separately
 * hard-won fixes:
 *
 *   EI-11559              do NOT force-kill the port-lock keeper — it must survive to
 *                         self-terminate once the display is gone AND the port drains,
 *                         or a display-reusing next run collides with a straggler.
 *   EI-18745117818375852  reap escaped restart-supervisor sidecars BY PORT, matching
 *                         /proc/<pid>/environ, not by the tracked pid (the WI-3042
 *                         supervisor spawns replacements outside the process group).
 *   EI-18816386093046558  SIGKILL leaves /tmp/.X11-unix/X<N> unlinked.
 *   (ordering)            openbox before Xvfb, group-kill before single-kill.
 *
 * A reaper that rolled its own kill logic would silently lose all four and re-earn them
 * one incident at a time. So this sweep decides only WHETHER a dir is abandoned; the
 * dir's own stop.sh decides HOW to tear it down.
 *
 * ── SAFETY IS THE DELIVERABLE ────────────────────────────────────────────────────
 *
 * This sweep kills processes on a box shared by the owner's real desktop and a live
 * agent fleet, unattended, on a timer. A near-miss on 2026-07-27 (su-709bb0d6) ran
 * `pkill -f "papercusp-desktop" -u $USER --older-than 0` while cleaning up its OWN
 * instance — `--older-than 0` means "older than 0 seconds", i.e. EVERY match, which
 * included the owner's desktop window and every peer's test instance. That is the
 * failure mode this file must not have. Hence:
 *
 *   - NEVER pattern-kill. This module issues no kill of its own; it execs a specific
 *     work dir's own stop.sh and nothing else.
 *   - REFUSE a stop.sh whose display is :0/:1/:2 (:0 is the owner's real desktop) —
 *     a defensive parse, since a well-formed stop.sh always targets its own high
 *     display, but a malformed or hand-edited one must not be trusted.
 *   - NEVER touch a dir younger than the TTL. A `-- <cmd>` run lives <10 min; the TTL
 *     defaults to 6h so even a long interactive --boot-only session is safe.
 *   - BOUND every run, and support dryRun that names what it WOULD reap (a bare count
 *     hides destruction — see the gen-gallery.py lesson).
 */
import { execFile } from 'node:child_process';
import type { Dirent } from 'node:fs';
import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Where the verify harness puts its per-run work dirs. */
export const VERIFY_WORK_DIR_PREFIX = 'verify-tauri-headless.';

/**
 * How old a work dir must be before it is even considered. A real `-- <cmd>` run is
 * bounded by the bridge timeout (180s) plus its assertions — minutes, not hours. The
 * generous default exists for `--boot-only`, which is a human/agent-driven interactive
 * session that may legitimately stay up while someone works against it.
 */
export const VERIFY_INSTANCE_TTL_HOURS_DEFAULT = 6;

/** Never reap more than this in one pass — a runaway sweep should be slow, not total. */
export const VERIFY_INSTANCE_MAX_PER_RUN_DEFAULT = 50;

/**
 * Displays this sweep will never tear down, whatever a stop.sh claims.
 * `:0` is the owner's real desktop; `:1`/`:2` are the conventional next seats.
 */
export const PROTECTED_DISPLAYS = new Set([':0', ':1', ':2']);

export interface GcVerifyInstancesOptions {
  /** Root to scan (default /tmp). Injected by the tests. */
  tmpDir?: string;
  ttlHours?: number;
  maxPerRun?: number;
  /** Report what WOULD be reaped without killing or deleting anything. */
  dryRun?: boolean;
  /** Injectable clock for deterministic tests. */
  now?: number;
  /** Injectable teardown, so tests never exec a real stop.sh. */
  runStopScript?: (stopScriptPath: string) => Promise<void>;
}

export interface ReapedInstance {
  dir: string;
  ageHours: number;
  bytes: number;
  /** The display its stop.sh targets, when one could be parsed. */
  display: string | null;
  /** Present when the dir was SKIPPED rather than reaped. */
  skipped?: string;
}

export interface GcVerifyInstancesResult {
  scanned: number;
  reaped: number;
  /** Bytes freed (or that would be freed under dryRun). */
  bytesFreed: number;
  /** Every dir acted on or deliberately skipped, with the reason. */
  instances: ReapedInstance[];
  skipped: number;
  dryRun: boolean;
  ttlHours: number;
}

/**
 * Parse the display a stop.sh targets, e.g. `pkill -9 -f "Xvfb :144 "` → `:144`.
 * Returns null when no display can be read, which is itself a refusal condition:
 * we do not tear down a teardown script we cannot understand.
 */
export function parseStopScriptDisplay(stopScript: string): string | null {
  const m = /Xvfb (:\d+)/.exec(stopScript);
  return m ? m[1] : null;
}

/** Recursive size of a directory, tolerant of races (a file vanishing mid-walk). */
async function dirBytes(path: string): Promise<number> {
  let total = 0;
  let entries: Awaited<ReturnType<typeof readdir>>;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const child = `${path}/${e.name}`;
    try {
      if (e.isDirectory()) total += await dirBytes(child);
      else if (e.isFile()) total += (await stat(child)).size;
    } catch {
      /* vanished mid-walk — a concurrent run tearing itself down; not our problem */
    }
  }
  return total;
}

async function defaultRunStopScript(stopScriptPath: string): Promise<void> {
  // 60s is generous: stop.sh sleeps ~1s between TERM and KILL and drains the port
  // lock. A hung teardown must not wedge the whole sweep.
  await execFileAsync('bash', [stopScriptPath], { timeout: 60_000 });
}

export async function gcVerifyInstances(
  opts: GcVerifyInstancesOptions = {},
): Promise<GcVerifyInstancesResult> {
  const tmpDir = opts.tmpDir ?? '/tmp';
  const ttlHours =
    Number.isFinite(opts.ttlHours) && (opts.ttlHours as number) > 0
      ? (opts.ttlHours as number)
      : VERIFY_INSTANCE_TTL_HOURS_DEFAULT;
  const maxPerRun =
    Number.isFinite(opts.maxPerRun) && (opts.maxPerRun as number) > 0
      ? (opts.maxPerRun as number)
      : VERIFY_INSTANCE_MAX_PER_RUN_DEFAULT;
  const dryRun = opts.dryRun === true;
  const now = opts.now ?? Date.now();
  const runStopScript = opts.runStopScript ?? defaultRunStopScript;

  const instances: ReapedInstance[] = [];
  let reaped = 0;
  let skipped = 0;
  let bytesFreed = 0;
  let scanned = 0;

  let entries: Awaited<ReturnType<typeof readdir>>;
  try {
    entries = await readdir(tmpDir, { withFileTypes: true });
  } catch {
    return { scanned: 0, reaped: 0, bytesFreed: 0, instances: [], skipped: 0, dryRun, ttlHours };
  }

  // Oldest first, so a capped run always makes progress on the worst offenders
  // rather than nibbling whichever dirs readdir happened to return first.
  const candidates: Array<{ dir: string; mtimeMs: number }> = [];
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.startsWith(VERIFY_WORK_DIR_PREFIX)) continue;
    const dir = `${tmpDir}/${e.name}`;
    try {
      candidates.push({ dir, mtimeMs: (await stat(dir)).mtimeMs });
    } catch {
      /* vanished between readdir and stat */
    }
  }
  candidates.sort((a, b) => a.mtimeMs - b.mtimeMs);

  for (const { dir, mtimeMs } of candidates) {
    scanned += 1;
    if (reaped >= maxPerRun) break;

    const ageHours = (now - mtimeMs) / 3_600_000;
    const record = (extra: Partial<ReapedInstance>): ReapedInstance => ({
      dir,
      ageHours: Math.round(ageHours * 10) / 10,
      bytes: 0,
      display: null,
      ...extra,
    });

    // ── REFUSAL 1: too young. A live run must never be reaped out from under itself.
    if (ageHours < ttlHours) {
      skipped += 1;
      instances.push(record({ skipped: `younger than ttl (${ttlHours}h)` }));
      continue;
    }

    const stopScriptPath = `${dir}/stop.sh`;
    let stopScript: string;
    try {
      stopScript = await readFile(stopScriptPath, 'utf8');
    } catch {
      // No stop.sh — a partially-created dir (the harness died mid-boot). There is
      // nothing to tear down, so the dir alone is safe to remove.
      const bytes = await dirBytes(dir);
      if (!dryRun) {
        try {
          await rm(dir, { recursive: true, force: true });
        } catch {
          skipped += 1;
          instances.push(record({ skipped: 'rm failed' }));
          continue;
        }
      }
      reaped += 1;
      bytesFreed += bytes;
      instances.push(record({ bytes }));
      continue;
    }

    const display = parseStopScriptDisplay(stopScript);

    // ── REFUSAL 2: unreadable teardown. We do not run a stop.sh we cannot parse.
    if (!display) {
      skipped += 1;
      instances.push(record({ skipped: 'stop.sh names no display — refusing to run it' }));
      continue;
    }

    // ── REFUSAL 3: a protected display. THE load-bearing guard. :0 is the owner's
    // real desktop; tearing it down logs them out. A well-formed stop.sh never
    // targets one, so hitting this means the script is malformed or hand-edited —
    // exactly when blind trust is most expensive.
    if (PROTECTED_DISPLAYS.has(display)) {
      skipped += 1;
      instances.push(record({ display, skipped: `protected display ${display} — refusing` }));
      continue;
    }

    const bytes = await dirBytes(dir);
    if (!dryRun) {
      // Best-effort teardown: a dead instance's stop.sh exits nonzero on every kill
      // (the pids are long gone), which is SUCCESS for our purposes, not failure.
      try {
        await runStopScript(stopScriptPath);
      } catch {
        /* pids already dead, or a hung child hit the timeout — remove the dir anyway */
      }
      try {
        await rm(dir, { recursive: true, force: true });
      } catch {
        skipped += 1;
        instances.push(record({ display, skipped: 'rm failed after teardown' }));
        continue;
      }
    }
    reaped += 1;
    bytesFreed += bytes;
    instances.push(record({ display, bytes }));
  }

  return { scanned, reaped, bytesFreed, instances, skipped, dryRun, ttlHours };
}
