/**
 * UI-triggered bench run launcher + spend-safety teardown
 * (benchmark-evaluation-ui-2026-06-16 P-004 / P-005, D-002).
 *
 * Launches a REAL bench-engine run from inside the operator host (NOT a /tmp CLI
 * launcher): persist a bench_runs row (status=running) + return a run_id
 * immediately, drive runHiveBacklog as a DETACHED promise, stream per-task +
 * coordination rows into the operational store as bees collect, and finalize on
 * completion.
 *
 * SPEND-SAFETY (closes impartial-benchmark-suite D-022 — the orphan-respin gap):
 *   1. Every spawned hive's slug is persisted on the bench_runs row
 *      (setBenchRunHive) the instant it is minted.
 *   2. The detached run ALWAYS tears down in a finally — dissolveBenchHive (which
 *      stops the Queen wake, cancels every bee subtree, and DELETES the
 *      gym_autoloop_config + scout routine + learning-governor registrants via
 *      teardownHiveLearningLoop) — so a completed/errored/cancelled run leaves no
 *      armed learning loop to re-spin opus.
 *   3. A boot-time reaper (reapStaleBenchRuns, wired into host boot) finds any run
 *      left status=running/grading/pending by a CRASHED host (SIGKILL bypasses the
 *      finally), dissolves its hive, and freezes its status — so a :3170 restart
 *      can NEVER re-arm an orphan hive. This is the durable closure; the finally
 *      is the fast path.
 *
 * The in-process `activeRuns` map holds only EPHEMERAL runtime handles (the cancel
 * flag + the live hive slugs for a run executing in THIS process). The durable
 * truth is bench_runs.status in PG — the reaper rebuilds safety from it on boot.
 * (Not a "module-scoped state Map" in the storage-policy sense: a live promise +
 * cancel flag cannot be serialized; PG is the source of truth.)
 */
import type { BenchTask } from './types';
import type { FleetTaskResult, HiveBacklogResult, HiveBacklogRunRequest } from './hive-backlog';
import { runHiveBacklog } from './hive-backlog';
import { bindRealQueenBacklogDriver, dissolveBenchHive } from './hive-backlog-realqueen';
import { bindSuIndependentBacklogDriver, SU_INDEPENDENT_ARM } from './su-independent-backlog';
import { assertExternalBenchEnabled } from './gate';
import { resolveDb, type DbScope } from './reproducibility/db';
import {
  upsertBenchRun,
  setBenchRunHive,
  upsertBenchRunTask,
  taskRowFromFleetResult,
  setBenchRunEvents,
  setBenchRunStatus,
  recordRunCompletion,
  type BenchRunStatus,
} from './run-store';
import { loadBenchTaskSet } from './task-sets';
import { createHash, randomBytes } from 'node:crypto';
import type { PapercuspUnifiedToolContext } from '../agent-tools/_tool-context';
import { currentBenchmarkProtocolSchema, type CurrentBenchmarkProtocol } from './reproducibility/schema';
import { canonicalJson } from './reproducibility/canonical-json';
import { getPrereg } from './reproducibility/store';
import { requireCommittedPreregistration } from './reproducibility/prereg';
import { resolveBenchWorkspace } from './bench-workspace';
import { runArmGeneration } from './arm-generation';
import { cloneTaskRepo, extractDiff } from './clone';
import { FULL_SPINE_BLUEPRINT, type BenchHarnessDriver } from './run-loop';
import { createCurrentSuBenchHarness, currentBenchAssignmentId, currentBenchGatewayController,
  currentBenchProviderAuthenticator, currentBenchObservationReader, recoverCurrentBenchRun,
  type CurrentSuBenchOptions, type CurrentBenchObservationReaderOptions } from './current-su';
import { registerLearningLoop, type LearningReservationResourceBudget } from '../learning-governor/store';

/** A run actively executing in THIS host process (ephemeral; PG is durable truth). */
interface ActiveRun {
  runId: string;
  workspaceId: string;
  arm: string;
  taskSetId: string;
  taskIds?: string[];
  startedAtMs: number;
  potSlugs: Set<string>;
  cancelled: boolean;
  abort?: AbortController;
  stopCurrent?: () => Promise<void>;
  protocolRunId?: string;
}
const activeRuns = new Map<string, ActiveRun>();

