/**
 * gate-live-invariants.ts — plan green-main-cycle-time-2026-10-08 P-018 (WI-10007479).
 *
 * Standing LIVE invariants for the gate mechanisms earlier plans shipped and marked done, checked
 * on every green-stall-watchdog tick. The 2026-10-08 audit found several of those mechanisms
 * contradicted live (a fixer never dispatched for ~20h, admissions with no surviving pre-check
 * record, a gate tick refused at begin for hours) while every unit test stayed green. A test
 * proves the code once; an invariant proves the RUNNING system every tick.
 *
 * Six invariants, each a pure evaluator over one {@link GateInvariantSnapshot}:
 *   fixer-spawn-latency  a red queue gets a live fixer within one gate tick
 *   targeted-radius      repair rounds run only their targeted radius (no ledger yet ⇒ unknown)
 *   admission-precheck   the newest admission on the lineage ran its pre-check and it passed
 *   no-verdict-rate      gate outcomes that end with no verdict stay a minority
 *   round-idle-time      an admitted head starts its verification run within one tick
 *   executor-freshness   the process running the gate runs the gate code that is committed
 *
 * `unknown` is a first-class status, never folded into pass: an invariant whose evidence cannot be
 * read is not passing, and the plan's 7-day acceptance counts passes only.
 *
 * Persistence: the current state lives in `routines.metadata.gate_invariants` on the
 * green-checkpoint row (overwritten per evaluation); history lives in `pipeline_events` under its
 * own kind `gate_invariants` (migration 1425), appended on any status transition and at least
 * hourly. A transition INTO breach files (or refreshes) one work-item per invariant through
 * `upsertConditionWorkItem`, keyed `gate-invariant:<install>:<name>`.
 */
import type { Sql } from 'postgres';
import { frozenRepairLatency, type FrozenCandidateRepairQueue } from './frozen-candidate-repair-queue';

export const GATE_INVARIANT_NAMES = [
  'fixer-spawn-latency',
  'targeted-radius',
  'admission-precheck',
  'no-verdict-rate',
  'round-idle-time',
  'executor-freshness',
] as const;
export type GateInvariantName = (typeof GATE_INVARIANT_NAMES)[number];
export type GateInvariantStatus = 'pass' | 'breach' | 'unknown';

export interface GateInvariantResult {
  name: GateInvariantName;
  status: GateInvariantStatus;
  /** One sentence a reader can act on: the measured value and the limit it was judged against. */
  observed: string;
}

export const GATE_INVARIANTS_METADATA_KEY = 'gate_invariants';

export interface GateInvariantThresholds {
  /** Slack added to one tick before a wait counts as a breach. */
  graceMs: number;
  /** Tick length when the fire ledger has too few rows to measure one. */
  defaultTickMs: number;
  noVerdictWindowMs: number;
  /** Breach when more than this fraction of outcomes in the window carried no verdict… */
  noVerdictMaxRate: number;
  /** …and at least this many of them did (so two bad ticks in a quiet day do not page). */
  noVerdictMinFailures: number;
  /** How long committed gate code may wait for the executor to load it (a restart window). */
  executorGraceMs: number;
}

export const DEFAULT_GATE_INVARIANT_THRESHOLDS: GateInvariantThresholds = {
  graceMs: 5 * 60_000,
  defaultTickMs: 60 * 60_000,
  noVerdictWindowMs: 24 * 60 * 60_000,
  noVerdictMaxRate: 0.5,
  noVerdictMinFailures: 3,
  executorGraceMs: 30 * 60_000,
};

/** green_checkpoint statuses that ARE a verdict on a candidate. */
export const VERDICT_STATUSES: ReadonlySet<string> = new Set([
  'advanced',
  'not-green',
  'decision-pending',
  'desktop-perf-held',
  'not-fast-forward',
]);

/**
 * Statuses that legitimately carry no verdict: nothing new to judge, or a live attempt / repair
 * already owns the judgement. Any status in neither set — including one added later — counts as a
 * no-verdict FAILURE, so a new failure mode cannot pass silently by being unrecognised.
 */
export const BENIGN_NO_VERDICT_STATUSES: ReadonlySet<string> = new Set([
  'unchanged-since-verdict',
  'up-to-date',
  'skipped-joined-attempt',
  'repair-in-progress',
]);

