/**
 * tau2-backlog.ts — the τ²-bench (tau2-bench) fleet-arm backlog driver
 * (plan benchmark-arms-su-vs-queen-expansion-2026-06-16; the dual-arm unification — "run every suite on the
 * SAME generic shared orchestration as every other arm").
 *
 * τ²-bench is a conversational tool-agent benchmark: one agent ↔ a simulated user, scored by a per-trial
 * REWARD ∈ [0,1] (1 = the task's goal state was reached). Like the METR HCAST / TheAgentCompany / PaperBench
 * drivers, this wraps the SAME generic shell ({@link makePoolBacklogDriver}: bounded concurrency pool +
 * live-occupancy {@link ConcurrencyTimeline} + the never-throw drain) so τ²-bench emits the canonical
 * {@link HiveBacklogResult} and flows through the identical {@link runHiveBacklog} dispatch + downstream fleet
 * metrics (`toFleetRunSummary` → `@papercusp/bench-metrics buildHiveReport`) as every other suite. The ONLY
 * suite-specific bit is the per-task work: run ONE tau2 conversation for the task and carry its reward.
 *
 * WORK-SURFACE DIFFERENCE (vs the SWE-bench M1 diff arms): there is no worktree/diff. Each task is one
 * agent↔user-simulator conversation against a vendored PYTHON harness (`~/.papercusp/bench-harnesses/tau2-bench`,
 * driven via `uv run tau2 run` / `pc_run.sh`). The "submission" is the conversation transcript; the score is
 * the harness's own per-trial `reward_info.reward`. So the per-task work shells out to the harness, then reads
 * `data/simulations/<save-to>/results.json` (`simulations[].reward_info.reward`; cost = `agent_cost`+`user_cost`)
 * and carries reward + cost on `attempt.armMeta` — exactly the METR HCAST armMeta round-trip pattern.
 *
 * THE THREE ARMS (the {@link Tau2Arm} mapping). τ²-bench scores ONE conversational identity, so the
 * su-vs-hive distinction is partly degenerate here (the user/sim see a single agent regardless of how it
 * decomposes internally) — see {@link TAU2_AGENT_FOR_ARM} for the per-arm `--agent` and the WHY:
 *   - 'baseline-opus' → `llm_agent`   (stock single opus, the reference SUT).
 *   - 'hive'          → `papercup_hive` (the in-process planner→worker route-B agent vendored in the harness).
 *   - 'su'            → `llm_agent`   (degenerate for a single conversational SUT — see the comment).
 *
 * DEPENDENCY INJECTION: the shell-out + results parsing is one injected seam ({@link Tau2BacklogDeps.runConversation}),
 * defaulting to the real Python invocation ({@link realRunTau2Conversation}) but STUBBABLE in the test so a unit
 * test asserts the pool contract / FleetTaskResult shape / arm switching / round-trip with ZERO subprocess or
 * LLM calls. Never throws (the generation-failure contract — an infra failure lands a non-scored error row).
 */
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { FleetArmId } from '@papercusp/bench-metrics';
import type { HiveBacklogDriver, HiveBacklogResult, FleetTaskResult } from './hive-backlog';
import { makePoolBacklogDriver } from './hive-backlog-utilities';
import type { ArmAttempt, BenchTask, GenerationBudget, GenerationStopReason } from './types';

/** The τ²-bench blueprint id stamped on the attempt row (the conversational tool-agent suite). */
export const TAU2_BLUEPRINT_ID = 'tau2-bench';

/** The three fleet arms this driver runs (the plan's {baseline-opus, hive, su} expansion). */
export const TAU2_BASELINE_OPUS_ARM: FleetArmId = 'baseline-opus';
export const TAU2_HIVE_ARM: FleetArmId = 'hive';
export const TAU2_SU_ARM: FleetArmId = 'su';

/** The tau2 `--agent` registered factory names (src/tau2/registry.py): the single-opus SUT vs the route-B hive. */
export type Tau2Agent = 'llm_agent' | 'papercup_hive';

