/**
 * task-manager/types — the row shape + the PURE naming algebra that joins the
 * three planes this subsystem spans (task-manager-no-escape-2026-07-27, P-002).
 *
 * The whole design rests on one trick: **the kernel object's NAME carries the
 * ledger key**. A task registered as `01k2f7…` is launched into the transient
 * scope `pc-01k2f7….scope`, so reconciling "what the kernel is running" against
 * "what the ledger says" is a string JOIN, not a cmdline heuristic. Everything
 * in this file exists to make that join total and reversible — hence
 * `scopeUnitForTask` / `taskIdFromScopeUnit` are tested as an exact round-trip.
 *
 * PURE by construction: no IO, no PG, no child_process, no clock except what the
 * caller passes. The store, the scanner and the chokepoint all import from here;
 * nothing here imports them.
 */

/** Lifecycle states. Mirrors the CHECK constraint in migration 696 — the two
 *  must be edited together (the store asserts membership before every write). */
export const TASK_STATES = [
  'pending',
  'running',
  'exited',
  'killed',
  'timed_out',
  'stranded',
  'unaccounted',
  'foreign',
] as const;
export type TaskState = (typeof TASK_STATES)[number];

/**
 * States meaning "this process is over". `stranded` counts: the ledger said
 * running, the kernel disagreed, and the reconciler closed the row. It is kept
 * DISTINCT from `exited` because we never observed an exit code — reporting a
 * strand as a clean exit is exactly the kind of manufactured certainty that makes
 * an inherited "job COMPLETED" claim untrustworthy.
 */
export const TERMINAL_TASK_STATES: readonly TaskState[] = [
  'exited',
  'killed',
  'timed_out',
  'stranded',
];

export function isTerminalState(state: TaskState): boolean {
  return TERMINAL_TASK_STATES.includes(state);
}

/** States that assert a live OS process we OWN (and may therefore signal). */
export function isLiveOwnedState(state: TaskState): boolean {
  return state === 'pending' || state === 'running';
}

/**
 * What a task IS. Deliberately an open union (`string & {}`) rather than a closed
 * enum + DB CHECK: new root seams enrol over time and a migration per spawn site
 * would be friction with no safety win. The scheduled-registry's `ManagedCategory`
 * made the same call for the same reason.
 */
export type TaskClass =
  | 'agent-session' // a spawned agent CLI (the biggest subtree by far)
  | 'sidecar' // substrate / gateway / spawner / embed
  | 'bash-job' // capability:bash background job
  | 'test-run' // vitest / playwright / the gate suite
  | 'build' // tsc, vite, cargo
  | 'deploy' // release cut / checkpoint
  | 'service' // an adopted systemd unit
  | 'desktop' // Tauri shell + its children
  | 'pty' // interactive terminal host
  | 'other'
  | (string & {});

/** Who asked for this. `system:<name>` for routine-driven work, `human` for a
 *  hand-launched process the reconciler adopted, otherwise an agent ownerId. */
export type TaskLauncher = string;

/** The provenance block — the reason this subsystem exists. `ps` answers none of it. */
export interface TaskProvenance {
  launchedBy: TaskLauncher;
  workItemId?: string | null;
  planSlug?: string | null;
  fleetSlug?: string | null;
  sessionId?: string | null;
}

/** Resource budget. Every field optional: an unbudgeted task is legal (and is what
 *  everything is today), it just cannot be protected from taking the box down. */
export interface TaskBudget {
  memoryMaxBytes?: number | null;
  cpuWeight?: number | null;
  tasksMax?: number | null;
  /** Wall-clock ceiling. Enforced by systemd's own RuntimeMaxSec — NOT by a timer
   *  of ours, which would die with the operator and leave the task immortal. */
  runtimeMaxSec?: number | null;
}

/** Last metrics sample, read straight out of the scope's cgroup files. */
export interface TaskMetrics {
  lastMemoryBytes?: number | null;
  peakMemoryBytes?: number | null;
  cpuUsec?: number | null;
  pidsCurrent?: number | null;
}

/** One ledger row, as the store returns it. */
export interface TaskRow extends TaskProvenance, TaskBudget, TaskMetrics {
  taskId: string;
  workspaceId: string;
  harnessSlug?: string | null;

  parentTaskId?: string | null;
  rootTaskId: string;

  class: TaskClass;
  title: string;
  argv: string[];
  cwd?: string | null;

  scopeUnit?: string | null;
  cgroupPath?: string | null;
  /** A HINT only. Never signal on it without re-verifying `processIdentity`. */
  pid?: number | null;
  processIdentity?: string | null;
  confined: boolean;

  state: TaskState;
  exitCode?: number | null;
  exitReason?: string | null;
  startedAt: string;
  endedAt?: string | null;
  lastSeenAt: string;
  deadlineAt?: string | null;

