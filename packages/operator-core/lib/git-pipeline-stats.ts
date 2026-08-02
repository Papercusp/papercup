/**
 * git-pipeline-stats — the composite read behind the /admin Git tab.
 *
 * Stitches together the whole git-sync → green-checkpoint → release pipeline's
 * state + history from the places it actually lives:
 *   - `harness_shared.routines`           — the three routines (git-sync,
 *                                            green-checkpoint, release-trigger):
 *                                            active/cron/schedule + git-sync's
 *                                            latest metadata (last_status,
 *                                            last_resolver, head_sha, …).
 *   - `harness_shared.harness_escalations` — the currently-OPEN merge conflict
 *                                            (git-sync-conflict kind), if any.
 *   - `harness_shared.pipeline_events`     — the append-only history (mig 177):
 *                                            windowed counts + a recent timeline.
 *   - `devDeployState()`                   — the release-gate snapshot (main vs
 *                                            `ready` green pin vs deployed :3070).
 *
 * READ-ONLY: pure aggregation, mutates nothing. Resolves a best-effort snapshot
 * (sub-reads that fail degrade to null/empty) so the panel always renders.
 */
import { getOrgPg } from '@papercusp/db-org';
import { cellUnknown, type CellUnknown } from './cell-contract';
import { devDeployState, type DevDeployState } from './dev-deploy-state';
import {
  summarizePipelineWindow,
  recentPipelineEvents,
  type PipelineWindowSummary,
  type PipelineEventRow,
} from './harness/git-sync/pipeline-events';
import { operatorHomeHarnessSlug } from './harness/operator-home-harness';
import { evaluateGateVerdictFreshness, type GateVerdictFreshness } from './release/gate-verdict-freshness';
import {
  describeGateRedOwnership,
  gateFailureSignature,
  type GateRedOwnership,
} from './release/gate-red-ownership';
import { releaseFixerSpawnAlive } from './release/fixer-liveness';
import { parseInFlightRetriage, type StoredInFlightRetriage } from './release/in-flight-retriage';

/** The operator's own integration harness (its git-sync/release routines). */
const DEFAULT_SLUG = process.env.RELEASE_ROUTINE_SLUG ?? operatorHomeHarnessSlug();

export interface RoutineInfo {
  name: string;
  active: boolean;
  cron: string | null;
  lastFiredAtMs: number | null;
  nextFireAtMs: number | null;
}

export interface GitPipelineSnapshot {
  slug: string;
  generatedAtMs: number;

  routines: {
    gitSync: RoutineInfo | null;
    greenCheckpoint: RoutineInfo | null;
    releaseTrigger: RoutineInfo | null;
  };

  /** Latest git-sync tick (from routines.metadata — single newest state). */
  gitSync: {
    lastStatus: string | null;
    lastSyncedAtMs: number | null;
    consecutiveErrorTicks: number;
    headSha: string | null;
    lastPushed: string[];
    lastMerged: string[];
    lastConflicts: string[];
    lastErrors: string[];
    /**
     * The member's EFFECTIVE push mode this tick: `'push'`, or `'commit-only:<reason>'`
     * where reason is the hive git mode (`bridged` / `p2p-only`) or `config`.
     * `null` on rows written before git-sync recorded it — treat null as UNKNOWN, never
     * as "it pushes" (EI-18812945811758018).
     */
    pushMode: string | null;
  };

  /** The merge-resolver (opus:xhigh) — model + last dispatch outcome. */
  resolver: {
    model: string;
    lastStatus: string | null;
    lastAtMs: number | null;
    lastExitCode: number | null;
    lastHttpStatus: number | null;
    lastTimedOut: boolean | null;
    lastScopes: string[];
  };