/**
 * Fleet-arm → tau2 `--agent` factory name. A small, clearly-documented record so a real cross-process arm can
 * be slotted in later (a distinct registered factory) without touching the driver.
 *
 *   - 'baseline-opus' → 'llm_agent'    — stock single opus, the reference system-under-test.
 *   - 'hive'          → 'papercup_hive' — the in-process planner→worker route-B agent vendored in the harness
 *                                         (src/tau2/agent/papercup_hive_agent.py: one conversational identity
 *                                         that decomposes internally).
 *   - 'su'            → 'llm_agent'    — DEGENERATE for a single-agent-interactive suite. τ²-bench scores ONE
 *                                         conversational identity (the user-simulator sees a single agent), so
 *                                         there is no distinct cross-process su-agent to register: the su-vs-hive
 *                                         distinction collapses for a single conversational SUT. P-005's route-B
 *                                         A/B showed no lift over stock opus on this surface, so 'su' maps to the
 *                                         stock `llm_agent` for now. TODO(benchmark-arms-su-vs-queen-expansion):
 *                                         when a genuine cross-process su agent exists, register it as its own
 *                                         tau2 factory and point 'su' at it here — the rest of the driver is
 *                                         arm-agnostic by construction.
 */
export const TAU2_AGENT_FOR_ARM: Record<string, Tau2Agent> = {
  'baseline-opus': 'llm_agent',
  hive: 'papercup_hive',
  // su is degenerate for a single conversational SUT (see the doc above) → stock opus for now.
  su: 'llm_agent',
};

/** Resolve a fleet-arm id → the tau2 `--agent` factory name (unknown arms default to the stock opus SUT). */
export function tau2AgentForArm(arm: FleetArmId): Tau2Agent {
  return TAU2_AGENT_FOR_ARM[String(arm)] ?? 'llm_agent';
}

/** The settled outcome of ONE tau2 conversation — the only suite-specific seam {@link makeTau2BacklogDriver}
 *  injects. MUST be never-throw: on any infra/transport failure return `{ stopReason: 'infra-failed', error }`
 *  with reward null, NOT an exception (the never-throw generation contract; downstream excludes it). */
export interface Tau2ConversationResult {
  /** The harness's per-trial reward ∈ [0,1] (1 = goal reached); null on an infra failure (non-scored). */
  reward: number | null;
  /** $ the agent side spent (results.json `agent_cost`). */
  agentCostUsd: number;
  /** $ the user-simulator side spent (results.json `user_cost`). */
  userCostUsd: number;
  /** Why the conversation stopped — a resolved/normal finish → 'done'; an infra/transport failure → 'infra-failed'. */
  stopReason: GenerationStopReason;
  /** Infra failure detail (only on a non-scored terminal). */
  error?: string;
  /** Provenance for the row (the save-to dir / trajectory ref), when the run produced one. */
  trajectoryRef?: string;
}

/** The injected per-conversation work: run ONE tau2 conversation for `task` on `arm`. Defaults to the real
 *  Python invocation ({@link realRunTau2Conversation}); the test injects a fake so no subprocess/LLM runs. */
export type RunTau2Conversation = (input: {
  task: BenchTask;
  arm: FleetArmId;
  seed: string;
  budget: GenerationBudget;
}) => Promise<Tau2ConversationResult>;

export interface Tau2BacklogDeps {
  now?: () => number;
  /** The fleet concurrency cap (= the global `maxSimultaneousAgents`). */
  concurrencyCap: () => number | Promise<number>;
  /** The conversation seam (default {@link realRunTau2Conversation} — the vendored Python harness). */
  runConversation?: RunTau2Conversation;
  fleetTimeoutMs?: number;
  sampleIntervalMs?: number;
  /** Fired the instant each conversation settles → durability (a partial/killed run still banks its rows). */
  onTaskCollected?: (r: Tau2ConversationResult, task: BenchTask) => void | Promise<void>;
}

/**
 * Map one settled {@link Tau2ConversationResult} → the canonical {@link FleetTaskResult}, carrying the
 * reward/score/resolved + the per-side cost on `attempt.armMeta` so BOTH the fleet metrics and the τ²-bench
 * round-trip ({@link tau2TaskResultsFromFleet}) read it from the canonical fleet output. A resolved/normal
 * finish → stopReason 'done'; an infra failure → the conversation's non-scored terminal (reward null, excluded).
 */