  logPath?: string | null;
  detail: Record<string, unknown>;
}

/** What a caller hands `managedSpawn` / `registerTask`. */
export interface TaskSpec extends TaskProvenance, TaskBudget {
  class: TaskClass;
  title: string;
  argv: string[];
  cwd?: string | null;
  parentTaskId?: string | null;
  harnessSlug?: string | null;
  logPath?: string | null;
  detail?: Record<string, unknown>;
}

// ── naming algebra ──────────────────────────────────────────────────────────

/** The transient scope prefix. Short on purpose: it shows up in every
 *  `systemctl --user` listing on the box and in every cgroup path. */
export const TASK_SCOPE_PREFIX = 'pc-';
/** The root slice everything we own lives under. The scanner walks it recursively,
 *  so class sub-slices may nest arbitrarily deep without the scan changing. */
export const TASK_ROOT_SLICE = 'papercusp.slice';

/**
 * Task ids are restricted to `[0-9a-z]` so they are valid inside a systemd unit
 * name with zero escaping, and so `taskIdFromScopeUnit` can be an exact inverse.
 * Sortable-by-time prefix (base36 ms) + random suffix — a ULID in spirit, without
 * pulling a dependency for 8 lines.
 */
export function newTaskId(now: number = Date.now(), rand: () => number = Math.random): string {
  const ts = Math.floor(now).toString(36).padStart(9, '0');
  let suffix = '';
  while (suffix.length < 10) {
    suffix += Math.floor(rand() * 0x100000000)
      .toString(36)
      .replace(/[^0-9a-z]/g, '');
  }
  return `${ts}${suffix.slice(0, 10)}`;
}

export function isValidTaskId(taskId: string): boolean {
  return /^[0-9a-z]{4,64}$/.test(taskId);
}

/** Separates the machine-readable task id from the human-readable label inside a
 *  scope unit name. `--` because a single `-` is legal inside a label. */
export const TASK_SCOPE_LABEL_SEP = '--';

/**
 * `pc-<taskId>.scope`, or `pc-<taskId>--<label>.scope` when a label is supplied.
 *
 * The label exists because `systemctl --user list-units` is how people have always
 * found a running fleet member, and replacing a descriptive unit name with an
 * opaque id would take that away to buy nothing — the id is only meaningful to the
 * reconciler. Carrying both keeps the exact ledger join AND stays greppable, so no
 * existing habit breaks when a seam is enrolled.
 *
 * Throws on an invalid id rather than emitting a unit name systemd will reject at
 * spawn time (a launch-time failure is far harder to read than a call-time one).
 */
export function scopeUnitForTask(taskId: string, label?: string): string {
  if (!isValidTaskId(taskId)) {
    throw new Error(
      `task-manager: invalid taskId ${JSON.stringify(taskId)} — must match /^[0-9a-z]{4,64}$/ to be a legal systemd unit name`,
    );
  }
  const safe = (label ?? '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return safe
    ? `${TASK_SCOPE_PREFIX}${taskId}${TASK_SCOPE_LABEL_SEP}${safe}.scope`
    : `${TASK_SCOPE_PREFIX}${taskId}.scope`;
}

/**
 * The exact inverse — label and all. Returns null for anything that is not ours,
 * which is how the reconciler tells "a scope we launched" from "some other
 * transient scope on this user manager", without a lookup.
 */
export function taskIdFromScopeUnit(unit: string): string | null {
  const trimmed = unit.trim();
  if (!trimmed.startsWith(TASK_SCOPE_PREFIX) || !trimmed.endsWith('.scope')) return null;
  const body = trimmed.slice(TASK_SCOPE_PREFIX.length, -'.scope'.length);
  const sep = body.indexOf(TASK_SCOPE_LABEL_SEP);
  const id = sep >= 0 ? body.slice(0, sep) : body;
  return isValidTaskId(id) ? id : null;
}

/**
 * `papercusp-<class>.slice`. systemd reads `-` as a hierarchy separator, so a
 * class like `agent-session` yields `papercusp.slice/papercusp-agent.slice/
 * papercusp-agent-session.slice` — intermediate slices are auto-created, and the
 * recursive scan picks all of it up regardless. That nesting is a feature: it
 * makes "cap ALL agent work at N GB" a one-line property on a parent slice.
 */
export function sliceForClass(taskClass: TaskClass): string {
  const token = String(taskClass)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return token ? `papercusp-${token}.slice` : TASK_ROOT_SLICE;
}

/** True when `cgroupPath` sits inside anything we own. Used to classify a scanned
 *  process as ours-vs-foreign without needing a ledger row for it. */
export function isOwnedCgroupPath(cgroupPath: string): boolean {
  return cgroupPath.includes('/papercusp.slice/') || cgroupPath.includes(`/${TASK_SCOPE_PREFIX}`);
}
