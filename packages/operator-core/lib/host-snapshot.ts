/**
 * host-snapshot — the four scalars agents currently shell out for, computed
 * cheaply enough to ride along on a call they already make
 * (plan `bash-to-tool-substitution-2026-07-26`, P-026 + P-027).
 *
 * ── Why this exists (measured, not assumed) ─────────────────────────────────
 * Two plan items measured two unrelated-looking bash families over the 7d
 * corpus and landed on the SAME answer:
 *
 *  • P-026 host resources — 370 atoms / 47 of 86 sessions, the broadest session
 *    coverage in the whole audit. Of that, the load/mem/core half is 283 atoms
 *    across just 26 distinct shapes: `uptime` (106), `cat /proc/loadavg` (64),
 *    `nproc` (43), `free -h` (25). Distinct-per-atom is 5–12% — i.e. the same
 *    handful of zero-argument reads, over and over. `nproc` is the purest case:
 *    27 sessions asked an INVARIANT of the box, 9 of them more than once.
 *  • P-027 clock — 852 atoms / 50 of 86 sessions. 586 of them (69%) are bare
 *    `date` or `date -u` with no format at all.
 *
 * A near-constant answer that is asked repeatedly does not want a VERB — a verb
 * still costs the inference round-trip that is the entire cost being measured.
 * It wants to have already arrived. So this snapshot is folded into
 * `coord:orient` (a call made 1,207 times in the same window) rather than
 * exposed as `dev:host`.
 *
 * ── What is deliberately NOT here ───────────────────────────────────────────
 * The other half of each family stays bash, because a tool there would be a
 * passthrough (plan D-034):
 *  • `du`/`df` — 88 atoms across 73 DISTINCT shapes (83% distinct-per-atom),
 *    arbitrary paths and globs. That is ad-hoc exploration, not a repeated
 *    question, and no fixed field answers it.
 *  • `$(date …)` INSIDE another command — 279 atoms. That is string
 *    interpolation into a shell command; no context field can remove it.
 *
 * ── Cost discipline ─────────────────────────────────────────────────────────
 * This rides on EVERY orient, so it must stay near-free and never throw. Load
 * and memory come from `os` (in-process counters, no syscall fan-out); cores
 * come from the already-memoized `@papercusp/resource-profile`; the one file
 * read (`/proc/pressure/memory`) is cached for {@link PSI_CACHE_MS} and is
 * fully optional — every leg fails soft to `undefined` rather than degrading
 * the orient around it.
 */

import { freemem, loadavg, totalmem } from 'node:os';
import { readFileSync } from 'node:fs';
// The Papercusp BINDING, not the generic lib directly: it injects the two domain
// signals (embeddedPg, hostRole) the generic derivation needs, and is the one
// place this app reads the host. Importing the generic export here would read an
// unconfigured profile.
import { getResourceProfile } from './resource-profile';

/** How long a `/proc/pressure/memory` read is reused. Orient is called often
 *  enough that re-reading per call is pointless; PSI avg10/avg60 cannot move
 *  meaningfully inside this window. */
export const PSI_CACHE_MS = 5_000;

/**
 * The scalars an agent would otherwise shell out for.
 *
 * Every field except `now` is optional: a leg that cannot be read is ABSENT
 * rather than zero, so a consumer never mistakes "unreadable" for "idle". `now`
 * is the only guaranteed field because a clock read cannot fail.
 */
export interface HostSnapshot {
  /** Current instant, ISO-8601 UTC with milliseconds. Replaces the 586 bare
   *  `date` / `date -u` reads: every other format the corpus asks for (`+%s`,
   *  `+%H:%M:%SZ`, `+%FT%TZ`, …) is a pure rendering of this same instant. */
  now: string;
  /** Effective (cgroup-quota-aware) core count — the `nproc` answer. */
  cores?: number;
  /** Coarse host bucket from the resource profile: laptop | workstation | server. */
  hostClass?: string;
  /** 1/5/15-minute load averages — the `uptime` / `cat /proc/loadavg` answer. */
  load?: [number, number, number];
  /** Free RAM as a percentage of total, rounded — the `free -h` answer, in the
   *  form the question is actually asked in ("is this box out of memory?"). */
  memFreePct?: number;
  /** Total RAM in GB, rounded — the denominator behind `memFreePct`. */
  memTotalGb?: number;
  /** Linux PSI "some" memory-pressure avg60, when readable. The watchdog already
   *  alarms on this signal (the PER-THREAD WEDGE condition), so surfacing it here
   *  lets an agent see the same number the alarm sees rather than inferring
   *  thrashing from a load average, which cannot distinguish the two. */
  psiMemSome60?: number;
}

let psiCache: { at: number; value: number | undefined } | undefined;

/**
 * Read PSI memory pressure avg60, cached and fail-soft.
 *
 * `/proc/pressure/memory` is Linux-only and absent under some container
 * configurations; either way the correct result is `undefined` (the field is
 * omitted), never a fabricated 0 — a zero would read as "no pressure", which is
 * the opposite of "I could not tell".
 */
function readPsiMemSome60(now: number): number | undefined {
  if (psiCache && now - psiCache.at < PSI_CACHE_MS) return psiCache.value;
  let value: number | undefined;
  try {
    // Format: `some avg10=0.00 avg60=0.00 avg300=0.00 total=0`
    const line = readFileSync('/proc/pressure/memory', 'utf8').split('\n')[0] ?? '';
    const m = line.match(/\bavg60=([\d.]+)/);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n)) value = n;
    }
  } catch {
    /* not Linux, or not permitted — the field is simply absent */
  }
  psiCache = { at: now, value };
  return value;
}

/** Test seam: drop the PSI cache so a test can control what the next read sees. */
export function resetHostSnapshotCache(): void {
  psiCache = undefined;
}

/**
 * Build the snapshot. Never throws: every leg is independently guarded, so the
 * worst case is a result carrying `now` alone.
 */
export function getHostSnapshot(): HostSnapshot {
  const nowMs = Date.now();
  const snap: HostSnapshot = { now: new Date(nowMs).toISOString() };

  try {
    const profile = getResourceProfile();
    // NB: the core count lives on `signals`, not on the profile root — the root
    // carries DERIVED caps (maxSimultaneousAgents, pgPoolMax, …), not the raw
    // signal. Reading `profile.cores` returns undefined SILENTLY, which is how
    // this field shipped absent the first time.
    const cores = profile.signals?.cores;
    if (typeof cores === 'number' && Number.isFinite(cores)) snap.cores = cores;
    if (profile.hostClass) snap.hostClass = profile.hostClass;
  } catch {
    /* profile unavailable — cores/hostClass absent */
  }

  try {
    const [a, b, c] = loadavg();
    // Darwin/Linux both provide this; a all-zero triple on an unsupported
    // platform is indistinguishable from a genuinely idle box, so keep it —
    // the field means "what loadavg() reports", which is what `uptime` prints.
    if (Number.isFinite(a)) snap.load = [round2(a), round2(b), round2(c)];
  } catch {
    /* absent */
  }

  try {
    const total = totalmem();
    const free = freemem();
    if (total > 0) {
      snap.memFreePct = Math.round((free / total) * 100);
      snap.memTotalGb = Math.round(total / 1024 ** 3);
    }
  } catch {
    /* absent */
  }

  const psi = readPsiMemSome60(nowMs);
  if (psi !== undefined) snap.psiMemSome60 = psi;

  return snap;
}

function round2(n: number): number {
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}