function toFleetTaskResult(
  r: Tau2ConversationResult,
  task: BenchTask,
  arm: FleetArmId,
  seed: string,
  placedAtMs: number,
  startedAtMs: number,
  finishedAtMs: number,
): FleetTaskResult {
  const resolved = r.reward === null ? null : r.reward === 1;
  const costUsd = r.agentCostUsd + r.userCostUsd;
  const attempt: ArmAttempt = {
    arm: String(arm),
    blueprintId: TAU2_BLUEPRINT_ID,
    instanceId: task.instanceId,
    seed,
    diff: '', // conversational suite: there is no diff
    tokensIn: 0,
    tokensOut: 0,
    costUsd,
    turns: 0,
    wallClockMs: Math.max(0, finishedAtMs - startedAtMs),
    trajectoryRef: r.trajectoryRef ?? '',
    stopReason: r.stopReason,
    ...(r.error ? { generationError: r.error } : {}),
    armMeta: {
      suite: 'tau2-bench',
      agent: tau2AgentForArm(arm),
      reward: r.reward,
      score: r.reward, // for a single trial the reward IS the score
      resolved,
      agentCostUsd: r.agentCostUsd,
      userCostUsd: r.userCostUsd,
    },
  };
  return {
    attempt,
    beeId: r.trajectoryRef || `tau2-${task.instanceId}-${seed}`,
    placedAtMs,
    startedAtMs,
    finishedAtMs,
    disposition: 'spawn',
  };
}

/**
 * Build the τ²-bench {@link HiveBacklogDriver} for ONE arm. The generic shell ({@link makePoolBacklogDriver})
 * owns the sampler + pool + canonical-output projection; τ²-bench supplies ONLY its per-task work (run one
 * conversation → reward → FleetTaskResult), and `req.arm` selects the tau2 `--agent` via {@link tau2AgentForArm}.
 * Never throws — {@link RunTau2Conversation} is itself never-throw (an infra failure becomes a non-scored
 * result, not an exception); a defensive catch here also degrades to an infra-failed row.
 */
export function makeTau2BacklogDriver(deps: Tau2BacklogDeps): HiveBacklogDriver {
  const now = deps.now ?? (() => Date.now());
  const runConversation = deps.runConversation ?? realRunTau2Conversation;
  return makePoolBacklogDriver({
    now,
    concurrencyCap: () => deps.concurrencyCap(),
    fleetTimeoutMs: deps.fleetTimeoutMs,
    sampleIntervalMs: deps.sampleIntervalMs,
    perTask: async ({ task, arm, seed, budget }): Promise<FleetTaskResult> => {
      const placedAtMs = now();
      const startedAt = now();
      let r: Tau2ConversationResult;
      try {
        r = await runConversation({ task, arm, seed, budget });
      } catch (e) {
        // Defensive: runConversation is contractually never-throw, but a thrown error still degrades to a
        // non-scored infra row rather than escaping perTask (the never-throw pool contract).
        r = { reward: null, agentCostUsd: 0, userCostUsd: 0, stopReason: 'infra-failed', error: e instanceof Error ? e.message : String(e) };
      }
      const finishedAt = now();
      await Promise.resolve(deps.onTaskCollected?.(r, task)).catch(() => {});
      return toFleetTaskResult(r, task, arm, seed, placedAtMs, startedAt, finishedAt);
    },
  });
}

/** One arm's outcome from {@link runTau2SuiteViaFleet}: the canonical fleet record for that arm. */
export interface Tau2FleetArmResult {
  fleetArm: FleetArmId;
  result: HiveBacklogResult;
}

/** The full multi-arm τ²-bench run THROUGH the shared fleet contract — one canonical record per arm. */
export interface Tau2FleetRunResult {
  fleet: Tau2FleetArmResult[];
}

/**
 * Run the multi-arm τ²-bench suite THROUGH the canonical {@link HiveBacklogDriver} fleet contract — each fleet
 * arm ({baseline-opus, hive, su}) runs its own {@link makeTau2BacklogDriver} over the SAME backlog; an optional
 * `runConversationFor(arm)` binds that arm's conversation seam (default: the shared real Python invocation, which
 * already switches on `arm` internally). Returns the canonical {@link HiveBacklogResult} per arm; the per-task
 * reward/score rides `attempt.armMeta` for {@link tau2TaskResultsFromFleet} + the standard fleet rollup.
 */
