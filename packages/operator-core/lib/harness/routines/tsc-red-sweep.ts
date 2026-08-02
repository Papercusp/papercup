/**
 * tsc-red-sweep.ts — the INTERPRETER for the new-file tsc reds that the baseline gate
 * observes on its hot path (EI-19342686127995790).
 *
 * THE GAP THIS CLOSES. `scripts/lib/tsc-baseline-gate.mjs` already computes a finding the
 * whole fleet cares about: a file the tsc baseline has never seen, whose errors are
 * COMMITTED (not a peer's dirty mid-edit), is a standing red that will red the shared
 * green-checkpoint for everyone. That finding was computed roughly 9 times an hour — every
 * agent's post-edit `lint:tsc` recomputes it — and recorded exactly ZERO times. It went to
 * stdout, in a block agents skim past on their way to the `TSC_EXIT=` line, and then
 * evaporated. Nothing accumulated it, so nothing could ever notice that one had been
 * standing for hours with nobody on it.
 *
 * WHY THIS IS NOT "FILE EVERY RED". The obvious remedy — capture the finding when the gate
 * computes it — is WRONG, and measuring the population is what showed it. On 2026-08-02 a
 * broadcast listed 5 committed non-baselined reds (14 errors); re-measured 15 minutes later,
 * 4 of the 5 were GONE and the fifth had shrunk 5 errors -> 1, entirely unaided. These reds
 * are DOMINATED by self-healing, because the overwhelmingly common case is an author still
 * actively working the file they just committed. Filing on first sight would have created 5
 * work-items that morning, 4 of which would have closed themselves unread — replacing a
 * silent-log problem with a backlog-noise problem, which is worse: noise trains agents to
 * ignore the very lane this is filed into.
 *
 * SO THE VALUABLE SUBSET IS NOT "RED" BUT "RED AND OWNERLESS" — a red that OUTLIVED its
 * author's attention. That is a question about time, and it is unanswerable from any single
 * gate run; it needs the observation history the hot path now appends. Hence the split:
 *
 *   hot path  (scripts/lib/tsc-red-observations.mjs, called by the gate)
 *             -> appendFileSync one line per standing red, every failure swallowed. The gate
 *                is shared infrastructure the whole fleet blocks on; it must never gain a
 *                call that can hang or change `TSC_EXIT`.
 *   this file (the routines tick, off the hot path)
 *             -> read the history, apply the DWELL decision, file the survivors.
 *
 * The redundancy that motivated the original filing ("~9 identical compiles/hour, squandered
 * compute") turns out to be the thing that makes this possible at all: it is a free
 * high-frequency sampler, and persistence is only measurable because of it.
 *
 * FAIL-SOFT BY CONTRACT, like every sibling sweep here. A missing store, a corrupt line, an
 * unavailable DB — each degrades to "file nothing this tick" and is reported in the return
 * value, never thrown. A sweep that can wedge the routines tick is worse than the silent log
 * it replaces.
 */
import { recentWatchdogFires, claimWatchdogFire } from '../../pot/watchdog';
import { activeWorkspaceId } from '../../workspace-registry';
// Type-only: erased at runtime, so this does NOT eagerly pull capture-core (and its
// embedding/rubric dependency tree) into the routines tick. The real import stays lazy
// below. Typing the seam is what makes a wrong capture field a COMPILE error rather than
// a silently-ignored key at 3am — `improvements:capture` rejects undeclared args (EI-10883).
import type { CaptureImprovementInput } from '../improvements/capture-core';
import {
  readObservations,
  selectDwelledReds,
  pruneObservations,
  DWELL_SEC,
} from '../../../../../scripts/lib/tsc-red-observations.mjs';

/** One dwelled red, as the sweep resolved it. */
export interface TscRedSweepResult {
  file: string;
  outcome: 'filed' | 'debounced' | 'capped' | 'error';
  /** How long the red was observed to persist, first sighting to last. */
  spanSec: number;
  sightings: number;
  reason: string;
}

/**
 * Bound the blast radius of one tick. `selectDwelledReds` returns longest-standing first, so
 * a cap takes the most-dwelled — the correct triage order — and defers the rest to the next
 * tick rather than dropping them (they are still in the store, still being observed).
 *
 * A tree with 20 simultaneously-dwelled reds is a fleet-wide event, not 20 independent bugs;
 * filing 20 items for it would be exactly the noise this sweep exists to avoid.
 */