export interface LaunchBenchRunInput {
  /** Single arm per run (a multi-arm compare launches one run per arm). */
  arm: string;
  /** '11-task-pilot' | 'swe-bench-pro-full' | 'custom'. */
  taskSetId: string;
  /** When taskSetId='custom', the explicit instance ids. */
  taskIds?: string[];
  suite?: string;
  /** opus — fail-closed (never silently downgraded). */
  model?: string;
  /** Fleet concurrency cap (maxSimultaneousAgents). */
  cap?: number;
  /** Per-task spend cap (USD). */
  maxUsdPerTask?: number;
  /** Per-task token cap. */
  maxTokensPerTask?: number;
  /** Per-run spend ceiling (USD) — advisory, recorded in config. */
  maxUsdPerRun?: number;
  /** Current execution is selected by a committed protocol, never a legacy arm fallback. */
  current?: {
    workspaceId: string;
    protocolRunId: string;
    preregHash: string;
    seed: number;
    observation: Pick<CurrentBenchObservationReaderOptions, 'runtimeWorkspaceId' | 'workerUnit' | 'gatewayUnit'>;
  };
}

/**
 * The persister-hook surface BOTH backlog driver binds (real-Queen + su-independent) accept — the
 * normalized seam `launchBenchRun` wires its bench_runs persistence through. Each bind reads only the
 * common fields it needs; `onHiveCreated` is meaningful for the hive arms and a harmless no-op for the
 * hive-less su-independent arm (it never fires). The enrolled/task shapes are narrowed to the fields the
 * launcher reads (`enrolled.task.instanceId`, the FleetTaskResult), so both concrete binds — which take
 * their own richer enrolled type — are assignable here (callback param contravariance).
 */
export type BenchDriverBinder = (opts: {
  workspaceId: string;
  onHiveCreated?: (hiveHome: string) => void | Promise<void>;
  onEnrolled?: (enrolled: { task: BenchTask }) => void | Promise<void>;
  onTaskCollected?: (result: FleetTaskResult) => void | Promise<void>;
}) => void;

/** Test/host injection seam — defaults wire the real engine. */
export interface LaunchDeps {
  scope?: DbScope;
  /** Run the backlog (default runHiveBacklog). */
  run?: (req: HiveBacklogRunRequest) => Promise<HiveBacklogResult>;
  /** Bind the backlog driver with the persister hooks (per-arm default: real-Queen / su-independent). */
  bindDriver?: BenchDriverBinder;
  /** Dissolve a spawned hive (default dissolveBenchHive). */
  dissolve?: (potSlug: string, workspaceId: string) => Promise<void>;
  /** Load the task set → BenchTask[] (default loadBenchTaskSet). */
  loadBacklog?: (taskSetId: string, taskIds?: string[]) => Promise<BenchTask[]>;
  /** Gate check (default assertExternalBenchEnabled). */
  assertEnabled?: () => Promise<void>;
  /** Deterministic run id (tests). Default embeds a timestamp. */
  runId?: string;
  /** Authenticated host context. The HTTP route supplies this; JSON cannot supply authority. */
  currentContext?: PapercuspUnifiedToolContext;
  currentRepoRoot?: string;
  /** Assignment-local runtime seam; production starts the maintained native gateway/driver. */
  currentTask?: (input: CurrentTaskInput) => Promise<{ driver: BenchHarnessDriver; stop(): Promise<void> }>;
  currentGeneration?: Pick<import('./types').GenerationPorts, 'clone' | 'extractDiff'>;
}

export interface CurrentTaskInput {
  options: CurrentSuBenchOptions;
  protocol: CurrentBenchmarkProtocol;
  task: BenchTask;
  context: PapercuspUnifiedToolContext;
  scope: DbScope;
  resources: LearningReservationResourceBudget;
  loopId: string;
  observation: NonNullable<LaunchBenchRunInput['current']>['observation'];
}

