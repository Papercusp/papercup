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
export function isUnitDown(status: SystemctlUnitStatus | undefined): boolean {
  if (!status) return true;
  return !['active', 'activating', 'reloading', 'deactivating'].includes(status.active);
}

// ── Flap-damping decision (pure) ────────────────────────────────────────────

/** Backoff ladder in SECONDS, indexed by consecutive-restart-attempt count (capped). */
export const BACKOFF_SEQUENCE_SEC: readonly number[] = [1, 5, 15, 60];
/** ≥ this many restarts inside GIVE_UP_WINDOW_MS → stop restarting, escalate. */
export const GIVE_UP_THRESHOLD = 6;
export const GIVE_UP_WINDOW_MS = 10 * 60 * 1000;
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
  /** True while the unit was down as of the PREVIOUS tick — transition-only notify gate
   *  (mirrors service-health.ts's diffHealth pattern) so a persistent down state doesn't
   *  re-notify every 60s tick. */
  wasDown: boolean;
  /** P-003(b) config-drift guard: has the one-time "systemd Restart= is 'no'" warning already
   *  fired for this unit? Reset to false once the drift is observed fixed, so a re-drift warns
   *  again (mirrors `wasDown`'s transition-only notify shape, but tracked independently — a
   *  unit can be UP the whole time yet still have drifted Restart= policy). */
  restartDriftWarned: boolean;
}

export function initialFlapState(unit: string): UnitFlapState {
  return {
    unit,
    restarts: [],
    backoffIndex: 0,
    lastRestartAt: null,
    healthySince: null,
    gaveUp: false,
    wasDown: false,
    restartDriftWarned: false,
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

export type ReconcileAction =
  | { kind: 'healthy'; unit: string }
  | { kind: 'recovered'; unit: string } // transition down -> healthy, damping reset
  | { kind: 'report-only'; unit: string; reason: 'down-report-only' | 'unit-not-found'; notify: boolean }
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
  show: { result?: string } | undefined;
  state: UnitFlapState;
  autoRestartFlagOn: boolean;
  now: number;
}

/** PURE decision for ONE supervised systemd-user unit. Returns the action to take AND the
 *  updated flap state (the caller persists `nextState` back into its state map). */
export function decideReconcile(input: DecideInput): { action: ReconcileAction; nextState: UnitFlapState } {
  const { entry, status, show, autoRestartFlagOn, now } = input;
  const state = { ...input.state };
  const down = isUnitDown(status);

  if (!down) {
    const wasDown = state.wasDown;
    if (state.healthySince == null) state.healthySince = now;
    state.wasDown = false;
    // 5-minutes-continuously-healthy reset (independent of the transition notify below —
    // a unit that never flapped just never had anything to reset).
    if ((state.gaveUp || state.restarts.length > 0) && now - state.healthySince >= HEALTHY_RESET_MS) {
      state.gaveUp = false;
      state.restarts = [];
      state.backoffIndex = 0;
    }
    return { action: { kind: wasDown ? 'recovered' : 'healthy', unit: entry.name }, nextState: state };
  }

  // Down.
  state.healthySince = null;
  const justWentDown = !state.wasDown;
  state.wasDown = true;

  if (!status) {
    return {
      action: { kind: 'report-only', unit: entry.name, reason: 'unit-not-found', notify: justWentDown },
      nextState: state,
    };
  }

  if (!autoRestartFlagOn || !entry.autoRestart) {
    return {
      action: { kind: 'report-only', unit: entry.name, reason: 'down-report-only', notify: justWentDown },
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
}

/** Module-singleton flap state, keyed by unit name — survives across ticks within one process
 *  (an ephemeral routine's host restart legitimately resets it, per the design note above). */
const flapStateByUnit = new Map<string, UnitFlapState>();

/** Test-only reset. */
export function _resetReconcilerState(): void {
  flapStateByUnit.clear();
  degradedWarned = false;
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
  for (const entry of registry) {
    if (!entry.unit) continue; // systemd-user layer entries always carry `unit`; defensive skip.
    const status = byUnit.get(entry.unit);
    const state = flapStateByUnit.get(entry.unit) ?? initialFlapState(entry.unit);

    // Fetch `systemctl show` for every autoRestart:true entry — needed for BOTH the
    // start-limit-hit check (down-path only) and the P-003(b) Restart=drift guard (every tick,
    // healthy or not — a unit can be UP the whole time yet have drifted Restart= policy). A
    // report-only entry (autoRestart:false) or a flag-off tick skips the call entirely (neither
    // check applies to it).
    let show: { result?: string; restart?: string } | undefined;
    if (entry.autoRestart) {
      try {
        const raw = await deps.execUser(['show', entry.unit, '-p', 'Result,NRestarts,Restart']);
        const props = parseSystemctlShowProperties(raw);
        show = { result: props.Result, restart: props.Restart };
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

    const { action, nextState } = decideReconcile({
      entry,
      status,
      show: autoRestartFlagOn && !state.gaveUp ? show : undefined,
      state: { ...state, restartDriftWarned: drift.nextWarned },
      autoRestartFlagOn,
      now,
    });
    flapStateByUnit.set(entry.unit, nextState);
    actions.push(action);

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
            summary: `🚨 supervision: \`${entry.unit}\` hit systemd's OWN start-limit — NOT restarting further (needs \`systemctl --user reset-failed ${entry.unit}\` + investigation)`,
            kind: 'escalation',
          })
          .catch(() => {});
        break;
      case 'escalate-give-up':
        await deps
          .notify({
            summary: `🚨 supervision: \`${entry.unit}\` crash-looped (${action.restartsInWindow} restarts in <10min) — GIVING UP, this is a code fault not a transient. Needs investigation.`,
            kind: 'escalation',
          })
          .catch(() => {});
        break;
      case 'report-only':
        if (action.notify) {
          await deps
            .notify({
              summary:
                action.reason === 'unit-not-found'
                  ? `⚠ supervision: \`${entry.unit}\` not found by systemctl --user (removed/never installed?) — report-only`
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
        break;
      default:
        break;
    }
  }

  return { checked: registry.length, actions, degraded: false };
}