export const MAX_FILES_PER_TICK = 5;

/** Per-path debounce window. Matches the house default used by every sibling sweep. */
export const DEBOUNCE_HOURS = 24;

/** A dwelled red as `selectDwelledReds` reports it (mirrors the .d.mts shape). */
export interface DwelledRed {
  file: string;
  firstSeen: number;
  lastSeen: number;
  sightings: number;
  spanSec: number;
  latestCount: number | null;
}

/** Stable per-path debounce identity. Embedded verbatim in the fire `reason` because
 *  `claimWatchdogFire` matches its scope key with `reason LIKE '%key%'`. */
export function debounceKeyFor(file: string): string {
  return `tsc-new-file-red::${file}`;
}

/**
 * PURE: the capture payload for one dwelled red. Split out so the wording, the severity and
 * the dedup identity are all assertable without a database or a clock.
 *
 * `severity: 'major'` is deliberate and is the whole point of the item: this is not a
 * cosmetic type nit. A committed non-baselined red reds the SHARED green-checkpoint, so it
 * blocks every agent's promotion path, and by the time this sweep files it the red has
 * already outlived its author by DWELL_SEC — meaning nobody is on it.
 */
export function buildRedCapture(red: DwelledRed): {
  title: string;
  body: string;
  watchdogKey: string;
  paths: string[];
  evidenceAt: string;
} {
  const mins = Math.round(red.spanSec / 60);
  const count = red.latestCount == null ? 'unknown' : String(red.latestCount);
  return {
    title: `Standing tsc red with no owner: ${red.file} (${mins}min, ${count} errors)`,
    body:
      `\`${red.file}\` is a NEW file (the tsc baseline has never seen it) whose errors are ` +
      `COMMITTED — not a peer's uncommitted mid-edit — and it has now been observed red ` +
      `${red.sightings} times across ${mins} minutes without being fixed.\n\n` +
      `WHY THIS WAS FILED AND MOST REDS ARE NOT. Committed new-file reds are dominated by ` +
      `self-healing (measured 2026-08-02: 4 of 5 cleared unaided within ~15 minutes), so the ` +
      `sweep files only reds that OUTLIVE the ${Math.round(DWELL_SEC / 60)}-minute dwell ` +
      `threshold — i.e. ones whose author has most likely moved on. That makes this one ` +
      `unusual: it is very likely OWNERLESS rather than in progress.\n\n` +
      `IMPACT: a committed non-baselined red reds the shared green-checkpoint, so it blocks ` +
      `the whole fleet's promotion path, not just this file's author.\n\n` +
      `BEFORE CLAIMING IT, re-run the ownership test — the red may have been fixed between ` +
      `this filing and your reading it:\n` +
      `  git status --porcelain | grep ${red.file}   # dirty => someone is editing it RIGHT NOW\n` +
      `  git log -1 --format=%cI -- ${red.file}      # minutes old => author still has context\n` +
      `  npm run lint:tsc -- --files=${red.file}\n\n` +
      `Observation window: first seen ${new Date(red.firstSeen * 1000).toISOString()}, ` +
      `last seen ${new Date(red.lastSeen * 1000).toISOString()}.`,
    watchdogKey: debounceKeyFor(red.file),
    paths: [red.file],
    evidenceAt: new Date(red.lastSeen * 1000).toISOString(),
  };
}

/** Injectable seams so the sweep is unit-testable without PG or the real store. */
export interface TscRedSweepDeps {
  nowMs?: number;
  path?: string;
  maxFiles?: number;
  readObservationsFn?: typeof readObservations;
  selectDwelledRedsFn?: typeof selectDwelledReds;
  pruneObservationsFn?: typeof pruneObservations;
  recentFiresFn?: typeof recentWatchdogFires;
  claimFireFn?: typeof claimWatchdogFire;
  captureFn?: (input: CaptureImprovementInput) => Promise<unknown>;
  workspaceIdFn?: () => string;
}

/**
 * Read the observation store, file the dwelled reds, prune what has aged out.
 *
 * The prune runs in a `finally` on purpose: retention is what BOUNDS the store, and a store
 * that only ever grows is a slow leak in a runtime dir. It must happen even on a tick where
 * the DB was unreachable and nothing could be filed.
 */
