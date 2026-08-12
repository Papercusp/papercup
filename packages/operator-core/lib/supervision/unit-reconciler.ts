/**
 * Failed-unit reconciler (critical-process-supervisor-2026-07-04 P-002, EI-7021 design).
 *
 * Cross-references the `SUPERVISED_PROCESSES` registry (`../service-health.ts`, P-001/WI-3668)
 * against LIVE `systemctl --user` state for every `layer:'systemd-user'` entry and — when
 * `FLAGS.supervisorAutoRestart` is on AND the entry itself opts in (`autoRestart:true`) —
 * restarts a failed/inactive-but-expected unit, with uniform flap-damping (## Design,
 * critical-process-supervisor-2026-07-04):
 *
 *   - respawn backoff 1s → 5s → 15s → 60s (cap);
 *   - give-up: ≥6 restarts within a 10-minute window → STOP restarting, escalate loudly;
 *   - reset: 5 minutes continuously healthy resets the restart counter + give-up latch.
 *
 * Before EVER attempting a restart we also check systemd's OWN damping
 * (`systemctl --user show <unit> -p Result,NRestarts`): `Result=start-limit-hit` means
 * systemd's `StartLimitBurst` already tripped — restarting in a loop against that is
 * pointless (and fights systemd), so we escalate instead.
 *
 * `papercup-live-federation-gate.service` (and any other `autoRestart:false` registry entry)
 * is REPORT-ONLY by construction — the decision layer never proposes a restart for it.
 *
 * WI-5378: an `autoRestart:true` entry (e.g. `papercup-live-federation-gate.timer`, added under
 * WI-5376 so the timer self-heals if something kills it unexpectedly) must NOT fight a
 * DELIBERATE pause. `systemctl --user stop <unit>` alone reads identically to a crash (`active:
 * inactive`) — indistinguishable to `isUnitDown()` — so a "leader-ordered pause" that only
 * stops the unit gets silently re-armed by this very reconciler within its normal backoff
 * window. The authoritative pause signal is therefore the unit's persisted enablement
 * (`UnitFileState`, from `systemctl --user show -p UnitFileState`): `disable --now` (not just
 * `stop`) is the supported way to pause a supervised systemd-user unit, and
 * `decideReconcile` treats `disabled`/`masked` as an intentional pause — report-only, never a
 * restart target — regardless of `autoRestart`/`FLAGS.supervisorAutoRestart`. Re-`enable` (or
 * `enable --now`) resumes normal supervision. `papercup-live-federation-gate.timer` HAS an
 * `[Install]` section (`WantedBy=timers.target`), so `disable` genuinely persists on it (unlike
 * the `.service`, which is `static` and can't be enabled/disabled at all — `systemctl disable`
 * on it is already a documented no-op, hence pausing the GATE means disabling the TIMER).
 *
 * Runs as a bespoke `tier:'ephemeral'` routine (`system:supervision-reconcile`, 60s cadence),
 * mirroring `harness/git-sync/hive-git-gc-routine.ts`'s shape: this is an operator-HOME-level
 * concern (systemd units on ONE box), not a per-blueprint-install generic cadence, so it gets
 * its own seed/action pair instead of a per-install `triggers.schedule` blueprint entry (the
 * same reasoning hive-git-gc-routine.ts documents for its own deviation from the generic path).
 * See `../harness/routines/supervision-reconcile-action.ts` (the `system:` registration) and
 * `../harness/routines/seed-supervision-reconcile-routine.ts` (the seed script).
 *
 * PURE functions (parse / decide) below are unit-tested directly (fixture-driven, no PG, no
 * child_process). The orchestrator (`reconcileTick`) takes injected deps so a test can mock
 * `execUser` + `now` + `notify` without shelling out — see the colocated `.test.ts`.
 */
import { supervisedProcesses, type SupervisionEntry } from '../service-health';
import type { SupervisionGiveUpEpisode, RecoveredSupervisionEpisode } from './give-up-ei';
import type { SupervisionPausedEpisode, ResumedSupervisionEpisode } from './paused-unit-ei';
import {
  decidePause,
  formatPauseDuration,
  updatePauseState,
  _resetPauseClockForTests,
  type PauseDecision,
  type PauseState,
  type PauseStoreDeps,
} from './pause-clock';

// ── Parsing (pure) ──────────────────────────────────────────────────────────

export interface SystemctlUnitStatus {
  unit: string;
  load: string;
  active: string;
  sub: string;
  description: string;
}

/**
 * Parse `systemctl --user list-units '<glob>' --all --no-legend` output. Each line:
 * `[● ]<unit> <load> <active> <sub> <description...>` — the first four fields never contain
 * whitespace; the description is free text (may be empty). A leading `●` marker (systemd's
 * TTY "problem" bullet — usually absent with --no-legend on a non-tty pipe, but tolerated
 * defensively) and blank lines are skipped.
 */
export function parseSystemctlListUnits(output: string): SystemctlUnitStatus[] {
  const out: SystemctlUnitStatus[] = [];
  for (const rawLine of output.split('\n')) {
    const line = rawLine.replace(/^\s*●\s*/, '').trim();
    if (!line) continue;
    const m = /^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s*(.*)$/.exec(line);
    if (!m) continue;
    out.push({ unit: m[1], load: m[2], active: m[3], sub: m[4], description: m[5] ?? '' });
  }
  return out;
}