export async function runTau2SuiteViaFleet(input: {
  tasks: BenchTask[];
  /** Fleet arms to run (default all three: baseline-opus + hive + su). */
  arms?: FleetArmId[];
  now?: () => number;
  concurrencyCap: () => number | Promise<number>;
  /** Per-arm conversation seam (default {@link realRunTau2Conversation} for every arm). */
  runConversationFor?: (arm: FleetArmId) => RunTau2Conversation;
  runId?: string;
  seed?: number;
  budget?: GenerationBudget;
  fleetTimeoutMs?: number;
  sampleIntervalMs?: number;
  onTaskCollected?: (fleetArm: FleetArmId, r: Tau2ConversationResult, task: BenchTask) => void | Promise<void>;
  onArmDone?: (arm: Tau2FleetArmResult) => void | Promise<void>;
}): Promise<Tau2FleetRunResult> {
  const arms = input.arms ?? [TAU2_BASELINE_OPUS_ARM, TAU2_HIVE_ARM, TAU2_SU_ARM];
  const runId = input.runId ?? 'tau2-fleet';
  const seed = input.seed ?? 0;
  const budget = input.budget ?? {};

  const fleet: Tau2FleetArmResult[] = [];
  for (const arm of arms) {
    const driver = makeTau2BacklogDriver({
      now: input.now,
      concurrencyCap: input.concurrencyCap,
      runConversation: input.runConversationFor?.(arm),
      fleetTimeoutMs: input.fleetTimeoutMs,
      sampleIntervalMs: input.sampleIntervalMs,
      onTaskCollected: (r, task) => input.onTaskCollected?.(arm, r, task),
    });
    const result = await driver.run({ arm, suite: 'tau2-bench', runId, seed, backlog: input.tasks, budget });
    const armResult: Tau2FleetArmResult = { fleetArm: arm, result };
    fleet.push(armResult);
    await Promise.resolve(input.onArmDone?.(armResult)).catch(() => {});
  }
  return { fleet };
}

/** One τ²-bench task's reconstructed result (read off the canonical fleet output via `attempt.armMeta`). */
export interface Tau2TaskResult {
  instanceId: string;
  arm: string;
  seed: string;
  /** The per-trial reward ∈ [0,1]; null on a non-scored (infra) row. */
  reward: number | null;
  /** Alias of `reward` for the single trial (the score the suite headline averages). */
  score: number | null;
  /** reward === 1; null when the reward is null (infra-failed). */
  resolved: boolean | null;
  agentCostUsd: number;
  userCostUsd: number;
  stopReason: GenerationStopReason;
}

/** The τ²-bench suite rollup over a single trial: per-task results + avg_reward + pass^1 (the fraction
 *  resolved over SCORED rows — non-scored/infra rows are excluded, mirroring the fairness predicate). */
export interface Tau2SuiteResult {
  arm: string;
  tasks: Tau2TaskResult[];
  /** Mean reward over SCORED rows (reward !== null); 0 when no scored rows. */
  avgReward: number;
  /** pass^1 over the single trial = fraction of SCORED rows with reward === 1; 0 when no scored rows. */
  passHat1: number;
  /** Count of scored rows (reward !== null) — the denominator for avgReward / passHat1. */
  scoredCount: number;
}

/**
 * Reconstruct the τ²-bench per-task results + suite rollup from a canonical {@link HiveBacklogResult} (the
 * reward/score/resolved ride `attempt.armMeta`), so the suite headline (avg_reward, pass^1) runs off the same
 * fleet output the standard metrics consume — one run, both metric families. Mirrors
 * `metrHcastTaskResultsFromFleet`: a pure read of `attempt.armMeta`, no recompute.
 */
export function tau2TaskResultsFromFleet(result: HiveBacklogResult): Tau2SuiteResult {
  const tasks: Tau2TaskResult[] = result.taskResults.map((t): Tau2TaskResult => {
    const meta = t.attempt.armMeta ?? {};
    const reward = typeof meta['reward'] === 'number' ? (meta['reward'] as number) : null;
    const resolved = typeof meta['resolved'] === 'boolean' ? (meta['resolved'] as boolean) : null;
    return {
      instanceId: t.attempt.instanceId,
      arm: t.attempt.arm,
      seed: t.attempt.seed,
      reward,
      score: reward,
      resolved,
      agentCostUsd: typeof meta['agentCostUsd'] === 'number' ? (meta['agentCostUsd'] as number) : 0,
      userCostUsd: typeof meta['userCostUsd'] === 'number' ? (meta['userCostUsd'] as number) : 0,
      stopReason: t.attempt.stopReason,
    };
  });
  const scored = tasks.filter((t) => t.reward !== null);
  const scoredCount = scored.length;
  const avgReward = scoredCount > 0 ? scored.reduce((s, t) => s + (t.reward ?? 0), 0) / scoredCount : 0;
  const passHat1 = scoredCount > 0 ? scored.filter((t) => t.reward === 1).length / scoredCount : 0;
  return { arm: String(result.arm), tasks, avgReward, passHat1, scoredCount };
}