/** Paths whose code the gate executor runs; a change here is invisible until it restarts. */
export const GATE_CODE_PREFIXES = [
  'packages/operator-core/lib/release/',
  'packages/operator-core/lib/harness/routines/',
] as const;

export interface GateExecutorEvidence {
  /** `detail.vintage.treeSha` of the newest gate fire — the tree the executing process booted on. */
  treeSha: string | null;
  /** Non-test gate-code paths changed between that tree and the current head; null = unresolvable. */
  driftPaths: string[] | null;
  /** Commit time of the oldest commit after the boot tree that touched a gate-code prefix. */
  oldestDriftCommitMs: number | null;
}

export interface GateInvariantSnapshot {
  nowMs: number;
  /** False when the repair-queue row exists but could not be parsed. */
  queueReadable: boolean;
  /** The open frozen repair queue, or null when none is open. */
  queue: FrozenCandidateRepairQueue | null;
  /** Liveness of `queue.fixerSpawnId`; null when there is none or it could not be read. */
  fixerAlive: boolean | null;
  /** Spacing between consecutive recent gate fires, newest first. */
  fireIntervalsMs: number[];
  /** green_checkpoint outcome statuses inside the no-verdict window; null when unreadable. */
  checkpointStatuses: string[] | null;
  /** Null when no gate fire has been recorded. */
  executor: GateExecutorEvidence | null;
}

const minutes = (ms: number): string => `${Math.round(ms / 60_000)}m`;

/** One gate tick, measured from the fire ledger (median spacing), never assumed. */
export function measuredTickMs(snapshot: Pick<GateInvariantSnapshot, 'fireIntervalsMs'>, t: GateInvariantThresholds): number {
  const xs = snapshot.fireIntervalsMs.filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  if (xs.length < 2) return t.defaultTickMs;
  return xs[Math.floor(xs.length / 2)] as number;
}

type Evaluator = (s: GateInvariantSnapshot, t: GateInvariantThresholds) => Omit<GateInvariantResult, 'name'>;

const unreadableQueue = { status: 'unknown' as const, observed: 'the repair-queue row exists but could not be parsed' };
const noQueue = { status: 'pass' as const, observed: 'no frozen repair queue is open' };

export const evaluateFixerSpawnLatency: Evaluator = (s, t) => {
  if (!s.queueReadable) return unreadableQueue;
  const q = s.queue;
  if (!q) return noQueue;
  if (q.phase !== 'awaiting-fixer') return { status: 'pass', observed: `queue phase is ${q.phase}, not awaiting a fixer` };
  const limit = measuredTickMs(s, t) + t.graceMs;
  const lat = frozenRepairLatency(q, s.nowMs);
  if (lat.redAwaitingFixerMs !== null) {
    return {
      status: lat.redAwaitingFixerMs > limit ? 'breach' : 'pass',
      observed: `the newest red has waited ${minutes(lat.redAwaitingFixerMs)} with no fixer dispatched (limit ${minutes(limit)})`,
    };
  }
  if (s.fixerAlive === false) {
    return { status: 'breach', observed: `assigned fixer ${q.fixerSpawnId ?? '(none)'} is dead while the queue still awaits a fixer` };
  }
  if (s.fixerAlive === null && q.fixerSpawnId) {
    return { status: 'unknown', observed: `liveness of assigned fixer ${q.fixerSpawnId} could not be read` };
  }
  const spawnLatency = lat.redToFixerSpawnMs;
  if (spawnLatency !== null && spawnLatency > limit) {
    return { status: 'breach', observed: `the live fixer was dispatched ${minutes(spawnLatency)} after the red it answers (limit ${minutes(limit)})` };
  }
  return { status: 'pass', observed: `a live fixer was dispatched${spawnLatency === null ? '' : ` ${minutes(spawnLatency)} after the red`}` };
};

export const evaluateTargetedRadius: Evaluator = (s) => {
  if (!s.queueReadable) return unreadableQueue;
  if (!s.queue) return { status: 'pass', observed: 'no frozen repair queue is open, so no repair rounds run' };
  return {
    status: 'unknown',
    observed:
      'no per-round executed radius is recorded (green_checkpoint repair rounds carry no executed-leg set), so a round that fell through to the full radius is indistinguishable from a targeted one',
  };
};