  /** The green-checkpoint gate health (P-004): the red streak + time since the
   *  last green + the last release-fixer dispatch — from the green-checkpoint
   *  routine metadata (`gate_health` + `last_fixer`). `stalled` is true once the
   *  red streak / age crossed the alert threshold. */
  gate: {
    consecutiveReds: number;
    /**
     * unified-agent-state-plane-2026-07-27 P-007, D-038 axis 2 — is `consecutiveReds`
     * above a MEASUREMENT, or the `?? 0` default standing in for one?
     *
     * `null` means measured. A `CellUnknown` means `gate_health.consecutiveReds` was
     * ABSENT or unparseable, so the `0` above is a DEFAULT — byte-identical to a
     * measured "no reds", and read by every consumer as "the gate is passing".
     *
     * ⚠ WHY THIS IS NOT ALREADY COVERED, because it looks like it should be. The gate
     * has TWO rich staleness models and BOTH are structurally blind here:
     *   · `fireStale` (WI-282) asks "is the routine FIRING?" — a wedged ticker. It does
     *     not ask whether the counter it produced exists.
     *   · `verdictStale` (WI-4489) asks "is the recorded verdict CURRENT?" — and
     *     `evaluateGateVerdictFreshness` opens with `if (consecutiveReds <= 0) return
     *     { stale: false }`, commented "Only a RED verdict can misdirect. A stale green
     *     is inert." That premise is TRUE of a stale green and FALSE of an unmeasured
     *     one: a green that was never measured is not inert, it is FABRICATED. The
     *     short-circuit lands on exactly the case this field exists to name.
     *
     * So a caller must not read `consecutiveReds === 0` as "green" without checking
     * this. The same value, hoisted to the result level where a hurried caller cannot
     * skip it, is `PipelinePosition.verdictUnknown`.
     */
    countersUnknown: CellUnknown | null;
    lastGreenAtMs: number | null;
    firstRedAtMs: number | null;
    stalled: boolean;
    /** WI-282: the green-checkpoint routine's last fire (epoch ms) + a freshness
     *  verdict, so a WEDGED / non-firing ticker is VISIBLE even though it produces
     *  0 reds — the reds-based `stalled` is structurally blind to a checkpoint that
     *  never ran (it can't go red without running). `fireStale` reuses the
     *  green-stall-watchdog's pure logic (last-fire / last-green age). */
    lastFiredAtMs: number | null;
    fireStale: boolean;
    fireStaleReason: string | null;
    /** WI-4489: when the last REAL verdict was observed, and whether the recorded RED can still be
     *  trusted. `fireStale` asks "is the routine FIRING?"; this asks "is its VERDICT current?" —
     *  a `skipped-locked` fire refreshes `last_fired_at` while writing no verdict, so the routine
     *  can look perfectly healthy while `consecutiveReds` is hours stale. A stale red must never be
     *  reported as the gate's colour, nor dispatch anyone at the tests it names. */
    verdictObservedAtMs: number | null;
    verdictStale: boolean;
    verdictStaleReason: string | null;
    /** EI-18669342433807110: WHICH freshness rule fired (see GateVerdictFreshness.reasonCode) —
     *  lets a consumer distinguish `refire-in-flight` (a fresh verdict is imminent; do not even
     *  re-run the checkpoint) from the other stale reasons (which DO want a fresh run fired).
     *  Null whenever `verdictStale` is false. */
    verdictStaleReasonCode?: GateVerdictFreshness['reasonCode'];
    lastFixerStatus: string | null;
    lastFixerAtMs: number | null;
    lastFixerCandidate: string | null;
    /** EI-18672078222841101: WHO, if anyone, already owns this red — the question every
     *  recipient of a gate-red alert asks first and that no read surface answered. The
     *  three `lastFixer*` fields above look like they answer it and do not: they are keyed
     *  by CANDIDATE, and while the gate is red staging advances hourly so every checkpoint
     *  is a new candidate. Only the SIGNATURE says whether the recorded fixer is on THIS
     *  failure, and only spawn liveness says whether it is still working. Both already
     *  existed (P-012 `last_fixer.signature`, `releaseFixerSpawnAlive`) and were used
     *  solely to suppress duplicate fixer dispatch — never shown to the agents who then
     *  duplicated the diagnosis by hand. `null` on a green gate. */
    redOwner: GateRedOwnership | null;
    /** P-009: workspaces that have flaked ≥3× in the gate (failed-then-passed-on-
     *  retry) — chronically flaky, quarantine candidates. */
    flakyWorkspaces: string[];
    /** WI-4533: the tests the gate ITSELF named in its last verdict (`gate_health.failingTests`)
     *  — the workspace(s) + file path(s) that actually redded it. The blob has carried these all
     *  along and NO read surfaced them, so every consumer asking "what is red?" fell back to
     *  why-chain's 2h `test_runs` heuristic — which, measured live on a red gate (2026-07-13),
     *  returned NOTHING while this field held all four culprits. First-hand evidence beats a
     *  time-windowed proxy: this is the gate's own answer to "which tests are failing".
     *  Empty on a green gate — and NEVER to be trusted when `verdictStale` (WI-4489: those names
     *  are what a phantom dispatch chases). */
    failingTests: string[];
    /** EI-17603 (follow-up to WI-4533): the short sha of the candidate THIS verdict's
     *  `failingTests` pertains to (`gate_health.observedCandidate`, recorded alongside
     *  `failingTests` since it was added but never surfaced here until now). Lets a
     *  consumer cross-check the gate's own named failures against first-hand ledger
     *  evidence (`harness_shared.test_runs`) for the EXACT commit under verdict, instead
     *  of trusting the recorded list blind — see `verifyGateVerdict` in why-chain.ts.
     *  Null on a blob predating this field, or when there is no candidate to attribute. */
    observedCandidate: string | null;
    /** EI-13288: when THIS verdict's own stale-candidate re-triage already proved its named
     *  `failingTests` pass at a newer tip (auto-refire cap reached before a full suite could
     *  confirm that tip green), the short sha of that tip — feeds Rule 3 of
     *  gate-verdict-freshness.ts. Null when this red's retriage was real-red/unknown, or on a
     *  blob predating this field. */
    retriageStaleTip: string | null;
    /** Human-readable detail for `retriageStaleTip` (from the re-triage classifier), for a
     *  reader who wants the "why" without re-deriving it. Null alongside `retriageStaleTip`. */
    retriageDetail: string | null;
    /** EI-18669342433807110: a stale-candidate auto-refire for THIS red is running RIGHT NOW
     *  (`gate_health.inFlightRetriage`, already freshness-checked by `parseInFlightRetriage`).
     *  Feeds Rule 4 of gate-verdict-freshness.ts. Null when no refire is in flight, or its
     *  marker is missing/abandoned. */
    inFlightRetriage?: StoredInFlightRetriage | null;
  };