/** Parse `systemctl --user show <unit> -p Key1,Key2,...` (one `Key=Value` per line). */
export function parseSystemctlShowProperties(output: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

/**
 * Is a supervised unit "down" (needs attention)? `active:'activating'` is a transitional
 * mid-start state — never treated as down (restarting a unit that is already starting just
 * fights systemd). Everything that isn't `active`/`activating`/`reloading`/`deactivating`
 * (i.e. `failed`, `inactive`) counts as down. A unit `systemctl` doesn't report at all
 * (removed / never installed) is also down — surfaced separately as `unit-not-found`.
 */
export function isUnitDown(status: SystemctlUnitStatus | undefined, opts?: { episodic?: boolean }): boolean {
  if (!status) return true;
  return isActiveStateDown(status.active, opts);
}

/**
 * The SAME down-or-not decision, keyed on a bare systemd `ActiveState` string — for the
 * callers that hold one WITHOUT a parsed `list-units` row (`dev:service_health`'s
 * supervision overlay reads `ActiveState` straight from `systemctl show`). Exists so there
 * is exactly ONE definition of "down" in the codebase: the tool that REPORTS liveness and
 * the reconciler that ACTS on it must not be able to disagree, and before this they did —
 * the tool called `activating` down while `isUnitDown` explicitly does not.
 *
 * `undefined` (no ActiveState readable) is an honest UNKNOWN and returns undefined rather
 * than guessing; only `isUnitDown`'s "no row at all" case is a determinate down.
 */
export function isActiveStateDown(activeState: string, opts?: { episodic?: boolean }): boolean;
export function isActiveStateDown(activeState: string | undefined, opts?: { episodic?: boolean }): boolean | undefined;
export function isActiveStateDown(activeState: string | undefined, opts?: { episodic?: boolean }): boolean | undefined {
  if (activeState === undefined) return undefined;
  // WI-6149: an EPISODIC (timer-driven `Type=oneshot`) unit is `inactive` between its
  // scheduled runs BY DESIGN, so the persistent-unit rule below would call a perfectly
  // healthy hourly job "down" for ~96% of every hour. For these, DOWN means the last run
  // FAILED. `activating` is still not-down (a run is in flight); `active` likewise.
  // See `SupervisionEntry.episodic` for why this is a registry property and not a
  // heuristic on the unit name.
  if (opts?.episodic) return activeState === 'failed';
  return !['active', 'activating', 'reloading', 'deactivating'].includes(activeState);
}

/**
 * WI-5378: is this unit's persisted enablement an INTENTIONAL pause? `disabled` (`systemctl
 * --user disable`) and `masked` (`systemctl --user mask`) both mean "a human/agent explicitly
 * told systemd not to run this" — as opposed to `enabled`/`static`/`linked`/`generated`/etc,
 * none of which express pause intent. Unknown/unavailable (`systemctl show` failed this tick)
 * is NOT treated as paused — silently suppressing restarts on a read failure would be worse
 * than the bug this guards against.
 */
export function isAdministrativelyPaused(unitFileState: string | undefined): boolean {
  return unitFileState === 'disabled' || unitFileState === 'masked';
}

// ── Flap-damping decision (pure) ────────────────────────────────────────────

/** Backoff ladder in SECONDS, indexed by consecutive-restart-attempt count (capped). */
export const BACKOFF_SEQUENCE_SEC: readonly number[] = [1, 5, 15, 60];
/** ≥ this many restarts inside GIVE_UP_WINDOW_MS → stop restarting, escalate. */
export const GIVE_UP_THRESHOLD = 6;
export const GIVE_UP_WINDOW_MS = 10 * 60 * 1000;
/**
 * EI-20093844846536045: how many consecutive BUILD-STEP (control-process) give-ups we absorb as
 * "the shared tree is mid-sweep" before treating the break as real and giving up for good.
 *
 * Each absorbed give-up costs one longest-backoff wait plus another GIVE_UP_THRESHOLD restart
 * attempts, so this is minutes of patience — comfortably longer than a git-sync sweep window,
 * comfortably shorter than leaving a genuinely broken checkout looping unowned forever.
 */
export const BUILD_STEP_RETRY_LIMIT = 5;

/** Continuously healthy this long resets the restart counter + give-up latch. */
export const HEALTHY_RESET_MS = 5 * 60 * 1000;

/** Per-unit flap-damping state. In-memory / ephemeral BY DESIGN (P-004's own note: this is
 *  runtime supervision state, not durable state — the Postgres-default storage rule does not
 *  apply; a process restart legitimately resets damping history). Module-singleton map keyed
 *  by unit name, owned by `reconcileTick`'s caller (never constructed fresh per tick). */
export interface UnitFlapState {
  unit: string;
  /** Restart-attempt timestamps (epoch ms), pruned to the trailing GIVE_UP_WINDOW_MS. */
  restarts: number[];
  /** Index into BACKOFF_SEQUENCE_SEC for the NEXT restart attempt. */
  backoffIndex: number;
  lastRestartAt: number | null;
  /** Epoch ms this unit was last freshly OBSERVED healthy (active) — null while down. Used to
   *  compute the 5-minute continuously-healthy reset. */
  healthySince: number | null;
  /** True once give-up has fired (systemd start-limit-hit OR our own ≥6/10m) — no further
   *  restart attempts until the healthy-reset clears it. */
  gaveUp: boolean;
  /**
   * EI-20093844846536045: how many times we have declined to latch a permanent give-up because
   * the failure was a BUILD-STEP (control-process) failure — an external, self-clearing tree
   * break rather than a fault in this unit's own code.
   *
   * Bounds the patience: a tree break clears in minutes, so retrying forever on one would convert
   * a genuinely broken checkout into a silent, unowned infinite loop. Past
   * {@link BUILD_STEP_RETRY_LIMIT} we stop believing "transient" and fall through to the normal
   * permanent give-up (page + file an EI). Reset by the healthy-reset and by an administrative
   * pause, exactly like `restarts`/`gaveUp`.
   */
  buildStepRetries: number;
  /** True while the unit was down as of the PREVIOUS tick — transition-only notify gate
   *  (mirrors service-health.ts's diffHealth pattern) so a persistent down state doesn't
   *  re-notify every 60s tick. */
  wasDown: boolean;
  /** P-003(b) config-drift guard: has the one-time "systemd Restart= is 'no'" warning already
   *  fired for this unit? Reset to false once the drift is observed fixed, so a re-drift warns
   *  again (mirrors `wasDown`'s transition-only notify shape, but tracked independently — a
   *  unit can be UP the whole time yet still have drifted Restart= policy). */
  restartDriftWarned: boolean;
  /** P-004: consecutive DOWN ticks (resets to 0 the moment the unit is observed healthy again).
   *  The systemd-user layer has no sub-tick probe cadence of its own (unlike the D-001 HTTP
   *  probe's "3 consecutive 15s-spaced failures") — each reconciler tick IS one observation, so
   *  this is a tick-count, not a time-based streak. Feeds P-004's `dev:service_health` supervision
   *  block (`consecutiveProbeFailures` in the plan's shape). */
  consecutiveDownTicks: number;
  /** EI-10750 / EI-11344: windowed observations of systemd's OWN restart counter
   *  (`NRestarts`), `{at, n}`, pruned to the trailing SILENT_LOOP_WINDOW_MS. Used to catch a
   *  crash-loop that systemd's own
   *  `Restart=` is absorbing FASTER than the 60s tick can observe "down" — the down-path give-up
   *  counter (`restarts`, built only from restarts WE perform) is blind to it, which is exactly how
   *  43 restarts / 25 min of :3170 (papercup-staging-api) down produced ZERO pages. */
  nRestartsObs: { at: number; n: number }[];
  /** EI-10750: has the CURRENT silent-loop episode already been escalated? Transition-only latch
   *  (mirrors `wasDown`) so a persistent silent loop pages once, not every 60s tick; cleared once
   *  the `NRestarts` delta falls back under threshold (loop subsided / counter reset) so a fresh
   *  re-loop pages again. */
  silentLoopEscalated: boolean;
}

export function initialFlapState(unit: string): UnitFlapState {
  return {
    unit,
    restarts: [],
    backoffIndex: 0,
    lastRestartAt: null,
    healthySince: null,
    gaveUp: false,
    buildStepRetries: 0,
    wasDown: false,
    restartDriftWarned: false,
    consecutiveDownTicks: 0,
    nRestartsObs: [],
    silentLoopEscalated: false,
  };
}

/**
 * P-003(b): a supervised `autoRestart:true` unit whose LIVE systemd `Restart=` policy has
 * drifted to `'no'` (someone/something removed or never applied the damping drop-in) silently
 * stops being restart-managed by systemd itself — our reconciler's OWN restart action still
 * fires, but the belt-and-suspenders systemd-level supervision is gone. PURE: given the current
 * `Restart` property value + whether we already warned, returns whether to warn THIS tick and
 * the next `restartDriftWarned` state (one-time until the drift is observed fixed).
 */
export function checkRestartPolicyDrift(
  entry: SupervisionEntry,
  restartProp: string | undefined,
  alreadyWarned: boolean,
): { warn: boolean; nextWarned: boolean } {
  if (!entry.autoRestart) return { warn: false, nextWarned: alreadyWarned };
  const drifted = restartProp === 'no';
  if (drifted) return { warn: !alreadyWarned, nextWarned: true };
  return { warn: false, nextWarned: false }; // fixed (or unknown) — clear the latch so a future re-drift warns again.
}

/** EI-11344: three systemd restarts inside five minutes is already a crash loop.
 *
 * The original EI-10750 detector reused the down-path give-up policy (6/10m). That
 * is too blunt for a unit systemd keeps briefly active between failures: the live
 * :3070 outage climbed NRestarts 8→12 in four minutes and never reached six within
 * the detector's observation window, so the entire MCP plane went dark without a
 * page. Manual `systemctl restart` does not increment NRestarts; this remains a
 * failure-only signal, not deploy noise. */
export const SILENT_LOOP_THRESHOLD = 3;
export const SILENT_LOOP_WINDOW_MS = 5 * 60 * 1000;

/**
 * EI-10750: PURE detector for a crash-loop that systemd itself is absorbing. Given systemd's live
 * `NRestarts` reading (or undefined when `systemctl show` was unavailable this tick), the windowed
 * observation history, the transition latch, and `now`, returns whether to page THIS tick plus the
 * updated `{ nextObs, nextEscalated }` to persist.
 *
 * `NRestarts` is monotonic WITHIN one episode but resets to 0 on `systemctl reset-failed` / unit
 * reload — a DECREASE is treated as a reset (fresh window + latch cleared). The count is the delta
 * between the current reading and the oldest reading still inside the window, so only restarts that
 * happened DURING our observation window page (a pre-existing high `NRestarts` at first observation
 * — e.g. after an operator restart re-inits the in-memory obs — never false-pages). Below-threshold
 * clears the latch so a subsequent real loop pages again. A missing reading carries state unchanged
 * (an absent probe is not evidence the loop stopped).
 */
export function checkSilentCrashLoop(
  nRestarts: number | undefined,
  obs: readonly { at: number; n: number }[],
  alreadyEscalated: boolean,
  now: number,
): { escalate: boolean; restartsInWindow: number; nextObs: { at: number; n: number }[]; nextEscalated: boolean } {
  if (nRestarts == null || !Number.isFinite(nRestarts)) {
    return { escalate: false, restartsInWindow: 0, nextObs: [...obs], nextEscalated: alreadyEscalated };
  }
  let pruned = obs.filter((o) => now - o.at < SILENT_LOOP_WINDOW_MS);
  let escalatedLatch = alreadyEscalated;
  // A decrease means the counter was reset (`reset-failed` / reload) — start a fresh window and
  // clear the latch so the next real loop re-pages.
  const maxSeen = pruned.reduce((m, o) => Math.max(m, o.n), Number.NEGATIVE_INFINITY);
  if (nRestarts < maxSeen) {
    pruned = [];
    escalatedLatch = false;
  }
  const nextObs = [...pruned, { at: now, n: nRestarts }];
  const oldest = nextObs.reduce((m, o) => Math.min(m, o.n), Number.POSITIVE_INFINITY);
  const restartsInWindow = Number.isFinite(oldest) ? nRestarts - oldest : 0;
  if (restartsInWindow >= SILENT_LOOP_THRESHOLD) {
    return { escalate: !escalatedLatch, restartsInWindow, nextObs, nextEscalated: true };
  }
  return { escalate: false, restartsInWindow, nextObs, nextEscalated: false };
}

export type ReconcileAction =
  | {
      kind: 'healthy';
      unit: string;
      /** EI-20083989508593730: the FIRST time this process has observed this unit, and it was
       *  already healthy — so a give-up EI filed by a PREVIOUS process may still be open with
       *  no 'recovered' transition coming to close it. See `decideReconcile`. */
      firstObservation?: boolean;
    }
  | { kind: 'recovered'; unit: string } // transition down -> healthy, damping reset
  | {
      kind: 'report-only';
      unit: string;
      reason: 'down-report-only' | 'unit-not-found' | 'paused';
      /** WI-35537: only set on `unit-not-found` — true when `LoadState=not-found` positively
       *  confirmed the unit is absent, false/undefined when we simply could not tell. */
      confirmedAbsent?: boolean;
      notify: boolean;
    }
  | { kind: 'waiting-backoff'; unit: string }
  | { kind: 'already-escalated'; unit: string }
  | { kind: 'restart'; unit: string; backoffSec: number }
  | { kind: 'escalate-start-limit-hit'; unit: string }
  | { kind: 'escalate-give-up'; unit: string; restartsInWindow: number };

export interface DecideInput {
  entry: SupervisionEntry;
  status: SystemctlUnitStatus | undefined;
  /** `systemctl --user show <unit> -p Result,NRestarts` — only fetched/needed when we're
   *  actually about to consider restarting (the caller may omit it otherwise). */
  show: { result?: string; unitFileState?: string; loadState?: string } | undefined;
  state: UnitFlapState;
  autoRestartFlagOn: boolean;
  now: number;
}

/** PURE decision for ONE supervised systemd-user unit. Returns the action to take AND the
 *  updated flap state (the caller persists `nextState` back into its state map). */
export function decideReconcile(input: DecideInput): { action: ReconcileAction; nextState: UnitFlapState } {
  const { entry, status, show, autoRestartFlagOn, now } = input;
  const state = { ...input.state };
  const down = isUnitDown(status, { episodic: entry.episodic });

  if (!down) {
    const wasDown = state.wasDown;
    // EI-20083989508593730: `flapStateByUnit` is IN-MEMORY, so a bg-host restart wipes every
    // unit's `wasDown`. The first tick of a fresh process therefore sees an already-healthy unit
    // and emits 'healthy', never 'recovered' — so a give-up EI filed by the PREVIOUS process is
    // never auto-resolved and stays open forever. That is the worst case to lose it in: a
    // give-up EI is filed when a unit is badly broken, and fixing badly-broken things very often
    // IS a bg-host/box restart, so the resolve is dropped exactly when it was earned. Measured
    // 2026-08-10: bg-host restarted 16:50Z, papercup-staging-api was healthy by 16:51Z, and its
    // give-up EI was still open ~25min later. Flag it so the caller can reconcile the orphan.
    const firstObservation = input.state.healthySince == null && !wasDown;
    if (state.healthySince == null) state.healthySince = now;
    state.wasDown = false;
    state.consecutiveDownTicks = 0;
    // 5-minutes-continuously-healthy reset (independent of the transition notify below —
    // a unit that never flapped just never had anything to reset).
    if ((state.gaveUp || state.restarts.length > 0) && now - state.healthySince >= HEALTHY_RESET_MS) {
      state.gaveUp = false;
      state.restarts = [];
      state.backoffIndex = 0;
      // EI-20093844846536045: the unit has been healthy for the full reset window, so whatever
      // tree break drove the build-step retries is over — spend the patience budget fresh next time.
      state.buildStepRetries = 0;
    }
    return {
      action: wasDown
        ? { kind: 'recovered', unit: entry.name }
        : // Emitted ONLY when true, so the steady-state healthy action keeps its exact previous
          // shape and a `firstObservation: false` never has to be asserted anywhere.
          { kind: 'healthy', unit: entry.name, ...(firstObservation ? { firstObservation: true } : {}) },
      nextState: state,
    };
  }

  // Down.
  state.healthySince = null;
  const justWentDown = !state.wasDown;
  state.wasDown = true;
  state.consecutiveDownTicks += 1;

  if (!status) {
    // WI-35537: absence from `list-units` does NOT mean the unit is gone. systemd only lists units
    // it has LOADED into runtime, and `disable --now` on a unit that is then never started drops it
    // out of `list-units --all` entirely — which is precisely the state the documented pause
    // procedure leaves behind (`systemctl --user disable --now papercup-live-federation-gate.timer`,
    // see the SUPERVISED_PROCESSES comment on that entry). `systemctl show` still resolves it on
    // demand, so consult the show-probe before concluding "removed/never installed": otherwise the
    // WI-5378 pause check below is STRUCTURALLY UNREACHABLE for a paused-and-unloaded unit, and the
    // operator is told a unit file is missing when it is sitting on disk, deliberately disabled.
    if (isAdministrativelyPaused(show?.unitFileState)) {
      state.gaveUp = false;
      state.restarts = [];
      state.backoffIndex = 0;
      state.lastRestartAt = null;
      state.buildStepRetries = 0;
      return {
        action: { kind: 'report-only', unit: entry.name, reason: 'paused', notify: justWentDown },
        nextState: state,
      };
    }
    return {
      action: {
        kind: 'report-only',
        unit: entry.name,
        reason: 'unit-not-found',
        // Only `LoadState=not-found` positively CONFIRMS absence. Anything else (including a failed
        // or skipped show-probe) means we could not tell, and the notification must not claim we did.
        confirmedAbsent: show?.loadState === 'not-found',
        notify: justWentDown,
      },
      nextState: state,
    };
  }

  if (!autoRestartFlagOn || !entry.autoRestart) {
    return {
      action: { kind: 'report-only', unit: entry.name, reason: 'down-report-only', notify: justWentDown },
      nextState: state,
    };
  }

  // WI-5378: a deliberately disabled/masked unit is DOWN ON PURPOSE — never fight the pause.
  // Reset any accumulated flap state (a pause is not a crash-loop) so resuming starts fresh.
  if (isAdministrativelyPaused(show?.unitFileState)) {
    state.gaveUp = false;
    state.restarts = [];
    state.backoffIndex = 0;
    state.lastRestartAt = null;
    return {
      action: { kind: 'report-only', unit: entry.name, reason: 'paused', notify: justWentDown },
      nextState: state,
    };
  }

  if (state.gaveUp) {
    return { action: { kind: 'already-escalated', unit: entry.name }, nextState: state };
  }

  if (show?.result === 'start-limit-hit') {
    state.gaveUp = true;
    return { action: { kind: 'escalate-start-limit-hit', unit: entry.name }, nextState: state };
  }

  // Backoff spacing: too soon since the last attempt?
  if (state.lastRestartAt != null) {
    const waitSec = BACKOFF_SEQUENCE_SEC[Math.min(state.backoffIndex, BACKOFF_SEQUENCE_SEC.length - 1)];
    // The backoff for THIS wait is the one recorded at the PRIOR attempt, i.e. backoffIndex-1 —
    // backoffIndex was already advanced past it. Guard the floor at index 0.
    const priorIdx = Math.max(0, state.backoffIndex - 1);
    const priorWaitSec = BACKOFF_SEQUENCE_SEC[Math.min(priorIdx, BACKOFF_SEQUENCE_SEC.length - 1)];
    void waitSec;
    if (now - state.lastRestartAt < priorWaitSec * 1000) {
      return { action: { kind: 'waiting-backoff', unit: entry.name }, nextState: state };
    }
  }

  // Prune the give-up window, then decide restart-vs-give-up on the PRUNED count.
  const pruned = state.restarts.filter((t) => now - t < GIVE_UP_WINDOW_MS);
  if (pruned.length >= GIVE_UP_THRESHOLD) {
    state.gaveUp = true;
    state.restarts = pruned;
    return { action: { kind: 'escalate-give-up', unit: entry.name, restartsInWindow: pruned.length }, nextState: state };
  }

  const backoffSec = BACKOFF_SEQUENCE_SEC[Math.min(state.backoffIndex, BACKOFF_SEQUENCE_SEC.length - 1)];
  state.restarts = [...pruned, now];
  state.backoffIndex = Math.min(state.backoffIndex + 1, BACKOFF_SEQUENCE_SEC.length - 1);
  state.lastRestartAt = now;
  return { action: { kind: 'restart', unit: entry.name, backoffSec }, nextState: state };
}

// ── Orchestrator (impure — injected deps for testing) ───────────────────────

export interface ReconcilerDeps {
  /** `systemctl --user <args>` — returns stdout, or throws on nonzero exit / spawn failure. */
  execUser: (args: string[]) => Promise<string>;
  now: () => number;
  /** Broadcast a coord message. Mirrors service-health.ts's `sendMessage(HEALTH_IDENTITY, …)`. */
  notify: (opts: { summary: string; kind?: 'message' | 'escalation'; category?: string }) => Promise<void>;
  autoRestartFlagOn: () => Promise<boolean>;
  /** The live supervised-process registry read (defaults to `supervisedProcesses` from
   *  service-health.ts — injectable for tests). */
  registry?: () => SupervisionEntry[];
  log?: (msg: string) => void;
  /**
   * EI-19966318801100410: file a durable EI when the reconciler gives up on a crash-looping
   * unit — a give-up broadcast alone (`*`, `expects:'none'`) leaves the down unit unaddressed
   * indefinitely, since every recipient is correctly told to skip it unless it bears on their
   * task. Filing enters it into the claim queue (`work_items:claimable` / `scheduler:get_next`)
   * instead of depending on someone reading a broadcast that named nobody. Optional so every
   * existing `ReconcilerDeps` literal (this file's own tests, any other caller) keeps compiling
   * unchanged; omitted means "don't file". Best-effort: never awaited into failing the give-up
   * broadcast itself — see the call site.
   */
  fileGiveUpEi?: (episode: SupervisionGiveUpEpisode) => Promise<string | null>;
  /** Auto-resolve the durable EI a give-up escalation filed, once the reconciler observes the
   *  unit recovered (`decideReconcile`'s 'recovered' transition). Same optionality/best-effort
   *  rationale as `fileGiveUpEi`. */
  resolveGiveUpEi?: (recovery: RecoveredSupervisionEpisode) => Promise<string[]>;
  /**
   * EI-20003974512096022 fix 1: file a durable EI once a supervised unit has been
   * ADMINISTRATIVELY PAUSED (disabled/masked) longer than `PAUSE_ESCALATION_MS`. Same rationale
   * as `fileGiveUpEi` — a broadcast leaves the dark unit unowned — but for the pause path, which
   * previously only ever broadcast. Same optionality/best-effort contract.
   */
  filePausedEi?: (episode: SupervisionPausedEpisode) => Promise<string | null>;
  /** Auto-resolve the pause EI once the unit is observed no longer paused. */
  resolvePausedEi?: (resumed: ResumedSupervisionEpisode) => Promise<string[]>;
  /** DI seam for the DURABLE pause clock (migration 812). Omitted ⇒ the real
   *  `operator_supervision_pause_state` store; injected by tests so the ramp/threshold logic
   *  runs without PG. */
  pauseStore?: PauseStoreDeps;
}

/** Strip journald's `Aug 10 12:19:03 host bundle-host.sh[1655791]: ` line prefix, so the
 *  patterns below match the tool's own text rather than the transport around it. */
function stripJournalPrefix(line: string): string {
  return line.replace(/^\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\S+\s+[^:\s]+:\s?/, '');
}

/** A compiler/loader error a build step actually printed — the WHY behind a failed
 *  ExecStartPre. esbuild's `✘ [ERROR]`, tsc's `error TSxxxx`, and node's module/syntax
 *  errors are the shapes this repo's start-up steps emit. */
const BUILD_ERROR_RE =
  /(?:✘\s*\[ERROR\]|\berror TS\d+\b|\b(?:Syntax|Reference|Type)Error\b|\bCannot find module\b|\bERR_[A-Z_]+\b)/;

/** A source location line (`../../packages/x/y.ts:533:10:`) — esbuild prints it on the line
 *  AFTER the error text, which is where the actionable file:line lives. */
const SOURCE_LOCATION_RE = /\S+\.(?:[cm]?[jt]sx?|json):\d+:\d+/;

/**
 * EI-19457080109574347: recover the BUILD ERROR a failed start step printed into the journal.
 *
 * `summarizeSystemctlStatusCause` names WHICH step failed (`bundle-host.sh`) — that was WI-9249
 * — but naming the step is not naming the fault, and every responder still had to run journalctl
 * by hand to reach the one line that mattered. Measured on the 2026-08-10 papercup-staging-api
 * outage: the escalation carried `Process: 1694694 ExecStartPre=/home/.../bundle-host.sh`, while
 * the actual cause — `✘ [ERROR] The symbol "startingAdvSessionId" has already been declared` at
 * `routes/adv/launch-su.ts:533:10` — sat in the same journal the reconciler had already read.
 *
 * Scans the WHOLE excerpt rather than its tail on purpose: esbuild prints its error FIRST and
 * then tens of `▲ [WARNING]` lines, so the error is the part a tail window drops (this is why
 * the callers read `--lines=200`, not 50 — one failed bundle emits ~72 journal lines).
 * Returns the error text plus its source location, or null when the excerpt holds no build error.
 */
export function extractBuildErrorDetail(output: string): string | null {
  const lines = output.split('\n').map((line) => stripJournalPrefix(line.trim()));

  const errorIdx = lines.findIndex((line) => BUILD_ERROR_RE.test(line));
  if (errorIdx === -1) return null;

  const errorText = lines[errorIdx]?.replace(/^✘\s*/, '').trim();
  if (!errorText) return null;

  // esbuild puts the file:line on a following line; tsc/node inline it. Look a few lines ahead,
  // stopping at the first location found so a later unrelated frame is never attributed here.
  const location = lines
    .slice(errorIdx + 1, errorIdx + 4)
    .map((line) => line.match(SOURCE_LOCATION_RE)?.[0])
    .find((match): match is string => Boolean(match));

  const detail = location && !errorText.includes(location) ? `${errorText} @ ${location}` : errorText;
  return detail.slice(0, 300);
}

/** Pull one compact failure-cause line out of `systemctl status` output. The
 * current process's ExecMainCode is normally 0 once systemd has respawned it,
 * so the recent journal excerpt embedded by `status --lines` is the only useful
 * source for the failure that incremented NRestarts. */
/**
 * A FAILED control-process line: `Process: <pid> ExecStartPre=/path/x.sh (code=exited, status=1/FAILURE)`.
 *
 * Extracted (EI-20093844846536045) so the CAUSE SUMMARY and the GIVE-UP POLICY below cannot drift
 * apart about what a build-step failure looks like. `status=0` is excluded: a SUCCESSFUL
 * ExecStartPre is also reported on a `Process:` line.
 */
const isFailedControlProcessLine = (line: string): boolean =>
  /^Process:\s+\d+\s+Exec\w+=/.test(line) &&
  /code=(?:exited|killed)/.test(line) &&
  !/status=0(?:\/SUCCESS)?\b/.test(line);

/**
 * EI-20093844846536045: did this failure happen in a CONTROL process (ExecStartPre/Post — i.e. the
 * build/bundle step) rather than in the unit's MAIN process?
 *
 * The distinction decides whether "GIVING UP, this is a code fault not a transient" is TRUE or a
 * LIE, and the two cases want opposite policies:
 *
 *  - MAIN-process death → the unit's own code is broken. Nothing external will fix it; giving up
 *    and paging a human is correct.
 *  - CONTROL-process (build-step) failure → the unit never started at all, because the SHARED TREE
 *    did not compile. git-sync sweeps the whole tree on a timer and deliberately commits
 *    half-written files, so a sweep landing mid-edit yields an invalid bundle. The fault is
 *    EXTERNAL to the unit and SELF-CLEARING — the next good sweep fixes it with nobody touching
 *    anything. Latching a permanent give-up here strands the service long after it would start
 *    again: measured 2026-08-10, :3170 stayed down until 12:51 on a break that cleared much earlier.
 *
 * Takes the `summarizeSystemctlStatusCause` OUTPUT (whose control-process branch puts that line
 * first), so it reads the same evidence the escalation quotes.
 */
export function isBuildStepFailure(cause: string | null | undefined): boolean {
  if (!cause) return false;
  // The cause may carry an appended ` — <build error>`; only the leading line is the verdict.
  return isFailedControlProcessLine(cause.split(' — ')[0].trim());
}

export function summarizeSystemctlStatusCause(output: string): string | null {
  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  // WI-9249: PREFER a failed control-process line (`Process: <pid> ExecStartPre=/path/x.sh
  // (code=exited, status=1/FAILURE)`) over the generic trailer below. When a unit dies in
  // ExecStartPre it never starts at all, and the journal tail is then dominated by
  // "Failed with result 'exit-code'" / "Start request repeated too quickly" \u2014 all TRUE and
  // all diagnostically empty, because none of them names WHICH step failed. Measured on the
  // 2026-08-03 papercup-staging-api outage: the generic pick returned "\u2026Failed with result
  // 'exit-code'.", while this line named `bundle-host.sh` outright. Three agents each ran
  // journalctl by hand to recover exactly that, because the escalation carried the former.
  // status=0 is excluded: a SUCCESSFUL ExecStartPre is also reported on a `Process:` line.
  const controlProcess = lines.find(isFailedControlProcessLine);
  // EI-19457080109574347: the failing STEP is only half the answer \u2014 append the error that step
  // printed, so the escalation carries the fault itself instead of a pointer to where to look.
  const buildError = extractBuildErrorDetail(output);
  if (controlProcess) {
    const step = controlProcess.slice(0, 400);
    return buildError ? `${step} \u2014 ${buildError}` : step;
  }

  const cause = [...lines].reverse().find((line) =>
    /EADDRINUSE|address already in use|fatal|Main process exited|Failed with result|code=(?:exited|killed)|status=\d+/i.test(line),
  );
  if (!cause) return buildError;
  const trailer = cause.replace(/^[-\u251c\u2514\u2502\s]+/, '').slice(0, 400);
  return buildError ? `${trailer} \u2014 ${buildError}` : trailer;
}

/**
 * EI-19966318801100410: recover the child's captured STDOUT from a rejected `execFile`/`exec`
 * promise. Node's `util.promisify` wrapper for `execFile` attaches the captured stdout/stderr
 * onto the rejection error (same as the callback form: `(err, stdout, stderr) => { err.stdout =
 * stdout; ... }`) even when the process exits non-zero — and a non-zero exit is the STEADY
 * STATE for `systemctl --user status <unit>` on a failed/inactive unit (exit code 3), which is
 * exactly the case this reconciler needs diagnostics for. Without this, both cause-capture call
 * sites below (`catch { }`) always hit their catch for a down unit and discard output that was
 * fully captured — this is not occasional, it is the steady state for a unit that is down.
 * Returns null when the error carries no usable stdout (a genuine spawn failure, ENOENT, or a
 * timeout — no diagnostics were ever captured).
 */
export function stdoutFromExecError(err: unknown): string | null {
  if (err && typeof err === 'object' && 'stdout' in err) {
    const stdout = (err as { stdout?: unknown }).stdout;
    if (typeof stdout === 'string' && stdout.trim().length > 0) return stdout;
  }
  return null;
}

/** Module-singleton flap state, keyed by unit name — survives across ticks within one process
 *  (an ephemeral routine's host restart legitimately resets it, per the design note above). */
const flapStateByUnit = new Map<string, UnitFlapState>();

/** Test-only reset. */
export function _resetReconcilerState(): void {
  flapStateByUnit.clear();
  degradedWarned = false;
  // The pause clock's hermetic fallback is process-local and would otherwise LEAK between tests:
  // a second test's paused unit would arrive already carrying `lastNotifiedTier`, so its
  // transition gate would suppress the broadcast the test is asserting on.
  _resetPauseClockForTests();
}
let degradedWarned = false;

export interface ReconcileTickResult {
  checked: number;
  actions: ReconcileAction[];
  degraded: boolean;
}

/**
 * One reconciler tick. Lists live systemd-user units ONCE, decides + (best-effort) acts for
 * every `layer:'systemd-user'` supervised entry. Never throws — a `systemctl --user list-units`
 * failure (bg-host's user bus env unreachable, e.g.) degrades to report-only + a ONE-TIME warn
 * (never a crash-loop, never repeat-spam every 60s).
 */
export async function reconcileTick(deps: ReconcilerDeps): Promise<ReconcileTickResult> {
  const log = deps.log ?? ((m: string) => console.log(`[unit-reconciler] ${m}`));
  const registry = (deps.registry ?? supervisedProcesses)().filter((e) => e.layer === 'systemd-user');
  const now = deps.now();

  let listOutput: string;
  try {
    listOutput = await deps.execUser(['list-units', 'papercup*', '--all', '--no-legend']);
  } catch (err) {
    if (!degradedWarned) {
      degradedWarned = true;
      const msg = err instanceof Error ? err.message : String(err);
      log(`systemctl --user list-units failed — degrading to report-only this tick: ${msg}`);
      await deps
        .notify({
          summary: `⚠ supervision reconciler: \`systemctl --user\` unreachable (${msg}) — degraded to report-only`,
          kind: 'escalation',
        })
        .catch(() => {});
    }
    return { checked: 0, actions: [], degraded: true };
  }
  degradedWarned = false; // recovered — a future failure warns again.

  const statuses = parseSystemctlListUnits(listOutput);
  // SUPERVISED_PROCESSES entries carry the BARE unit name (no `.service` suffix — systemctl
  // accepts either form on the command line and auto-appends the default `.service` type), but
  // `systemctl --user list-units` always reports it WITH the suffix. Normalize by stripping it
  // here so the lookup below matches regardless of which form the registry / systemctl use.
  const byUnit = new Map(statuses.map((s) => [s.unit.replace(/\.service$/, ''), s]));
  const autoRestartFlagOn = await deps.autoRestartFlagOn();

  const actions: ReconcileAction[] = [];
  /** EI-20003974512096022: units observed administratively paused THIS tick, resolved against
   *  the durable pause clock after the loop (see `reconcilePauses`). */
  const pausedThisTick: string[] = [];
  /** Every supervised unit this tick actually reached a verdict on. A unit whose `systemctl show`
   *  probe failed is deliberately NOT in here: we could not tell whether it is still paused, and
   *  treating "unreadable" as "resumed" would clear its clock and auto-resolve its EI on a read
   *  error — the same failure direction `isAdministrativelyPaused` already refuses to take. */
  const observedThisTick: string[] = [];
  for (const entry of registry) {
    if (!entry.unit) continue; // systemd-user layer entries always carry `unit`; defensive skip.
    const status = byUnit.get(entry.unit);
    const state = flapStateByUnit.get(entry.unit) ?? initialFlapState(entry.unit);

    // Fetch `systemctl show` for every autoRestart:true entry — needed for BOTH the
    // start-limit-hit check (down-path only) and the P-003(b) Restart=drift guard (every tick,
    // healthy or not — a unit can be UP the whole time yet have drifted Restart= policy). A
    // report-only entry (autoRestart:false) or a flag-off tick skips the call entirely (neither
    // check applies to it).
    let show:
      | { result?: string; restart?: string; nRestarts?: number; unitFileState?: string; loadState?: string }
      | undefined;
    // WI-35537: ALSO probe when the unit is absent from `list-units` (`!status`), regardless of
    // `autoRestart`. A disabled-and-unloaded unit never appears in the list, so without this the
    // down-path can only ever report "removed/never installed?" for it — `systemctl show` is the
    // only surface that can tell an administrative pause from a genuinely missing unit file.
    if (entry.autoRestart || !status) {
      try {
        const raw = await deps.execUser([
          'show',
          entry.unit,
          '-p',
          'Result,NRestarts,Restart,UnitFileState,LoadState',
        ]);
        const props = parseSystemctlShowProperties(raw);
        const nRestarts = props.NRestarts != null ? Number(props.NRestarts) : undefined;
        show = {
          result: props.Result,
          restart: props.Restart,
          nRestarts: Number.isFinite(nRestarts) ? nRestarts : undefined,
          unitFileState: props.UnitFileState,
          loadState: props.LoadState,
        };
      } catch {
        /* best-effort — decideReconcile treats a missing `show` as "no start-limit-hit signal";
         *  the drift check below just skips this tick when `show` is unavailable. */
      }
    }

    // P-003(b): config-drift guard, independent of up/down state.
    const drift = checkRestartPolicyDrift(entry, show?.restart, state.restartDriftWarned);
    if (drift.warn) {
      await deps
        .notify({
          summary: `⚠ supervision: \`${entry.unit}\` systemd Restart= policy has drifted to 'no' — the unit is no longer systemd-restart-managed (config drift; re-apply the supervision drop-in)`,
          kind: 'escalation',
        })
        .catch(() => {});
    }
    state.restartDriftWarned = drift.nextWarned;

    // EI-10750: silent-crash-loop guard. A supervised unit that reads healthy at every 60s tick
    // while systemd's OWN restart counter (`NRestarts`) climbs fast is crash-looping UNDER
    // systemd's `Restart=` faster than this reconciler can ever observe "down" — so the down-path
    // give-up counter (built ONLY from restarts WE perform) stays empty and never escalates. That
    // is exactly how 43 restarts / 25 min of :3170 (papercup-staging-api) down produced ZERO pages.
    // Detection is INDEPENDENT of FLAGS.supervisorAutoRestart: when systemd (not us) is doing the
    // restarting, paging on the loop must still happen. Only evaluated while the unit currently
    // reads healthy — a unit we can see DOWN is already owned by the decide → restart → give-up path.
    if (entry.autoRestart && !isUnitDown(status, { episodic: entry.episodic })) {
      const loop = checkSilentCrashLoop(show?.nRestarts, state.nRestartsObs, state.silentLoopEscalated, now);
      state.nRestartsObs = loop.nextObs;
      state.silentLoopEscalated = loop.nextEscalated;
      if (loop.escalate) {
        let lastExitCause: string | null = null;
        try {
          lastExitCause = summarizeSystemctlStatusCause(
            await deps.execUser(['status', entry.unit, '--no-pager', '--lines=200']),
          );
        } catch (err) {
          // EI-19966318801100410: `systemctl --user status` on a failed unit ALWAYS exits
          // non-zero, so execUser always rejects here — but the promisified rejection still
          // carries the captured stdout. Recover it before giving up on diagnostics.
          const stdout = stdoutFromExecError(err);
          lastExitCause = stdout ? summarizeSystemctlStatusCause(stdout) : null;
        }
        await deps
          .notify({
            summary:
              `🚨 supervision: \`${entry.unit}\` is SILENTLY crash-looping — systemd restarted it ` +
              `${loop.restartsInWindow}× in <5min under its own \`Restart=\`, faster than the reconciler ` +
              `observes "down". The unit reads \`active\` each tick but is NOT healthy.` +
              (lastExitCause
                ? ` Last exit: ${lastExitCause}`
                : ` Last exit unavailable; inspect \`systemctl --user status ${entry.unit}\` + its journal.`),
            kind: 'escalation',
          })
          .catch(() => {});
      }
    }

    const { action, nextState } = decideReconcile({
      entry,
      status,
      // WI-5378: pass `show` through even once `state.gaveUp` — decideReconcile now checks
      // the pause signal (`unitFileState`) BEFORE the gaveUp short-circuit, so an operator
      // disabling a crash-looped unit to intentionally silence it must still be observed.
      show: autoRestartFlagOn ? show : undefined,
      state: { ...state, restartDriftWarned: drift.nextWarned },
      autoRestartFlagOn,
      now,
    });
    flapStateByUnit.set(entry.unit, nextState);
    actions.push(action);

    // EI-20003974512096022: did we actually LEARN this unit's pause state this tick? Either the
    // `show` probe returned a `UnitFileState` (so disabled/masked is knowable), or the unit is up
    // — an up unit is not dark, whatever its unit-file state says. A failed probe is neither, and
    // must not be mistaken for "resumed".
    if (show?.unitFileState !== undefined || action.kind === 'healthy' || action.kind === 'recovered') {
      observedThisTick.push(entry.unit);
    }

    // WI-9249: the two escalation paths below used to page with a restart COUNT and no cause,
    // so "needs investigation" meant every responder began from zero. The silent-crash-loop
    // page above already attaches `Last exit:` via the same helper — this closes that
    // inconsistency rather than adding a second mechanism. Best-effort by construction: a
    // failure to gather diagnostics must never suppress the page itself.
    // `entry.unit` is narrowed to string by the `if (!entry.unit) continue` guard above, but TS
    // discards that narrowing inside a closure (the capture could be invoked later), so bind it.
    const unitName = entry.unit;
    // EI-20093844846536045: returns the RAW cause alongside the rendered suffix. The suffix is
    // prefixed (` Cause: …`), so `isBuildStepFailure` must see the unwrapped value — testing the
    // suffix would silently never match and the build-step branch would be dead code.
    const failureCause = async (): Promise<{ suffix: string; cause: string | null }> => {
      const fallback = ` Cause unavailable; inspect \`systemctl --user status ${unitName}\` + its journal.`;
      try {
        const cause = summarizeSystemctlStatusCause(
          await deps.execUser(['status', unitName, '--no-pager', '--lines=200']),
        );
        return { suffix: cause ? ` Cause: ${cause}` : fallback, cause };
      } catch (err) {
        // EI-19966318801100410: `systemctl --user status` on a failed/inactive unit ALWAYS
        // exits non-zero (execUser always rejects here), even though it prints full diagnostic
        // stdout — this is the STEADY STATE for exactly the down-unit case these two callers
        // (escalate-start-limit-hit, escalate-give-up) exist for. Recover the stdout the
        // rejection still carries before falling back to "unavailable".
        const stdout = stdoutFromExecError(err);
        const cause = stdout ? summarizeSystemctlStatusCause(stdout) : null;
        return { suffix: cause ? ` Cause: ${cause}` : fallback, cause };
      }
    };

    switch (action.kind) {
      case 'restart':
        log(`restarting ${entry.unit} (backoff was ${action.backoffSec}s)`);
        try {
          await deps.execUser(['restart', entry.unit]);
          await deps
            .notify({ summary: `↻ supervision: restarted \`${entry.unit}\` (was down)`, category: 'supervision' })
            .catch(() => {});
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log(`restart of ${entry.unit} FAILED: ${msg}`);
          await deps
            .notify({ summary: `⚠ supervision: \`systemctl --user restart ${entry.unit}\` failed — ${msg}`, kind: 'escalation' })
            .catch(() => {});
        }
        break;
      case 'escalate-start-limit-hit':
        await deps
          .notify({
            summary:
              `🚨 supervision: \`${entry.unit}\` hit systemd's OWN start-limit — NOT restarting further ` +
              `(needs \`systemctl --user reset-failed ${entry.unit}\` + investigation).` +
              (await failureCause()).suffix,
            kind: 'escalation',
          })
          .catch(() => {});
        break;
      case 'escalate-give-up': {
        const { suffix: causeSuffix, cause } = await failureCause();

        // EI-20093844846536045: a BUILD-STEP (control-process) failure is NOT "a code fault not a
        // transient" — the unit never started because the SHARED TREE did not compile, which
        // git-sync clears on its own within minutes. Latching a permanent give-up here is what
        // kept :3170 down long past the point it would have started fine, because nothing
        // un-parks a unit once systemd refuses it with "Start request repeated too quickly".
        //
        // So: keep retrying, slowly, and say so honestly — but BOUND the patience, or a genuinely
        // broken checkout becomes a silent unowned loop.
        if (isBuildStepFailure(cause) && nextState.buildStepRetries < BUILD_STEP_RETRY_LIMIT) {
          nextState.buildStepRetries += 1;
          // Un-latch so the next tick may try again, and re-arm at the LONGEST backoff so the
          // retry is paced (one attempt per ladder-max wait), never a hot loop.
          nextState.gaveUp = false;
          nextState.restarts = [];
          nextState.backoffIndex = BACKOFF_SEQUENCE_SEC.length - 1;
          nextState.lastRestartAt = now;

          // systemd has very likely parked the unit itself ("Start request repeated too quickly").
          // A later `restart` is REFUSED while that latch is set, so clearing it is what actually
          // makes the retry possible — this is the step that did not exist anywhere before.
          try {
            await deps.execUser(['reset-failed', entry.unit]);
          } catch (err) {
            // Best-effort: the unit may not be in a failed state at all, which is fine.
            log(`reset-failed ${entry.unit} (build-step retry) failed: ${err instanceof Error ? err.message : String(err)}`);
          }

          // Page ONCE per episode (on the first absorbed give-up), not on every retry cycle —
          // a tree break that takes several cycles to clear must not emit a page per cycle.
          if (nextState.buildStepRetries === 1) {
            await deps
              .notify({
                summary:
                  `⚠ supervision: \`${entry.unit}\` failed to start ${action.restartsInWindow}× in <10min — its ` +
                  `BUILD STEP failed, so the shared tree did not compile. This is EXTERNAL to the unit and ` +
                  `usually self-clears on the next good git-sync sweep, so supervision is NOT giving up: it ` +
                  `cleared systemd's failed latch and will keep retrying (up to ${BUILD_STEP_RETRY_LIMIT} ` +
                  `cycles) until the tree builds. No action needed unless it persists.` +
                  causeSuffix,
                kind: 'escalation',
              })
              .catch(() => {});
          }
          break;
        }

        await deps
          .notify({
            summary:
              `🚨 supervision: \`${entry.unit}\` crash-looped (${action.restartsInWindow} restarts in <10min) — ` +
              (nextState.buildStepRetries >= BUILD_STEP_RETRY_LIMIT
                ? `GIVING UP. Its BUILD STEP has now failed across ${nextState.buildStepRetries} retry cycles, so ` +
                  `this is no longer a passing git-sync sweep — the tree is genuinely broken. Needs investigation.`
                : `GIVING UP, this is a code fault not a transient. Needs investigation.`) +
              causeSuffix,
            kind: 'escalation',
          })
          .catch(() => {});
        // EI-19966318801100410: a give-up broadcast alone (`*`, expects:'none') leaves the down
        // unit with no owner — file a durable, claimable work-item so it enters the triage queue
        // instead of depending on someone reading a broadcast addressed to everyone. Best-effort
        // and never awaited into the broadcast above: a filing failure must not read as "the
        // give-up itself failed".
        await deps
          .fileGiveUpEi?.({ unit: entry.unit, restartsInWindow: action.restartsInWindow, causeSuffix })
          .catch(() => {});
        break;
      }
      case 'report-only':
        // EI-20003974512096022: the PAUSED reason no longer notifies from here. Its
        // notify gate used to be `action.notify` (i.e. in-memory `wasDown`), which a bg-host
        // restart resets — that is how ONE 2-day pause emitted 16 identical broadcasts. It is
        // now decided against the DURABLE pause clock in the post-loop pass below, which also
        // ramps salience with duration (fix 2) and files a claimable EI (fix 1).
        if (action.reason === 'paused') {
          pausedThisTick.push(entry.unit);
          break;
        }
        if (action.notify) {
          await deps
            .notify({
              summary:
                action.reason === 'unit-not-found'
                  ? action.confirmedAbsent
                    ? `⚠ supervision: \`${entry.unit}\` not found by systemctl --user (LoadState=not-found — removed/never installed) — report-only`
                    : `⚠ supervision: \`${entry.unit}\` is not loaded by systemctl --user and its state could not be read — report-only (NOT confirmed missing; check \`systemctl --user status ${entry.unit}\`)`
                  : `⚠ supervision: \`${entry.unit}\` is down (report-only: ${entry.autoRestart ? 'FLAGS.supervisorAutoRestart is off' : 'entry.autoRestart:false'})`,
              category: 'supervision',
            })
            .catch(() => {});
        }
        break;
      case 'recovered':
        await deps
          .notify({ summary: `✅ supervision: \`${entry.unit}\` recovered`, category: 'supervision' })
          .catch(() => {});
        // EI-19966318801100410: auto-resolve any give-up EI this unit had open. No-ops when
        // none is open (the normal case — most recoveries never went through a give-up at all).
        await deps.resolveGiveUpEi?.({ unit: entry.unit }).catch(() => {});
        break;
      case 'healthy':
        // EI-20083989508593730: a unit already healthy on this process's FIRST observation of it
        // never produces a 'recovered' transition, so an EI orphaned by the restart would sit
        // open forever. Reconcile it here. SILENT on purpose — no notify: the unit is merely
        // healthy, and announcing "recovered" for every healthy unit on every bg-host restart
        // would be noise. `resolveGiveUpEi` already no-ops when nothing is open, so this costs
        // one indexed lookup per unit per process, once.
        if (action.firstObservation) {
          await deps.resolveGiveUpEi?.({ unit: entry.unit }).catch(() => {});
        }
        break;
      default:
        break;
    }
  }

  await reconcilePauses(deps, pausedThisTick, observedThisTick, now);

  return { checked: registry.length, actions, degraded: false };
}

/**
 * EI-20003974512096022 fixes 1+2 — resolve this tick's paused units against the DURABLE pause
 * clock, then act on the result: ramp the broadcast's salience with the pause's age, and file ONE
 * claimable EI once it outlives `PAUSE_ESCALATION_MS`.
 *
 * ONE atomic read-modify-write per tick covers every unit (the same read-once/write-once shape as
 * `liveness-alarm.ts`), so two overlapping ticks cannot lost-update each other's clocks. All the
 * I/O — broadcasts, EI file/resolve — happens AFTER the transaction commits, never inside the
 * mutator: the mutator runs while the row is held `FOR UPDATE`, so awaiting in there would convert
 * a microsecond lock into a network round-trip held against every concurrent writer.
 *
 * Best-effort throughout: a supervision tick must never be failed by its own bookkeeping.
 */
async function reconcilePauses(
  deps: ReconcilerDeps,
  pausedUnits: string[],
  observedUnits: string[],
  now: number,
): Promise<void> {
  const pausedSet = new Set(pausedUnits);
  const observedSet = new Set(observedUnits);

  const decisions = new Map<string, PauseDecision>();
  let resumed: string[] = [];

  await updatePauseState((current) => {
    const next: PauseState = {};
    decisions.clear();

    // Carry forward every unit we could NOT read this tick — an unreadable probe is not evidence
    // the pause ended, and dropping the record here would silently restart the clock (and so
    // re-arm the whole never-fires-on-a-restarting-box failure this store exists to remove).
    for (const [unit, record] of Object.entries(current ?? {})) {
      if (!pausedSet.has(unit) && !observedSet.has(unit)) next[unit] = record;
    }

    for (const unit of pausedSet) {
      const { next: record, decision } = decidePause(current?.[unit], now);
      next[unit] = record;
      decisions.set(unit, decision);
    }

    // Observed AND no longer paused ⇒ the episode is over: drop the clock (by omission from
    // `next`) and resolve whatever EI it filed.
    resumed = Object.keys(current ?? {}).filter((unit) => observedSet.has(unit) && !pausedSet.has(unit));

    return next;
  }, deps.pauseStore);

  for (const [unit, decision] of decisions) {
    if (decision.notify) {
      const age = formatPauseDuration(decision.durationMs);
      await deps
        .notify({
          summary:
            decision.tier.id === 'observed'
              ? `⏸ supervision: \`${unit}\` is down but administratively disabled/masked — respecting the pause, NOT auto-restarting (\`systemctl --user enable --now ${unit}\` to resume)`
              : `⏸ supervision: \`${unit}\` has now been administratively disabled/masked for ${decision.tier.label} (${age}) — a supervised unit is dark. If this pause is intended, say so on its EI and close it; if nobody can account for it, re-enable it (\`systemctl --user enable --now ${unit}\`).`,
          // Fix 2: past the 4h tier this stops being an ambient supervision FYI and routes to the
          // escalation channel. A tier fires at most once per episode (durably gated), so ramping
          // adds urgency without adding volume — the 16-identical-broadcasts failure was the
          // opposite trade.
          kind: decision.tier.kind,
          ...(decision.tier.kind === 'escalation' ? {} : { category: 'supervision' }),
        })
        .catch(() => {});
    }

    if (decision.shouldEscalate) {
      await deps
        .filePausedEi?.({ unit, pausedForMs: decision.durationMs, pausedSince: decision.pausedSince })
        .catch(() => {});
    }
  }

  for (const unit of resumed) {
    await deps.resolvePausedEi?.({ unit }).catch(() => {});
  }
}

// ── P-004: additive supervision snapshot (for dev:service_health) ──────────

export type SupervisionFlapState = 'ok' | 'damping' | 'gave-up';

export interface SupervisionStatusEntry {
  name: string;
  layer: SupervisionEntry['layer'];
  autoRestart: boolean;
  criticality: SupervisionEntry['criticality'];
  /** Consecutive DOWN ticks as of the last reconciler run (0 = currently healthy or never
   *  reconciled — see `UnitFlapState.consecutiveDownTicks`'s doc for why this is tick-counted
   *  rather than time-windowed). */
  consecutiveProbeFailures: number;
  lastRestartAt: number | null;
  /** Restart attempts within the trailing GIVE_UP_WINDOW_MS (10 minutes) as of `now`. */
  restartsLast10m: number;
  flapState: SupervisionFlapState;
  /**
   * EI-20093902925801178: did this process actually HAVE reconciler flap state
   * for this entry, or are the counters above merely the zero-defaults?
   *
   * `flapStateByUnit` is plain module state, so it is populated only in the
   * process that runs `reconcileTick` — and that is the `supervision-reconcile`
   * ROUTINE, which executes inside `papercup-bg-host`. `dev:service_health`
   * imports this same module in the OPERATOR process, where the Map is
   * permanently empty. Every systemd-user entry therefore took the
   * `state === undefined` branch and serialized as `restartsLast10m: 0,
   * lastRestartAt: null, flapState: 'ok'` — a NO-DATA reading indistinguishable
   * from a measured-healthy one. Measured 2026-08-10: `papercup-staging-api`
   * read exactly that while systemd's own `NRestarts` was 4.
   *
   * `false` means "these counters measured nothing", NOT "this unit is fine" —
   * read it before trusting `flapState`. It is legitimately `false` for a
   * `node-child`/`desktop-shell` entry, which this reconciler never tracks and
   * whose real respawn state is overlaid by its own spawn module.
   */
  flapObserved: boolean;
}

/**
 * P-004: fold the P-002 reconciler's per-unit flap state into the FULL supervised-process
 * registry (every layer, not just systemd-user — a node-child/desktop-shell entry the
 * reconciler doesn't itself track simply reports the registry's static fields + all-zero/`'ok'`
 * counters, which is honest: this snapshot is additive/read-only, never a fabricated verdict).
 * PURE given its inputs — the module-singleton `flapStateByUnit` is read, never mutated, so this
 * is safe to call from a request handler on every `dev:service_health` invocation.
 *
 * Deliberately lives HERE (not folded into `service-health.ts`'s `probeAll` rollup) — flap state
 * is owned by this module, and `service-health.ts` already exports `supervisedProcesses()` which
 * THIS module imports; having `service-health.ts` import back from here would be a circular
 * dependency for zero benefit. `dev:service_health`'s handler composes both directly instead
 * (see `agent-tools/dev/service_health.ts`).
 */
export function supervisionSnapshot(
  now: number = Date.now(),
  registry: SupervisionEntry[] = supervisedProcesses(),
): SupervisionStatusEntry[] {
  return registry.map((entry) => {
    const state = entry.unit ? flapStateByUnit.get(entry.unit) : undefined;
    const restartsLast10m = state ? state.restarts.filter((t) => now - t < GIVE_UP_WINDOW_MS).length : 0;
    // EI-10750: a silent crash-loop (systemd absorbing the restarts) leaves `restarts` empty, so
    // fold the silent-loop latch into the verdict — otherwise the snapshot reads 'ok' during a
    // live loop, the same blindness the paging path just fixed.
    const flapState: SupervisionFlapState =
      state?.gaveUp || state?.silentLoopEscalated ? 'gave-up' : restartsLast10m > 0 ? 'damping' : 'ok';
    return {
      name: entry.name,
      layer: entry.layer,
      autoRestart: entry.autoRestart,
      criticality: entry.criticality,
      consecutiveProbeFailures: state?.consecutiveDownTicks ?? 0,
      lastRestartAt: state?.lastRestartAt ?? null,
      restartsLast10m,
      flapState,
      // EI-20093902925801178: the counters above are zero-defaults whenever
      // `state` is undefined. Say so, rather than letting "no data" wear the
      // same shape as "measured healthy".
      flapObserved: state !== undefined,
    };
  });
}