export const evaluateAdmissionPrecheck: Evaluator = (s) => {
  if (!s.queueReadable) return unreadableQueue;
  const q = s.queue;
  if (!q) return noQueue;
  const lineage = (q.admissions ?? []).filter((a) => a.atMs >= q.openedAtMs);
  if (lineage.length === 0) return { status: 'pass', observed: 'no admission on the current lineage yet' };
  const latest = lineage.reduce((a, b) => (b.atMs > a.atMs ? b : a));
  const at = new Date(latest.atMs).toISOString();
  const p = latest.precheck;
  if (!p) return { status: 'breach', observed: `the newest admission (${at}, ${latest.paths.length} path(s)) carries no pre-check record` };
  if (!p.ran) {
    if (p.reason === 'nothing-to-run') return { status: 'pass', observed: `the newest admission (${at}) had no tests to pre-check` };
    const why = [p.reason, p.precheckReason].filter(Boolean).join(': ') || 'no reason recorded';
    return { status: 'breach', observed: `the newest admission (${at}) did not run its pre-check (${why})` };
  }
  const failing = p.failing ?? [];
  if (failing.length > 0) {
    return { status: 'breach', observed: `the newest admission (${at}) was admitted with ${failing.length} failing pre-check test(s): ${failing.slice(0, 3).join(', ')}` };
  }
  return { status: 'pass', observed: `the newest admission (${at}) ran its pre-check: ${(p.passing ?? []).length} passing, 0 failing` };
};