/** Resolve the frozen controls once, before any durable run or native launch. */
export function currentBenchLaunchSelection(input: LaunchBenchRunInput, config: unknown) {
  if (!input.current) throw new Error('Current benchmark launch requires its protocol selection.');
  const current = input.current;
  resolveBenchWorkspace(current.workspaceId);
  if (!current.workspaceId.trim() || !/^[a-f0-9]{64}$/.test(current.preregHash)) throw new Error('Invalid current benchmark workspace/hash.');
  const protocol = currentBenchmarkProtocolSchema.parse(config);
  const arm = protocol.arms.find(value => value.id === input.arm);
  if (protocol.runId !== current.protocolRunId || !protocol.seeds.includes(current.seed) || !arm) {
    throw new Error('Current benchmark launch is not in the frozen protocol.');
  }
  // The stock-native adapter is a separate execution route. It must never fall
  // through to a Queen or become a second su treatment under a baseline label.
  if (arm.id !== 'papercusp' || arm.agent !== 'codex') throw new Error('Unsupported current benchmark execution arm/client.');
  if (input.taskSetId !== 'custom' || input.taskIds && canonicalJson(input.taskIds) !== canonicalJson(protocol.taskIds) ||
      input.model !== undefined && input.model !== arm.model || input.cap !== undefined && input.cap !== 1 ||
      input.maxUsdPerTask !== undefined && input.maxUsdPerTask !== arm.generationBudget.maxUsd ||
      input.maxTokensPerTask !== undefined && input.maxTokensPerTask !== arm.generationBudget.maxTokens ||
      input.maxUsdPerRun !== undefined && input.maxUsdPerRun !== protocol.aggregateBudgetUsd) {
    throw new Error('Current benchmark launch controls drift from its frozen protocol.');
  }
  const id = createHash('sha256').update(canonicalJson({ workspaceId: current.workspaceId,
    protocolRunId: protocol.runId, preregHash: current.preregHash, arm: arm.id, seed: current.seed })).digest('hex');
  return { protocol, arm, runId: `current-${id}` };
}

function currentBenchResources(protocol: CurrentBenchmarkProtocol): LearningReservationResourceBudget {
  const budget = protocol.arms[0].generationBudget;
  const ceiling = Math.max(...protocol.priceSchedule.rates.map(rate => rate.inputTokenCeiling ?? 0));
  if (!Number.isSafeInteger(ceiling) || ceiling <= 0) throw new Error('Current native launch requires frozen provider input ceilings.');
  const requestsPerArm = 64;
  const output = Math.min(budget.maxTokens ?? 4096, 4096);
  const armIds = protocol.arms.flatMap(arm => protocol.taskIds.flatMap(taskId =>
    protocol.seeds.map(seed => currentBenchAssignmentId(protocol.runId, arm.id, taskId, seed)))).sort();
  const resources = { inputTokens: ceiling * requestsPerArm, outputTokens: output * requestsPerArm,
    requestsPerArm, totalTokensPerArm: budget.maxTokens, armIds, usdPerArm: budget.maxUsd,
    maxOpenUsd: protocol.maxInFlightUsd, wallClockMsPerArm: budget.maxWallClockMs,
    wallClockMs: budget.maxWallClockMs * armIds.length };
  if (!Number.isSafeInteger(resources.inputTokens) || !Number.isSafeInteger(resources.wallClockMs)) throw new Error('Invalid current benchmark resource bounds.');
  return resources;
}