/* -------------------------------------------------------------------------- */
/* The real (default) conversation seam — the vendored Python harness          */
/* -------------------------------------------------------------------------- */

/** Where the vendored τ²-bench Python harness lives (driven via `uv run tau2 run` / `pc_run.sh`). */
const TAU2_HARNESS_DIR = join(homedir(), '.papercusp', 'bench-harnesses', 'tau2-bench');
/** Default per-conversation wall-clock ceiling before the subprocess is hard-killed (ms). */
const DEFAULT_TAU2_CONVERSATION_TIMEOUT_MS = 30 * 60_000;

/** The slice of `data/simulations/<save-to>/results.json` we read (one simulation = one trial). */
interface Tau2ResultsJson {
  simulations?: { reward_info?: { reward?: number }; agent_cost?: number; user_cost?: number }[];
}

/** A `task.domain` (or `graderMeta.domain`) is required to address a tau2 run; fall back to a sane default. */
function tau2DomainForTask(task: BenchTask): string {
  const fromMeta = (task.graderMeta?.['domain'] ?? (task as unknown as { domain?: string }).domain) as unknown;
  return typeof fromMeta === 'string' && fromMeta.length > 0 ? fromMeta : 'telecom';
}

/**
 * The REAL conversation seam: shell out to the vendored Python harness for ONE trial of `task` on `arm`'s
 * `--agent`, then read the per-trial reward + cost from `data/simulations/<save-to>/results.json`. Env is the
 * documented CC-framing + extended-thinking knobs (TAU2_PAPERCUSP_CC_FRAMING=1, PC_REASONING=high). Never throws:
 * a non-zero exit, a missing/garbled results file, or a hard-kill timeout all degrade to a non-scored
 * `{ reward: null, stopReason: 'infra-failed', error }` (downstream `isScoredStopReason` excludes it).
 *
 * NB this is the production path; the unit test injects a fake `runConversation`, so no subprocess/LLM runs there.
 */
export const realRunTau2Conversation: RunTau2Conversation = async ({ task, arm }) => {
  const domain = tau2DomainForTask(task);
  const agent = tau2AgentForArm(arm);
  const saveTo = `tau2-${arm}-${task.instanceId}-${Date.now()}`.replace(/[^A-Za-z0-9._-]/g, '_');
  const resultsPath = join(TAU2_HARNESS_DIR, 'data', 'simulations', saveTo, 'results.json');

  const args = [
    'run',
    'tau2',
    'run',
    '--domain',
    domain,
    '--num-tasks',
    '1',
    '--num-trials',
    '1',
    '--agent',
    agent,
    '--save-to',
    saveTo,
  ];
  const env: Record<string, string> = {
    ...process.env,
    TAU2_PAPERCUSP_CC_FRAMING: '1',
    PC_REASONING: 'high',
  };

  const code = await new Promise<number>((resolve) => {
    const child = spawn('uv', args, { cwd: TAU2_HARNESS_DIR, env });
    const timer = setTimeout(() => child.kill('SIGKILL'), DEFAULT_TAU2_CONVERSATION_TIMEOUT_MS);
    child.on('close', (c) => {
      clearTimeout(timer);
      resolve(c ?? -1);
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(-1);
    });
  });

  if (code !== 0) {
    return { reward: null, agentCostUsd: 0, userCostUsd: 0, stopReason: 'infra-failed', error: `tau2 run exited ${code}`, trajectoryRef: saveTo };
  }

  let parsed: Tau2ResultsJson;
  try {
    parsed = JSON.parse(await readFile(resultsPath, 'utf8')) as Tau2ResultsJson;
  } catch (e) {
    return { reward: null, agentCostUsd: 0, userCostUsd: 0, stopReason: 'infra-failed', error: `read results.json failed: ${e instanceof Error ? e.message : String(e)}`, trajectoryRef: saveTo };
  }
  const sim = parsed.simulations?.[0];
  const reward = typeof sim?.reward_info?.reward === 'number' ? sim.reward_info.reward : null;
  if (reward === null) {
    return { reward: null, agentCostUsd: 0, userCostUsd: 0, stopReason: 'infra-failed', error: 'no reward in results.json', trajectoryRef: saveTo };
  }
  return {
    reward,
    agentCostUsd: typeof sim?.agent_cost === 'number' ? sim.agent_cost : 0,
    userCostUsd: typeof sim?.user_cost === 'number' ? sim.user_cost : 0,
    stopReason: 'done',
    trajectoryRef: saveTo,
  };
};