export const evaluateNoVerdictRate: Evaluator = (s, t) => {
  const statuses = s.checkpointStatuses;
  if (statuses === null) return { status: 'unknown', observed: 'gate outcome ledger could not be read' };
  if (statuses.length === 0) return { status: 'unknown', observed: `no gate outcome recorded in the last ${minutes(t.noVerdictWindowMs)}` };
  const failures = new Map<string, number>();
  let verdicts = 0;
  for (const st of statuses) {
    if (VERDICT_STATUSES.has(st)) verdicts += 1;
    else if (!BENIGN_NO_VERDICT_STATUSES.has(st)) failures.set(st, (failures.get(st) ?? 0) + 1);
  }
  const failed = [...failures.values()].reduce((a, b) => a + b, 0);
  const rate = failed / statuses.length;
  const top = [...failures.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${k}×${n}`).join(', ');
  const breach = failed >= t.noVerdictMinFailures && rate > t.noVerdictMaxRate;
  return {
    status: breach ? 'breach' : 'pass',
    observed: `${failed}/${statuses.length} gate outcomes in ${minutes(t.noVerdictWindowMs)} ended with no verdict (${verdicts} verdicts)${top ? `; ${top}` : ''} (limit: >${Math.round(t.noVerdictMaxRate * 100)}% and ≥${t.noVerdictMinFailures})`,
  };
};

export const evaluateRoundIdleTime: Evaluator = (s, t) => {
  if (!s.queueReadable) return unreadableQueue;
  const q = s.queue;
  if (!q) return noQueue;
  const limit = measuredTickMs(s, t) + t.graceMs;
  const lat = frozenRepairLatency(q, s.nowMs);
  if (lat.admitAwaitingResumeRunStartMs !== null) {
    return {
      status: lat.admitAwaitingResumeRunStartMs > limit ? 'breach' : 'pass',
      observed: `the newest admission has waited ${minutes(lat.admitAwaitingResumeRunStartMs)} for its verification run to start (limit ${minutes(limit)})`,
    };
  }
  if (q.phase === 'ready-to-test') {
    const idle = Math.max(0, s.nowMs - q.updatedAtMs);
    return {
      status: idle > limit ? 'breach' : 'pass',
      observed: `the queue has sat ready-to-test for ${minutes(idle)} (limit ${minutes(limit)})`,
    };
  }
  return { status: 'pass', observed: `no admitted head is waiting for a run (phase ${q.phase})` };
};

export const evaluateExecutorFreshness: Evaluator = (s, t) => {
  const e = s.executor;
  if (!e) return { status: 'unknown', observed: 'no gate fire is recorded, so the executing build is unknown' };
  if (!e.treeSha) return { status: 'unknown', observed: 'the newest gate fire carries no vintage tree sha' };
  if (e.driftPaths === null) return { status: 'unknown', observed: `gate-code drift from executor tree ${e.treeSha} could not be resolved` };
  if (e.driftPaths.length === 0) return { status: 'pass', observed: `the executor (tree ${e.treeSha}) runs the committed gate code` };
  const age = e.oldestDriftCommitMs === null ? null : Math.max(0, s.nowMs - e.oldestDriftCommitMs);
  const sample = e.driftPaths.slice(0, 3).join(', ');
  if (age === null) return { status: 'unknown', observed: `executor tree ${e.treeSha} lacks ${e.driftPaths.length} gate-code change(s) of unknown age: ${sample}` };
  return {
    status: age > t.executorGraceMs ? 'breach' : 'pass',
    observed: `the executor (tree ${e.treeSha}) lacks ${e.driftPaths.length} gate-code change(s), oldest committed ${minutes(age)} ago (limit ${minutes(t.executorGraceMs)}): ${sample}`,
  };
};

const EVALUATORS: Record<GateInvariantName, Evaluator> = {
  'fixer-spawn-latency': evaluateFixerSpawnLatency,
  'targeted-radius': evaluateTargetedRadius,
  'admission-precheck': evaluateAdmissionPrecheck,
  'no-verdict-rate': evaluateNoVerdictRate,
  'round-idle-time': evaluateRoundIdleTime,
  'executor-freshness': evaluateExecutorFreshness,
};

/** PURE: every invariant against one snapshot. An evaluator that throws reports `unknown`. */
export function evaluateGateLiveInvariants(
  snapshot: GateInvariantSnapshot,
  thresholds: GateInvariantThresholds = DEFAULT_GATE_INVARIANT_THRESHOLDS,
): GateInvariantResult[] {
  return GATE_INVARIANT_NAMES.map((name) => {
    try {
      return { name, ...EVALUATORS[name](snapshot, thresholds) };
    } catch (err) {
      return { name, status: 'unknown' as const, observed: `evaluator threw: ${err instanceof Error ? err.message : String(err)}` };
    }
  });
}

// ─── persisted state ────────────────────────────────────────────────────────────────────────────

export interface GateInvariantEntryState {
  status: GateInvariantStatus;
  observed: string;
  /** When the invariant entered its current status. */
  sinceMs: number;
  lastPassAtMs: number | null;
  evaluations: number;
  passes: number;
  /** Work-item filed for the current breach episode, when one was. */
  filedItemId?: string;
}

export interface GateInvariantsState {
  evaluatedAtMs: number;
  lastEmittedAtMs: number;
  invariants: Partial<Record<GateInvariantName, GateInvariantEntryState>>;
}

export interface GateInvariantTransition {
  name: GateInvariantName;
  from: GateInvariantStatus | null;
  to: GateInvariantStatus;
}

/** Minimum spacing between two hosts' evaluations: every DBOS host ticks the watchdog. */
export const GATE_INVARIANT_LEASE_MS = 5 * 60_000;
/** A pipeline_events row at least this often even when nothing changed — the acceptance ledger. */
export const GATE_INVARIANT_HEARTBEAT_MS = 60 * 60_000;

export function parseGateInvariantsState(raw: unknown): GateInvariantsState | null {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  if (typeof r.evaluatedAtMs !== 'number') return null;
  const invariants: GateInvariantsState['invariants'] = {};
  const src = r.invariants && typeof r.invariants === 'object' ? (r.invariants as Record<string, unknown>) : {};
  for (const name of GATE_INVARIANT_NAMES) {
    const e = src[name] as Record<string, unknown> | undefined;
    if (!e || (e.status !== 'pass' && e.status !== 'breach' && e.status !== 'unknown')) continue;
    invariants[name] = {
      status: e.status,
      observed: typeof e.observed === 'string' ? e.observed : '',
      sinceMs: typeof e.sinceMs === 'number' ? e.sinceMs : r.evaluatedAtMs,
      lastPassAtMs: typeof e.lastPassAtMs === 'number' ? e.lastPassAtMs : null,
      evaluations: typeof e.evaluations === 'number' ? e.evaluations : 0,
      passes: typeof e.passes === 'number' ? e.passes : 0,
      ...(typeof e.filedItemId === 'string' ? { filedItemId: e.filedItemId } : {}),
    };
  }
  return {
    evaluatedAtMs: r.evaluatedAtMs,
    lastEmittedAtMs: typeof r.lastEmittedAtMs === 'number' ? r.lastEmittedAtMs : 0,
    invariants,
  };
}

/** PURE: fold one evaluation into the stored state; report transitions and whether to emit. */
export function foldGateInvariants(
  prev: GateInvariantsState | null,
  results: readonly GateInvariantResult[],
  nowMs: number,
): { next: GateInvariantsState; transitions: GateInvariantTransition[]; emit: boolean } {
  const invariants: GateInvariantsState['invariants'] = {};
  const transitions: GateInvariantTransition[] = [];
  for (const r of results) {
    const before = prev?.invariants[r.name];
    const changed = !before || before.status !== r.status;
    if (changed) transitions.push({ name: r.name, from: before?.status ?? null, to: r.status });
    invariants[r.name] = {
      status: r.status,
      observed: r.observed,
      sinceMs: changed ? nowMs : (before as GateInvariantEntryState).sinceMs,
      lastPassAtMs: r.status === 'pass' ? nowMs : (before?.lastPassAtMs ?? null),
      evaluations: (before?.evaluations ?? 0) + 1,
      passes: (before?.passes ?? 0) + (r.status === 'pass' ? 1 : 0),
      ...(!changed && before?.filedItemId ? { filedItemId: before.filedItemId } : {}),
    };
  }
  const emit = transitions.length > 0 || !prev || nowMs - prev.lastEmittedAtMs >= GATE_INVARIANT_HEARTBEAT_MS;
  return {
    next: { evaluatedAtMs: nowMs, lastEmittedAtMs: emit ? nowMs : (prev?.lastEmittedAtMs ?? 0), invariants },
    transitions,
    emit,
  };
}

export function overallGateInvariantStatus(results: readonly GateInvariantResult[]): GateInvariantStatus {
  if (results.some((r) => r.status === 'breach')) return 'breach';
  if (results.some((r) => r.status === 'unknown')) return 'unknown';
  return 'pass';
}

export function gateInvariantConditionKey(installSlug: string, name: GateInvariantName): string {
  return `gate-invariant:${installSlug}:${name}`;
}

// ─── live wiring ────────────────────────────────────────────────────────────────────────────────

export type GitRead = (args: string[]) => Promise<string>;

/** Resolve the executor's gate-code drift. Every failure degrades to null, never to "no drift". */
export async function resolveGateExecutorDrift(
  treeSha: string | null,
  git: GitRead,
): Promise<Pick<GateExecutorEvidence, 'driftPaths' | 'oldestDriftCommitMs'>> {
  const unresolved = { driftPaths: null, oldestDriftCommitMs: null };
  if (!treeSha || !/^[0-9a-f]{7,64}$/i.test(treeSha)) return unresolved;
  try {
    const boot = String(await git(['rev-parse', '--verify', `${treeSha}^{commit}`])).trim();
    const head = String(await git(['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
    if (!/^[0-9a-f]{40}$/.test(boot) || !/^[0-9a-f]{40}$/.test(head)) return unresolved;
    if (boot === head) return { driftPaths: [], oldestDriftCommitMs: null };
    const diff = String(await git(['diff', '--name-only', '--no-renames', `${boot}..${head}`, '--', ...GATE_CODE_PREFIXES]));
    const driftPaths = diff
      .split('\n')
      .map((l) => l.trim())
      .filter((p) => p.length > 0 && !p.endsWith('.test.ts'));
    if (driftPaths.length === 0) return { driftPaths, oldestDriftCommitMs: null };
    const times = String(await git(['log', '--format=%ct', `${boot}..${head}`, '--', ...driftPaths]))
      .split('\n')
      .map((l) => Number.parseInt(l.trim(), 10))
      .filter((n) => Number.isFinite(n) && n > 0);
    return { driftPaths, oldestDriftCommitMs: times.length > 0 ? Math.min(...times) * 1000 : null };
  } catch {
    return unresolved;
  }
}

export interface GateInvariantReadDeps {
  sql: Sql;
  workspaceId: string;
  installSlug: string;
  nowMs: number;
  thresholds: GateInvariantThresholds;
  readQueue: () => Promise<{ status: 'value'; queue: FrozenCandidateRepairQueue } | { status: 'absent' } | { status: 'unreadable' }>;
  fixerAlive: (spawnId: string) => Promise<boolean | null>;
  git: GitRead;
}

export async function readGateInvariantSnapshot(deps: GateInvariantReadDeps): Promise<GateInvariantSnapshot> {
  const { sql, workspaceId, installSlug, nowMs } = deps;
  const read = await deps.readQueue().catch(() => ({ status: 'unreadable' as const }));
  const queue = read.status === 'value' ? read.queue : null;
  const fixerAlive = queue?.fixerSpawnId ? await deps.fixerAlive(queue.fixerSpawnId).catch(() => null) : null;

  const fires = await sql<{ at: Date | string; tree: string | null }[]>`
    SELECT created_at AS at, detail->'vintage'->>'treeSha' AS tree
      FROM harness_shared.pipeline_events
     WHERE workspace_id = ${workspaceId} AND install_slug = ${installSlug} AND kind = 'green_checkpoint_fire'
     ORDER BY created_at DESC
     LIMIT 13`.catch(() => null);
  const fireMs = (fires ?? []).map((f) => new Date(f.at).getTime());
  const fireIntervalsMs = fireMs.slice(1).map((t, i) => (fireMs[i] as number) - t);

  const since = new Date(nowMs - deps.thresholds.noVerdictWindowMs);
  const outcomes = await sql<{ status: string }[]>`
    SELECT status FROM harness_shared.pipeline_events
     WHERE workspace_id = ${workspaceId} AND install_slug = ${installSlug} AND kind = 'green_checkpoint'
       AND created_at > ${since}`.catch(() => null);

  let executor: GateExecutorEvidence | null = null;
  if (fires && fires.length > 0) {
    const treeSha = fires[0]?.tree ?? null;
    executor = { treeSha, ...(await resolveGateExecutorDrift(treeSha, deps.git)) };
  } else if (fires === null) {
    executor = { treeSha: null, driftPaths: null, oldestDriftCommitMs: null };
  }

  return {
    nowMs,
    queueReadable: read.status !== 'unreadable',
    queue,
    fixerAlive,
    fireIntervalsMs,
    checkpointStatuses: outcomes ? outcomes.map((o) => o.status) : null,
    executor,
  };
}

export interface RecordGateInvariantsResult {
  recorded: boolean;
  transitions: GateInvariantTransition[];
  emitted: boolean;
  filed: { name: GateInvariantName; id: string }[];
}

export interface RecordGateInvariantsDeps {
  sql: Sql;
  workspaceId: string;
  installSlug: string;
  nowMs: number;
  results: readonly GateInvariantResult[];
  appendEvent: (status: GateInvariantStatus, detail: Record<string, unknown>) => Promise<void>;
  fileBreach: (result: GateInvariantResult) => Promise<string | null>;
}

/**
 * Persist one evaluation. The state read, lease check and write share one transaction with the
 * routine row locked, so two hosts ticking together produce one evaluation, not two.
 */
export async function recordGateLiveInvariants(deps: RecordGateInvariantsDeps): Promise<RecordGateInvariantsResult> {
  const { sql, workspaceId, installSlug, nowMs, results } = deps;
  const folded = await sql.begin(async (tx) => {
    const rows = await tx<{ state: unknown }[]>`
      SELECT metadata->${GATE_INVARIANTS_METADATA_KEY} AS state
        FROM harness_shared.routines
       WHERE workspace_id = ${workspaceId} AND install_slug = ${installSlug} AND name = 'green-checkpoint'
       FOR UPDATE`;
    if (rows.length === 0) return null;
    const prev = parseGateInvariantsState(rows[0]?.state);
    if (prev && nowMs - prev.evaluatedAtMs < GATE_INVARIANT_LEASE_MS) return null;
    const out = foldGateInvariants(prev, results, nowMs);
    await tx`
      UPDATE harness_shared.routines
         SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), ${[GATE_INVARIANTS_METADATA_KEY]}, ${tx.json(out.next as never)})
       WHERE workspace_id = ${workspaceId} AND install_slug = ${installSlug} AND name = 'green-checkpoint'`;
    return out;
  });
  if (!folded) return { recorded: false, transitions: [], emitted: false, filed: [] };

  const filed: { name: GateInvariantName; id: string }[] = [];
  for (const t of folded.transitions) {
    if (t.to !== 'breach') continue;
    const result = results.find((r) => r.name === t.name);
    if (!result) continue;
    const id = await deps.fileBreach(result).catch(() => null);
    if (id) filed.push({ name: t.name, id });
  }
  if (filed.length > 0) {
    // Record the filed ids on the stored state (best effort; the condition key already dedups).
    for (const f of filed) {
      const entry = folded.next.invariants[f.name];
      if (entry) entry.filedItemId = f.id;
    }
    await sql`
      UPDATE harness_shared.routines
         SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), ${[GATE_INVARIANTS_METADATA_KEY]}, ${sql.json(folded.next as never)})
       WHERE workspace_id = ${workspaceId} AND install_slug = ${installSlug} AND name = 'green-checkpoint'
         AND (metadata->${GATE_INVARIANTS_METADATA_KEY}->>'evaluatedAtMs')::bigint = ${nowMs}`.catch(() => undefined);
  }
  if (folded.emit) {
    await deps
      .appendEvent(overallGateInvariantStatus(results), {
        results: results.map((r) => ({ name: r.name, status: r.status, observed: r.observed })),
        transitions: folded.transitions,
        ...(filed.length > 0 ? { filed } : {}),
      })
      .catch(() => undefined);
  }
  return { recorded: true, transitions: folded.transitions, emitted: folded.emit, filed };
}

const WATCHDOG_ACTOR = 'system-watchdog';

/** The production pass, wired into `startGreenStallWatchdog` beside `checkIdleRepairQueue`. */
export async function checkGateLiveInvariants(
  sql: Sql,
  opts: { installSlug?: string; nowMs?: () => number; thresholds?: GateInvariantThresholds } = {},
): Promise<RecordGateInvariantsResult | null> {
  const installSlug = opts.installSlug ?? 'papercusp';
  const thresholds = opts.thresholds ?? DEFAULT_GATE_INVARIANT_THRESHOLDS;
  const { recordWatchdogPassOutcome } = await import('./watchdog-health');
  let passError: unknown;
  try {
    const rows = await sql<{ workspace_id: string }[]>`
      SELECT workspace_id FROM harness_shared.routines
       WHERE install_slug = ${installSlug} AND name = 'green-checkpoint'
       LIMIT 1`;
    if (rows.length === 0) return null;
    const workspaceId = rows[0]?.workspace_id as string;
    const nowMs = (opts.nowMs ?? Date.now)();

    const { readFrozenCandidateRepairQueueState } = await import('../harness/routines/release-actions');
    const { releaseFixerSpawnAlive } = await import('./fixer-liveness');
    const { gitReadViaSidecar } = await import('../dbos/process-boot-identity');
    const { appendPipelineEvent } = await import('../harness/git-sync/pipeline-events');
    const { upsertConditionWorkItem } = await import('../coord/condition-upsert');

    const snapshot = await readGateInvariantSnapshot({
      sql,
      workspaceId,
      installSlug,
      nowMs,
      thresholds,
      readQueue: () => readFrozenCandidateRepairQueueState({ workspaceId, installSlug }),
      fixerAlive: (spawnId) => releaseFixerSpawnAlive(sql as never, spawnId),
      git: gitReadViaSidecar,
    });
    const results = evaluateGateLiveInvariants(snapshot, thresholds);
    return await recordGateLiveInvariants({
      sql,
      workspaceId,
      installSlug,
      nowMs,
      results,
      appendEvent: (status, detail) =>
        appendPipelineEvent({ workspaceId, installSlug, kind: 'gate_invariants', status, detail }, sql),
      fileBreach: async (r) => {
        const res = await upsertConditionWorkItem(gateInvariantConditionKey(installSlug, r.name), {
          kind: 'bug',
          title: `Gate live invariant breached on ${installSlug}: ${r.name}`,
          summary:
            `${r.observed}\n\nFiled by the standing gate invariant check (plan green-main-cycle-time-2026-10-08 P-018, ` +
            `packages/operator-core/lib/release/gate-live-invariants.ts). Current state of every invariant: ` +
            `routines(name='green-checkpoint').metadata.${GATE_INVARIANTS_METADATA_KEY}; history: pipeline_events kind='gate_invariants'.`,
          severity: 'major',
          harness: installSlug,
          workspaceId,
          createdBy: WATCHDOG_ACTOR,
          payload: { source: 'gate-live-invariants', invariant: r.name, observed: r.observed },
        });
        return res.id ?? null;
      },
    });
  } catch (err) {
    passError = err;
    return null;
  } finally {
    await recordWatchdogPassOutcome(sql, 'gate-live-invariants', { routineName: 'green-checkpoint', installSlug }, passError);
  }
}