async function liveCurrentTask(input: CurrentTaskInput) {
  const { options, protocol, task, context, scope, resources, loopId } = input;
  const auth = currentBenchProviderAuthenticator({ workspaceId: options.workspaceId, preregHash: options.preregistration.preregHash,
    protocol, armId: options.armId, taskId: task.instanceId, seed: options.seed });
  const controller = currentBenchGatewayController({ workspaceId: options.workspaceId, loopId, token: randomBytes(32).toString('hex'),
    preregHash: options.preregistration.preregHash, protocol, armId: options.armId, taskId: task.instanceId, seed: options.seed,
    resources, outputTokenLimit: Math.min(4096, protocol.arms.find(arm => arm.id === options.armId)!.generationBudget.maxTokens ?? 4096),
    authenticateProvider: auth.authenticateProvider }, { enabled: async () => true, getSql: async () => resolveDb(scope).sql });
  let host: Awaited<ReturnType<typeof controller.startNativeGateway>> | undefined;
  const stop = async () => { auth.revoke(); controller.revoke(); await host?.stop(); };
  try {
    host = await controller.startNativeGateway(context.log);
    const observeIdentity = currentBenchObservationReader({ ...scope, ...input.observation,
      workspaceId: options.workspaceId, gatewayBaseUrl: host.nativeGateway.baseURL }, undefined, host);
    const driver = createCurrentSuBenchHarness(options, context, { ...host, observeIdentity,
      admit: async () => ({ admitted: !options.signal?.aborted, receiptRef: `governor:${options.workspaceId}/${loopId}#${options.preregistration.preregHash}` }) });
    return { driver, stop };
  } catch (error) { await stop(); throw error; }
}

/** Restart/cancel recovery uses durable native task labels, independently of a vanished gateway. */
async function retireCurrentRun(workspaceId: string, runId: string): Promise<void> {
  const [{ listTasks }, { killTask }] = await Promise.all([import('../task-manager/store'), import('../task-manager/control')]);
  await recoverCurrentBenchRun({ listTasks, killTask: id => killTask(id, {
    includeSubtree: true, reapTerminalResidue: true, escalateAfterMs: 5000 }) }, { workspaceId, runId });
}