  /** A currently-OPEN merge conflict (resolver still working / unresolved), or null. */
  openConflict: {
    scopes: string[];
    conflicts: { scope: string; files: string[] }[];
    emittedAtMs: number | null;
  } | null;

  /** Windowed counts from the append-only history (mig 177). */
  windows: { day: PipelineWindowSummary; week: PipelineWindowSummary };

  /** Recent pipeline events, newest first (the timeline). */
  recent: PipelineEventRow[];

  /** Release-gate snapshot (main vs `ready` vs deployed :3070). */
  deploy: DevDeployState;

  /** overview-tab-expansion-2026-07-20 P-001: the LIVE green-checkpoint suite run
   *  (systemd probe via checkActiveCheckpointRun — the same self-healing check the
   *  launch path uses). `null` = NOT PROBED (the default: live callers — watchdogs,
   *  why-chain, position, tools — skip the systemctl fork); `{ active:false }` =
   *  probed and idle. Only the background derived-read producer (`dev.gitPipeline`)
   *  opts in, so the "judging vs idle" verdict reaches the UI with zero cost on
   *  every other snapshot read. */
  activeRun: {
    active: boolean;
    /** Short/full sha the live run is judging — null if unreadable.
     *
     * EI-19327704778173646: this is the run's CURRENT candidate (the LAST
     * `checkpointing candidate` line in its log), not the one it started on. A single run
     * can legitimately re-candidate mid-flight: on a stale red, green-checkpoint recurses
     * in-process onto tip and re-pins its checkout, while pid/started_at stay fixed. So
     * this value CAN change between two reads of the same run, and a candidate newer than
     * `startedAtMs` is the expected signature of a healthy auto-refire — never read it as
     * corruption, and never fire a manual run over it (that discards the in-flight rescue
     * and costs a full suite). When it has moved, `initialCandidate`/`refireObserved` below
     * say so explicitly. */
    candidate: string | null;
    /** EI-19327704778173646: the candidate this run STARTED on, present only when it has
     *  since re-candidated. Provenance — never verify a fix against this sha. */
    initialCandidate?: string | null;
    /** EI-19327704778173646: true when the run demonstrably re-candidated mid-flight. A
     *  `false`/absent is NOT proof no refire happened, only that none was visible. */
    refireObserved?: boolean;
    startedAtMs: number | null;
    elapsedSec: number | null;
  } | null;
}