export async function tscRedSweep(deps: TscRedSweepDeps = {}): Promise<TscRedSweepResult[]> {
  const {
    nowMs = Date.now(),
    path,
    maxFiles = MAX_FILES_PER_TICK,
    readObservationsFn = readObservations,
    selectDwelledRedsFn = selectDwelledReds,
    pruneObservationsFn = pruneObservations,
    recentFiresFn = recentWatchdogFires,
    claimFireFn = claimWatchdogFire,
    captureFn,
    workspaceIdFn = activeWorkspaceId,
  } = deps;

  const results: TscRedSweepResult[] = [];
  try {
    const observations = readObservationsFn(path ? { path, nowMs } : { nowMs });
    const dwelled: DwelledRed[] = selectDwelledRedsFn(observations, { nowMs });
    if (dwelled.length === 0) return results;

    const workspaceId = workspaceIdFn();
    const source = 'tsc-new-file-red' as const;

    for (const [i, red] of dwelled.entries()) {
      if (i >= maxFiles) {
        results.push({
          file: red.file,
          outcome: 'capped',
          spanSec: red.spanSec,
          sightings: red.sightings,
          reason: `over MAX_FILES_PER_TICK (${maxFiles}) — deferred to the next tick`,
        });
        continue;
      }
      try {
        const installSlug = debounceKeyFor(red.file);
        if ((await recentFiresFn(workspaceId, installSlug, DEBOUNCE_HOURS, source)) > 0) {
          results.push({
            file: red.file,
            outcome: 'debounced',
            spanSec: red.spanSec,
            sightings: red.sightings,
            reason: `filed within ${DEBOUNCE_HOURS}h`,
          });
          continue;
        }
        const capture = buildRedCapture(red);
        // Single-flight: atomically re-check + claim the debounce slot immediately before the
        // one-time side effect, so two overlapping ticks cannot both file (the EI-6777 fix
        // every sibling sweep carries).
        const claimed = await claimFireFn({
          workspaceId,
          installSlug,
          source,
          windowHours: DEBOUNCE_HOURS,
          reason: capture.watchdogKey,
          wakeAt: null,
        });
        if (!claimed) {
          results.push({
            file: red.file,
            outcome: 'debounced',
            spanSec: red.spanSec,
            sightings: red.sightings,
            reason: `filed within ${DEBOUNCE_HOURS}h (raced)`,
          });
          continue;
        }
        const capture_ = captureFn ?? (await import('../improvements/capture-core')).captureImprovement;
        await capture_({
          title: capture.title,
          kind: 'bug',
          severity: 'major',
          body: capture.body,
          paths: capture.paths,
          // A RESOLVED duplicate means the red came back — that is a regression worth
          // re-filing, so only an OPEN duplicate may decline this capture.
          dedupScope: 'open',
          // Exact indexed cross-tick dedup instead of a fuzzy title match, and it keeps a
          // DIFFERENT path's red from title-subsetting this one into a false duplicate.
          watchdogKey: capture.watchdogKey,
          evidenceAt: capture.evidenceAt,
          // Deliberately UNASSIGNED. The whole premise is that this red is ownerless; the
          // sweep is a sensor, and auto-claiming would put a machine's name on work no
          // machine is doing.
          sourceRole: 'system',
          foundDuring: 'tsc-red sweep (routines tick)',
          // Omit scope: a repo-wide gate concern, not one harness's — auto-homes to the
          // workspace platform Pot (capture-core.ts CaptureImprovementInput.scope).
        });
        results.push({
          file: red.file,
          outcome: 'filed',
          spanSec: red.spanSec,
          sightings: red.sightings,
          reason: `standing ${Math.round(red.spanSec / 60)}min across ${red.sightings} sightings`,
        });
      } catch (e) {
        results.push({
          file: red.file,
          outcome: 'error',
          spanSec: red.spanSec,
          sightings: red.sightings,
          reason: e instanceof Error ? e.message : String(e),
        });
      }
    }
  } catch (e) {
    console.warn(`[tsc-red-sweep] sweep failed: ${e instanceof Error ? e.message : e}`);
  } finally {
    try {
      pruneObservationsFn(path ? { path, nowMs } : { nowMs });
    } catch {
      // Retention is best-effort; a failed prune must not mask a successful filing.
    }
  }
  return results;
}