async function launchCurrentBenchRun(input: LaunchBenchRunInput, deps: LaunchDeps): Promise<{ runId: string; done: Promise<void> }> {
  const current = input.current!, context = deps.currentContext;
  const scope = { ...deps.scope, workspaceId: resolveBenchWorkspace(current.workspaceId) };
  const { sql, ws } = resolveDb(scope);
  if (!context?.principal?.slug || context.workspaceId !== ws) throw new Error('Current benchmark launch requires authenticated isolated host authority.');
  const prereg = await getPrereg({ runId: current.protocolRunId, preregHash: current.preregHash }, scope);
  if (!prereg) throw new Error('Current benchmark pre-registration was not found.');
  const { protocol, arm, runId } = currentBenchLaunchSelection(input, prereg.config);
  if (!['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(arm.effort)) throw new Error('Unsupported frozen native effort.');
  const registration = { preregHash: prereg.preregHash, config: protocol, repoRoot: deps.currentRepoRoot };
  await requireCommittedPreregistration(protocol.runId, registration, { ...scope, repoRoot: deps.currentRepoRoot });
  const loaded = await (deps.loadBacklog ?? loadBenchTaskSet)('custom', protocol.taskIds);
  if (canonicalJson(loaded.map(task => task.instanceId).sort()) !== canonicalJson([...protocol.taskIds].sort()) ||
      loaded.some(task => task.benchmark !== (input.suite ?? 'swe-bench-pro'))) throw new Error('Current benchmark task loader differs from the frozen roster/suite.');
  const backlog = protocol.taskIds.map(id => loaded.find(task => task.instanceId === id)!);
  const resources = currentBenchResources(protocol), loopId = `benchmark:${prereg.preregHash}`;
  const meta = { reservationBinding: prereg.preregHash, reservationResourceBudget: resources };
  const loop = await registerLearningLoop(sql, { workspaceId: ws, loopId, ifMissing: true, budgetKind: 'lifetime',
    budgetUsd: protocol.aggregateBudgetUsd, enabled: true, enforcement: 'governor', meta });
  if (!loop.enabled || loop.budgetKind !== 'lifetime' || loop.budgetUsd !== protocol.aggregateBudgetUsd ||
      canonicalJson(loop.meta) !== canonicalJson(meta)) throw new Error('Current benchmark governor registration differs from the frozen policy.');
  await sql.begin(async tx => {
    // Store helpers only use the tagged-query surface. Keep this transaction
    // confined to this callback despite DbScope's existing pool-client type.
    const transactionScope = { ...scope, sql: tx as unknown as typeof sql };
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`benchmark-launch:${ws}`}, 0))`;
    await assertNoActiveRun(transactionScope);
    if ((await tx`SELECT id FROM harness_shared.bench_runs WHERE workspace_id = ${ws} AND id = ${runId}`).length) {
      throw new Error('Current benchmark arm/seed already has a durable attempt; use a new frozen protocol.');
    }
    await upsertBenchRun({ id: runId, arm: arm.id, taskSetId: 'custom', suite: input.suite ?? 'swe-bench-pro', model: arm.model,
      source: 'ui', status: 'running', taskCount: backlog.length,
      config: { current: { ...current, protocolRunId: protocol.runId }, protocol, resources, loopId } }, transactionScope);
    for (const task of backlog) await upsertBenchRunTask(runId, { instanceId: task.instanceId, taskStatus: 'todo' }, transactionScope);
  });
  const abort = new AbortController();
  const active: ActiveRun = { runId, workspaceId: ws, arm: arm.id, taskSetId: 'custom', taskIds: protocol.taskIds,
    startedAtMs: Date.now(), potSlugs: new Set(), cancelled: false, abort, protocolRunId: protocol.runId };
  activeRuns.set(runId, active);
  const run = async (req: HiveBacklogRunRequest): Promise<HiveBacklogResult> => {
    const taskResults: FleetTaskResult[] = [];
    for (const task of backlog) {
      if (abort.signal.aborted) break;
      await upsertBenchRunTask(runId, { instanceId: task.instanceId, taskStatus: 'in_progress' }, scope);
      const options: CurrentSuBenchOptions = { workspaceId: ws, runId: protocol.runId, armId: arm.id, seed: current.seed,
        agent: arm.agent, model: arm.model, effort: arm.effort as CurrentSuBenchOptions['effort'], account: arm.account,
        preregistration: registration, signal: abort.signal, driveTimeoutMs: arm.generationBudget.maxWallClockMs };
      const owned = await (deps.currentTask ?? liveCurrentTask)({ options, protocol, task, context, scope, resources, loopId, observation: current.observation });
      active.stopCurrent = owned.stop;
      const startedAtMs = Date.now();
      try {
        const attempt = await runArmGeneration({ arm: arm.id, blueprintId: FULL_SPINE_BLUEPRINT, task,
          seed: String(current.seed), budget: arm.generationBudget }, {
          clone: deps.currentGeneration?.clone ?? cloneTaskRepo, extractDiff: deps.currentGeneration?.extractDiff ?? extractDiff,
          instantiate: (blueprintId, task, checkout, budget) => owned.driver.spinRunAndCost({ blueprintId, task, checkout, budget }) });
        const result: FleetTaskResult = { attempt, cupId: currentBenchAssignmentId(protocol.runId, arm.id, task.instanceId, current.seed),
          placedAtMs: startedAtMs, startedAtMs, finishedAtMs: Date.now(), disposition: 'spawn' };
        taskResults.push(result);
        await upsertBenchRunTask(runId, taskRowFromFleetResult(result), scope);
      } finally { await owned.stop(); active.stopCurrent = undefined; }
    }
    return { arm: req.arm, suite: req.suite, runId, seed: current.seed, startedAtMs: active.startedAtMs,
      finishedAtMs: Date.now(), taskResults, coordEvents: [], peakConcurrentBees: taskResults.length ? 1 : 0, runError: null };
  };
  const req: HiveBacklogRunRequest = { arm: arm.id as HiveBacklogRunRequest['arm'], suite: (input.suite ?? 'swe-bench-pro') as HiveBacklogRunRequest['suite'],
    runId, seed: current.seed, backlog, budget: arm.generationBudget };
  return { runId, done: executeDetached(active, req, run, deps.dissolve ?? dissolveBenchHive, scope) };
}

const ACTIVE_STATES: BenchRunStatus[] = ['pending', 'running', 'grading'];

/** Throw if a run is already in flight (single-active-run — the spend-safety + D-005 gate). */
export async function assertNoActiveRun(opts: DbScope = {}): Promise<void> {
  const { sql, ws } = resolveDb(opts);
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM harness_shared.bench_runs
     WHERE workspace_id = ${ws} AND status = ANY(${ACTIVE_STATES as unknown as string[]})
     LIMIT 1
  `;
  if (rows.length > 0) {
    throw new Error(`conflicting_run_active: run ${rows[0].id} is still in flight — cancel it before launching another`);
  }
}

/**
 * Launch a bench run. Persists status=running, kicks the engine DETACHED, and
 * returns the run_id immediately. The caller (the launch route) does NOT await
 * the run — it streams live via @papercusp/sync.
 */
export async function launchBenchRun(
  input: LaunchBenchRunInput,
  deps: LaunchDeps = {},
): Promise<{ runId: string; done: Promise<void> }> {
  const assertEnabled = deps.assertEnabled ?? (() => assertExternalBenchEnabled('system'));
  await assertEnabled();

  if (input.current) return launchCurrentBenchRun(input, deps);
  if (input.arm === 'papercusp') throw new Error('Current Papercusp execution requires a committed frozen protocol; legacy launch is refused.');

  const scope = deps.scope ?? {};
  const { ws } = resolveDb(scope);
  await assertNoActiveRun(scope);

  const model = input.model ?? 'opus';
  const suite = input.suite ?? 'swe-bench-pro';
  const runId = deps.runId ?? `ui-${input.arm}-${Date.now()}`;
  const loadBacklog = deps.loadBacklog ?? loadBenchTaskSet;
  const run = deps.run ?? runHiveBacklog;
  // Per-arm driver selection (same mechanism the engine already uses: ONE bound HiveBacklogDriver per
  // run, picked by arm). 'su-independent' → the independent-su-agents pool driver (NO queen/hive); every
  // other arm → the real-Queen driver, which itself branches on 'hive-realqueen' vs 'fifo-noqueen'. A
  // test/host may override with deps.bindDriver. Both binds share the {workspaceId, onEnrolled,
  // onTaskCollected} persister surface; onHiveCreated is a no-op for the hive-less su-independent arm.
  const bindDriver = deps.bindDriver ?? (input.arm === SU_INDEPENDENT_ARM ? bindSuIndependentBacklogDriver : bindRealQueenBacklogDriver);
  const dissolve = deps.dissolve ?? dissolveBenchHive;

  const backlog = await loadBacklog(input.taskSetId, input.taskIds);

  await upsertBenchRun(
    {
      id: runId,
      arm: input.arm,
      taskSetId: input.taskSetId,
      suite,
      model,
      source: 'ui',
      status: 'running',
      taskCount: backlog.length,
      config: {
        arm: input.arm,
        taskSetId: input.taskSetId,
        taskIds: input.taskIds ?? null,
        model,
        cap: input.cap ?? null,
        maxUsdPerTask: input.maxUsdPerTask ?? null,
        maxTokensPerTask: input.maxTokensPerTask ?? null,
        maxUsdPerRun: input.maxUsdPerRun ?? null,
      },
    },
    scope,
  );

  // Seed per-task rows as todo so the live monitor shows the full task set up-front.
  for (const t of backlog) {
    await upsertBenchRunTask(runId, { instanceId: t.instanceId, taskStatus: 'todo' }, scope);
  }

  const active: ActiveRun = {
    runId,
    workspaceId: ws,
    arm: input.arm,
    taskSetId: input.taskSetId,
    taskIds: input.taskIds,
    startedAtMs: Date.now(),
    potSlugs: new Set(),
    cancelled: false,
  };
  activeRuns.set(runId, active);

  // Wire the persister durability hooks onto the real-Queen driver.
  bindDriver({
    workspaceId: ws,
    onHiveCreated: (hiveHome: string) => {
      active.potSlugs.add(hiveHome);
      void setBenchRunHive(runId, hiveHome, scope).catch(() => {});
    },
    onEnrolled: (e) => {
      void upsertBenchRunTask(runId, { instanceId: e.task.instanceId, taskStatus: 'in_progress' }, scope).catch(() => {});
    },
    onTaskCollected: (tr) => {
      void upsertBenchRunTask(runId, taskRowFromFleetResult(tr), scope).catch(() => {});
    },
  });

  const req: HiveBacklogRunRequest = {
    arm: input.arm as HiveBacklogRunRequest['arm'],
    suite: suite as HiveBacklogRunRequest['suite'],
    runId,
    seed: 1,
    backlog,
    budget: { maxUsd: input.maxUsdPerTask ?? 10, maxTokens: input.maxTokensPerTask ?? 4_000_000 },
  };

  // DETACHED — the route does NOT await `done`. Always tears down in the finally
  // (the fast path; the boot reaper is the SIGKILL-resilient backstop). `done` is
  // returned so tests / advanced callers can await completion.
  const done = executeDetached(active, req, run, dissolve, scope);

  return { runId, done };
}

/** Heartbeat interval (ms) the live run bumps bench_runs.updated_at on, so the
 *  boot reaper can tell a crashed host (stale heartbeat) from a run legitimately
 *  in flight in ANOTHER live host (fresh heartbeat). */
const HEARTBEAT_MS = 60_000;

/** Bump a run's updated_at — the liveness heartbeat. */
async function touchBenchRun(runId: string, opts: DbScope): Promise<void> {
  const { sql, ws } = resolveDb(opts);
  await sql`UPDATE harness_shared.bench_runs SET updated_at = now() WHERE id = ${runId} AND workspace_id = ${ws}`;
}

async function executeDetached(
  active: ActiveRun,
  req: HiveBacklogRunRequest,
  run: (req: HiveBacklogRunRequest) => Promise<HiveBacklogResult>,
  dissolve: (potSlug: string, workspaceId: string) => Promise<void>,
  scope: DbScope,
): Promise<void> {
  const { runId } = active;
  // Liveness heartbeat — unref'd so it never keeps the process alive on its own.
  const heartbeat = setInterval(() => void touchBenchRun(runId, scope).catch(() => {}), HEARTBEAT_MS);
  if (typeof heartbeat.unref === 'function') heartbeat.unref();
  try {
    const result = await run(req);
    if (active.cancelled) return; // cancelBenchRun already froze the status
    // Write the on-disk snapshot (PreservedArmRun + diffs + sample) so the run is
    // gradeable (P-010) + exportable (P-013), exactly like a CLI run. Best-effort.
    if (result.taskResults.length > 0) {
      try {
        const { writeRunSnapshot } = await import('./run-snapshot');
        writeRunSnapshot({
          runId,
          arm: active.arm,
          result,
          startedAtMs: active.startedAtMs,
          taskSetId: active.taskSetId,
          taskIds: active.taskIds,
        });
      } catch (error) {
        if (active.protocolRunId) throw error;
        /* snapshot is best-effort — the PG store already has the live truth */
      }
    }
    await setBenchRunEvents(runId, result.coordEvents ?? [], scope);
    await recordRunCompletion(
      runId,
      {
        peakConcurrentBees: result.peakConcurrentBees,
        wallMs: Math.max(0, result.finishedAtMs - result.startedAtMs),
        runError: result.runError ?? null,
      },
      scope,
    );
  } catch (e) {
    if (!active.cancelled) {
      await setBenchRunStatus(runId, 'error', { runError: e instanceof Error ? e.message : String(e) }, scope).catch(() => {});
    }
  } finally {
    clearInterval(heartbeat);
    // ALWAYS dissolve every hive this run minted — no orphan learning loop survives.
    for (const slug of active.potSlugs) {
      await dissolve(slug, active.workspaceId).catch(() => {});
    }
    activeRuns.delete(runId);
  }
}

/** Cancel an in-flight run: freeze status, dissolve its hive (stops spend). */
export async function cancelBenchRun(
  runId: string,
  deps: { scope?: DbScope; dissolve?: (potSlug: string, workspaceId: string) => Promise<void> } = {},
): Promise<{ cancelled: boolean }> {
  const scope = deps.scope ?? {};
  const { sql, ws } = resolveDb(scope);
  const dissolve = deps.dissolve ?? dissolveBenchHive;

  const rows = await sql<{ status: string; pot_slug: string | null; config: Record<string, unknown> | null }[]>`
    SELECT status, pot_slug, config FROM harness_shared.bench_runs
     WHERE id = ${runId} AND workspace_id = ${ws} LIMIT 1
  `;
  const row = rows[0];
  if (!row) return { cancelled: false };

  const active = activeRuns.get(runId);
  if (active) active.cancelled = true;
  active?.abort?.abort();
  await active?.stopCurrent?.();
  const protocolRunId = active?.protocolRunId ?? storedCurrentRunId(row.config);
  if (protocolRunId) await retireCurrentRun(ws, protocolRunId);

  // Freeze status FIRST so the detached completion handler won't overwrite it.
  await setBenchRunStatus(runId, 'cancelled', { runError: 'cancelled by operator' }, scope);

  // Dissolve every known hive (the in-flight set + the persisted slug).
  const slugs = new Set<string>(active?.potSlugs ?? []);
  if (row.pot_slug) slugs.add(row.pot_slug);
  for (const slug of slugs) await dissolve(slug, ws).catch(() => {});

  return { cancelled: true };
}

/**
 * Boot-time reaper (P-005, the D-022 durable closure). Any run left in an active
 * state by a crashed host (the finally never ran) is orphaned — its hive may
 * still carry an armed learning loop that re-spins opus on restart. Dissolve each
 * orphan's hive (deactivating its learning loops) and freeze its status to a
 * terminal state.
 *
 * HEARTBEAT-GATED: only runs whose liveness heartbeat (updated_at) is older than
 * `staleAfterSec` are reaped — so a run legitimately in flight in ANOTHER live
 * host (fresh heartbeat) is NOT killed by this host's boot sweep. Pass
 * staleAfterSec=0 to reap every active run regardless (tests / a forced sweep).
 * Idempotent; call once at host boot. Returns the runs reaped.
 */
export async function reapStaleBenchRuns(
  deps: {
    scope?: DbScope;
    dissolve?: (potSlug: string, workspaceId: string) => Promise<void>;
    staleAfterSec?: number;
  } = {},
): Promise<{ reaped: string[] }> {
  const scope = deps.scope ?? {};
  const { sql, ws } = resolveDb(scope);
  const dissolve = deps.dissolve ?? dissolveBenchHive;
  const staleAfterSec = deps.staleAfterSec ?? 180;

  const rows = await sql<{ id: string; pot_slug: string | null; config: Record<string, unknown> | null }[]>`
    SELECT id, pot_slug, config FROM harness_shared.bench_runs
     WHERE workspace_id = ${ws}
       AND status = ANY(${ACTIVE_STATES as unknown as string[]})
       AND updated_at < now() - make_interval(secs => ${staleAfterSec})
  `;
  const reaped: string[] = [];
  for (const r of rows) {
    const protocolRunId = storedCurrentRunId(r.config);
    if (protocolRunId) await retireCurrentRun(ws, protocolRunId);
    if (r.pot_slug) {
      await dissolve(r.pot_slug, ws).catch(() => {});
    }
    await setBenchRunStatus(
      r.id,
      'error',
      { runError: 'reaped: operator restarted while this run was in flight (spend-safety teardown)' },
      scope,
    ).catch(() => {});
    reaped.push(r.id);
  }
  return { reaped };
}

function storedCurrentRunId(config: Record<string, unknown> | null): string | null {
  if (!config || !config.current) return null;
  const protocol = currentBenchmarkProtocolSchema.parse(config.protocol);
  const current = config.current as Record<string, unknown>;
  if (current.protocolRunId !== protocol.runId) throw new Error('Current benchmark recovery protocol binding is invalid.');
  return protocol.runId;
}

/** Test-only — clear the in-process active-run registry between tests. */
export function _resetActiveRunsForTests(): void {
  activeRuns.clear();
}