/** The configured merge-resolver model spec (`AGENT_MODELS` → committed floor). */
export function resolverModel(): string {
  try {
    const raw = process.env.AGENT_MODELS;
    if (raw) {
      const m = JSON.parse(raw) as Record<string, unknown>;
      if (typeof m['merge-resolver'] === 'string' && m['merge-resolver'].trim()) return m['merge-resolver'];
    }
  } catch {
    /* malformed AGENT_MODELS — fall through to the committed default */
  }
  return 'opus:xhigh';
}

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}
function strArr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}
function dateMs(v: unknown): number | null {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'string') {
    const t = new Date(v).getTime();
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

interface RoutineRow {
  name: string;
  active: boolean;
  trigger_config: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  last_fired_at: Date | string | null;
  next_fire_at: Date | string | null;
}

export function toRoutineInfo(r: RoutineRow | undefined): RoutineInfo | null {
  if (!r) return null;
  return {
    name: r.name,
    active: Boolean(r.active),
    cron: typeof r.trigger_config?.cron === 'string' ? (r.trigger_config.cron as string) : null,
    lastFiredAtMs: dateMs(r.last_fired_at),
    nextFireAtMs: dateMs(r.next_fire_at),
  };
}

export interface RawGateCounters {
  consecutiveReds: number;
  stalled: boolean;
  failingTests: string[];
  firstRedAtMs: number | null;
}

/**
 * EI-13714 — PURE: decide whether the raw cached gate counters (`consecutiveReds` / `stalled` /
 * `failingTests` / `firstRedAtMs`, straight off the `gate_health` blob) must be corrected before
 * being reported anywhere, given the verdict-freshness rule that fired (if any).
 *
 * ONLY `'pin-advance'` is hard proof a green happened since these counters were recorded — the
 * release pin only ever moves on a green checkpoint, so its advance past this verdict's base
 * PROVES the streak it was raised on has already ended. `'writer-starved'` and `'retriage-proven'`
 * only prove the cached verdict is UNVERIFIED, not that the gate is green (WI-4489's "unknown, not
 * green" stays correct for those) — so they, and a fresh (non-stale) verdict, leave the raw
 * counters untouched.
 *
 * This is the ONE place the correction is applied. Every consumer of `GitPipelineSnapshot.gate`
 * (git-pipeline-position, release-deploy-launch's `computeDeployStatus`, why-chain's `gateLabel`,
 * the `coord:orient` pipeline-health fold) reads these fields as-is, so deriving the corrected
 * value here — rather than each of those independently re-checking `verdictStale` — is what keeps
 * a `release:deploy{op:status}` reply from reporting `green:false, stalled:true` in the same
 * response that already proves (`verdictStale:true`, pin-advance reason) that it greened.
 *
 * Exported + pure so this decisive branch is unit-testable without a live Postgres (the full
 * `gitPipelineSnapshot` read is otherwise only exercised via integration test / live verification).
 */
export function pinProvenGateCorrection(
  reasonCode: GateVerdictFreshness['reasonCode'],
  raw: RawGateCounters,
): RawGateCounters {
  if (reasonCode !== 'pin-advance') return raw;
  return { consecutiveReds: 0, stalled: false, failingTests: [], firstRedAtMs: null };
}

/** Options for `gitPipelineSnapshot` (overview-tab-expansion P-001). */
export interface GitPipelineSnapshotOpts {
  /** Probe the live green-checkpoint systemd unit ("judging vs idle") into `activeRun`.
   *  Default FALSE — the probe forks systemctl, so only the background derived-read
   *  producer opts in; live callers stay fork-free. */
  includeActiveRun?: boolean;
  /** Test seam: the probe fn (defaults to release-checkpoint-launch's
   *  checkActiveCheckpointRun, dynamic-imported only when opted in). */
  probeActiveRun?: (root: string) => {
    active: boolean;
    candidate?: string | null;
    started_at?: string | null;
    elapsed_sec?: number | null;
  };
}

/** PURE (P-001): map a checkActiveCheckpointRun probe result onto the snapshot's
 *  `activeRun` shape (systemd timestamp → epoch ms; absent fields → null). */
export function mapActiveRun(r: {
  active: boolean;
  candidate?: string | null;
  // EI-19327704778173646: refire provenance from the probe, carried through so a caller
  // can tell a candidate that legitimately MOVED from a field that looks unstable.
  initial_candidate?: string | null;
  refire_observed?: boolean;
  started_at?: string | null;
  elapsed_sec?: number | null;
}): NonNullable<GitPipelineSnapshot['activeRun']> {
  const startedAtMs = r.started_at ? Date.parse(r.started_at) : NaN;
  return {
    active: r.active,
    candidate: r.candidate ?? null,
    // Emitted ONLY on an actual refire, so the common reply shape is unchanged.
    ...(r.refire_observed ? { initialCandidate: r.initial_candidate ?? null, refireObserved: true } : {}),
    startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : null,
    elapsedSec: r.elapsed_sec ?? null,
  };
}

/** Compute the full pipeline snapshot for `slug` (defaults to the operator's own). */
export async function gitPipelineSnapshot(
  slug: string = DEFAULT_SLUG,
  opts: GitPipelineSnapshotOpts = {},
): Promise<GitPipelineSnapshot> {
  const { sql } = getOrgPg();

  // The three pipeline routines + git-sync's latest metadata, in one read.
  let routineRows: RoutineRow[] = [];
  try {
    routineRows = await sql<RoutineRow[]>`
      SELECT name, active, trigger_config, metadata, last_fired_at, next_fire_at
        FROM harness_shared.routines
       WHERE install_slug = ${slug}
         AND name IN ('git-sync', 'green-checkpoint', 'release-trigger')
    `;
  } catch {
    routineRows = [];
  }
  const byName = (n: string) => routineRows.find((r) => r.name === n);
  const gitSyncRow = byName('git-sync');
  const meta = (gitSyncRow?.metadata ?? {}) as Record<string, unknown>;
  const lastResolver = (meta.last_resolver ?? null) as Record<string, unknown> | null;
  // P-004: green-checkpoint gate health (red streak + last release-fixer).
  const gcMeta = (byName('green-checkpoint')?.metadata ?? {}) as Record<string, unknown>;
  const gateHealth = (gcMeta.gate_health ?? {}) as Record<string, unknown>;
  const lastFixer = (gcMeta.last_fixer ?? null) as Record<string, unknown> | null;
  const flakeHistory = (gcMeta.flake_history ?? {}) as Record<string, { flakes?: number }>;

  // WI-282: a wedged / non-firing green-checkpoint produces 0 reds (it never ran to
  // go red), so the reds-based `stalled` stays false while `main` silently freezes.
  // Reuse the green-stall-watchdog's pure freshness verdict (last-fire / last-green
  // age) so the gate READ surfaces a wedge too — independent of the red streak.
  const gcRow = byName('green-checkpoint');
  const gcLastFiredMs = dateMs(gcRow?.last_fired_at);
  let gcFireStale = false;
  let gcFireStaleReason: string | null = null;
  if (gcRow?.active === true) {
    try {
      const { evaluateGreenStall } = await import('./release/green-stall-watchdog');
      const v = evaluateGreenStall(
        {
          lastFiredMs: gcLastFiredMs,
          lastGreenAt: num(gateHealth.lastGreenAt),
          watchdogAlerted: gateHealth.watchdogAlerted === true,
        },
        Date.now(),
      );
      gcFireStale = v.stalled;
      gcFireStaleReason = v.reason;
    } catch {
      // best-effort — a freshness probe must never break the snapshot read.
    }
  }

  // The currently-open merge conflict (git-sync-conflict escalation), if any.
  let openConflict: GitPipelineSnapshot['openConflict'] = null;
  try {
    const escRows = await sql<{ escalation: Record<string, unknown> }[]>`
      SELECT escalation
        FROM harness_shared.harness_escalations
       WHERE harness_slug = ${slug}
         AND escalation IS NOT NULL
         AND (escalation::jsonb ->> 'kind') = 'git-sync-conflict'
       LIMIT 1
    `;
    const esc = escRows[0]?.escalation;
    if (esc) {
      const conflicts = Array.isArray(esc.conflicts)
        ? (esc.conflicts as Array<Record<string, unknown>>).map((c) => ({
            scope: String(c.scope ?? ''),
            files: strArr(c.conflicted_files),
          }))
        : [];
      openConflict = {
        scopes: conflicts.map((c) => c.scope).filter(Boolean),
        conflicts,
        emittedAtMs: num(esc.emitted_at),
      };
    }
  } catch {
    openConflict = null;
  }

  const [day, week, recent, deploy] = await Promise.all([
    summarizePipelineWindow(slug, 24 * 60 * 60),
    summarizePipelineWindow(slug, 7 * 24 * 60 * 60),
    recentPipelineEvents(slug, 25),
    devDeployState(),
  ]);

  // WI-4489: is the recorded RED still trustworthy? The green pin is the ground truth (it only
  // advances on a green checkpoint); `gate_health` is a cache of it that a starved writer can
  // freeze indefinitely. Needs `deploy.greenPinSha`, so it is derived here rather than above.
  const verdictObservedAtMs = num(gateHealth.observedAt);
  const retriageStaleTip = typeof gateHealth.retriageStaleTip === 'string' ? gateHealth.retriageStaleTip : null;
  const retriageDetail = typeof gateHealth.retriageDetail === 'string' ? gateHealth.retriageDetail : null;
  // EI-18669342433807110 — Rule 4: a stale-candidate auto-refire for the cached red running RIGHT
  // NOW, already freshness-checked (missing/malformed/abandoned ⇒ null).
  const inFlightRetriage = parseInFlightRetriage(gateHealth.inFlightRetriage);
  /**
   * P-007 (D-038 axis 2). The `?? 0` below is load-bearing for every downstream
   * consumer — they all expect a number — but the fallback DESTROYS the distinction
   * between "the gate ran and recorded no reds" and "no counter was recorded at all",
   * and those read identically as a passing gate. Capture which one it was BEFORE the
   * default is applied; it is unrecoverable afterwards.
   */
  const measuredConsecutiveReds = num(gateHealth.consecutiveReds);
  const countersUnknown: CellUnknown | null =
    measuredConsecutiveReds == null
      ? cellUnknown(
          'resolver-failed',
          'the green-checkpoint routine metadata (`gate_health.consecutiveReds`) carried no readable red-streak counter, so the reported 0 is a DEFAULT and not a measurement — do not read it as a passing gate',
        )
      : null;
  const rawConsecutiveReds = measuredConsecutiveReds ?? 0;
  const {
    stale: gcVerdictStale,
    reason: gcVerdictStaleReason,
    reasonCode: gcVerdictStaleReasonCode,
  } = evaluateGateVerdictFreshness({
    consecutiveReds: rawConsecutiveReds,
    observedAtMs: verdictObservedAtMs,
    observedFromPin: typeof gateHealth.lastFrom === 'string' ? gateHealth.lastFrom : null,
    // The release ("ready") pin — the green-checkpoint's own durable verdict, in git.
    currentGreenPinSha: deploy.greenPin?.sha ?? null,
    lastFiredAtMs: gcLastFiredMs,
    // EI-13288 — Rule 3: this verdict's own re-triage evidence, when it has any.
    retriageStaleTip,
    // EI-18669342433807110 — Rule 4: an in-flight refire for this exact red, when one is running.
    inFlightRetriage,
  });
  const effectiveGate = pinProvenGateCorrection(gcVerdictStaleReasonCode, {
    consecutiveReds: rawConsecutiveReds,
    stalled: gateHealth.stallAlerted === true,
    failingTests: strArr(gateHealth.failingTests),
    firstRedAtMs: num(gateHealth.firstRedAt),
  });

  // EI-18672078222841101: resolve WHO owns this red, from state the system already keeps.
  // Only for an actually-red gate — a green gate has no ownership question, and asking one
  // would put a misleading "UNOWNED" on every healthy read.
  //
  // The liveness query runs ONLY when the recorded fixer holds the CURRENT signature: a
  // mismatch is already decisive ('stale-signature' — that fixer is on a different failure),
  // so the round-trip would buy nothing. On a green gate it never runs at all. Failure is
  // soft: `null` renders as 'owned-unknown' (presumed covered), the same assumption the
  // dispatcher makes for a record it cannot resolve — never a fabricated liveness value.
  let redOwner: GateRedOwnership | null = null;
  if (effectiveGate.consecutiveReds > 0) {
    const currentSignature = gateFailureSignature(
      effectiveGate.failingTests,
      typeof gateHealth.observedCandidate === 'string' ? gateHealth.observedCandidate : null,
    );
    const ownerSignature = typeof lastFixer?.signature === 'string' ? lastFixer.signature : null;
    const spawnId = typeof lastFixer?.spawnId === 'string' ? lastFixer.spawnId : null;
    let fixerAlive: boolean | null = null;
    if (!gcVerdictStale && ownerSignature && currentSignature && ownerSignature === currentSignature) {
      fixerAlive = await releaseFixerSpawnAlive(sql, spawnId).catch(() => null);
    }
    redOwner = describeGateRedOwnership({
      ownerSignature,
      currentSignature,
      dispatchedAtMs: num(lastFixer?.at),
      spawnId,
      fixerAlive,
      verdictStale: gcVerdictStale,
      nowMs: Date.now(),
    });
  }

  // P-001: "judging vs idle" — probe the live checkpoint unit ONLY when opted in
  // (the dev.gitPipeline derived-read producer; see the interface note). Best-effort:
  // a probe failure yields null (not probed), never a broken snapshot.
  let activeRun: GitPipelineSnapshot['activeRun'] = null;
  if (opts.includeActiveRun) {
    try {
      const probe =
        opts.probeActiveRun ?? (await import('./release-checkpoint-launch')).checkActiveCheckpointRun;
      activeRun = mapActiveRun(probe(deploy.integrationRoot));
    } catch {
      activeRun = null;
    }
  }

  return {
    slug,
    generatedAtMs: Date.now(),
    routines: {
      gitSync: toRoutineInfo(gitSyncRow),
      greenCheckpoint: toRoutineInfo(byName('green-checkpoint')),
      releaseTrigger: toRoutineInfo(byName('release-trigger')),
    },
    gitSync: {
      lastStatus: typeof meta.last_status === 'string' ? meta.last_status : null,
      lastSyncedAtMs: num(meta.last_synced_at),
      consecutiveErrorTicks: num(meta.consecutive_error_ticks) ?? 0,
      headSha: typeof meta.head_sha === 'string' ? meta.head_sha : null,
      lastPushed: strArr(meta.last_pushed),
      lastMerged: strArr(meta.last_merged),
      lastConflicts: strArr(meta.last_conflicts),
      lastErrors: strArr(meta.last_errors),
      // EI-18812945811758018: 'push' | 'commit-only:<reason>' | null (older rows, before
      // git-sync recorded it). NEVER default this to 'push' — an absent mode is UNKNOWN,
      // and guessing "it pushes" is what made an empty lastPushed read as a fault.
      pushMode: typeof meta.push_mode === 'string' ? meta.push_mode : null,
    },
    resolver: {
      model: resolverModel(),
      lastStatus: typeof lastResolver?.status === 'string' ? lastResolver.status : null,
      lastAtMs: num(lastResolver?.at),
      lastExitCode: num(lastResolver?.exitCode),
      lastHttpStatus: num(lastResolver?.httpStatus),
      lastTimedOut: typeof lastResolver?.timedOut === 'boolean' ? lastResolver.timedOut : null,
      lastScopes: strArr(lastResolver?.scopes),
    },
    gate: {
      // EI-13714: reset to 0 when a pin advance PROVES a green happened since this count was
      // recorded — never left as a stale, alarm-triggering streak (see `pinProvenGateCorrection`).
      consecutiveReds: effectiveGate.consecutiveReds,
      countersUnknown,
      lastGreenAtMs: num(gateHealth.lastGreenAt),
      firstRedAtMs: effectiveGate.firstRedAtMs,
      // A stalled-streak alert can't survive proof the streak it was raised on has already ended.
      stalled: effectiveGate.stalled,
      lastFiredAtMs: gcLastFiredMs,
      fireStale: gcFireStale,
      fireStaleReason: gcFireStaleReason,
      verdictObservedAtMs,
      verdictStale: gcVerdictStale,
      verdictStaleReason: gcVerdictStaleReason,
      verdictStaleReasonCode: gcVerdictStaleReasonCode,
      lastFixerStatus: typeof lastFixer?.status === 'string' ? lastFixer.status : null,
      lastFixerAtMs: num(lastFixer?.at),
      lastFixerCandidate: typeof lastFixer?.candidate === 'string' ? lastFixer.candidate : null,
      redOwner,
      // WI-4533: the gate's OWN verdict about what is failing (see the type's note) — never the
      // names behind a streak already proven reset (they'd misdirect a fixer at passing tests).
      failingTests: effectiveGate.failingTests,
      // Not part of `RawGateCounters`/`pinProvenGateCorrection`: a proven pin-advance already
      // wipes `failingTests` to `[]` above, which alone makes `verifyGateVerdict`'s file-shaped
      // check a no-op — no separate reset needed for the candidate it was attributed to.
      observedCandidate: typeof gateHealth.observedCandidate === 'string' ? gateHealth.observedCandidate : null,
      retriageStaleTip,
      retriageDetail,
      inFlightRetriage,
      flakyWorkspaces: Object.entries(flakeHistory)
        .filter(([, v]) => (v?.flakes ?? 0) >= 3)
        .map(([ws]) => ws),
    },
    openConflict,
    windows: { day, week },
    recent,
    deploy,
    activeRun,
  };
}
