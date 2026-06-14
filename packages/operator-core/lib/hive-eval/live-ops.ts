/**
 * live-ops.ts — the CONCRETE {@link LiveHiveOps} binding (P-063 / D-011): the ~15 injected IO ops
 * `makeLiveHivePorts` orchestrates, wired to the real seams. This is the "wire-to-reality" layer the
 * orchestration's fakes stand in for — git/fs, the Queen-seat create, the member register + schema
 * scaffold, the HFC seed insert + block edges, hive start/pause, surveyHive, the placement /
 * spawn-row reads, the live capture (`captureRunData`), and the throwaway-hive teardown.
 *
 * Verifiability boundary (the same b459e drew for ground-truth-live.ts):
 *   - The fs/exec ops + every lifecycle op call ALREADY-TESTED seams (createHiveHarness,
 *     scaffoldHarnessSchema, setHiveStarted, surveyHive, syncFeatureBlockEdges, dropHarnessSchema).
 *   - The DB-read ops (placements in-flight, run stats, spawn rows) + the capture read synthetic
 *     rows in integration tests — NO LLM spend.
 *   - The ONE genuinely owner-gated, real-LLM seam is `driveToCompletion`'s real Queen (P-051): the
 *     budget-capped first run. The cost/coord/collision behavior fields have no confirmed column on
 *     `spawned_agents` and are first-live-run EKG wiring (flagged 0, never inflating a score —
 *     they're denominators / failure pairs, so 0 is the conservative floor + the outcome gate +
 *     un-gameable floor are fully sourced from ground-truth + baseline + timings).
 */
import { cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type postgres from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { createHiveHarness } from '../agent-tools/hive/_create';
import { loadHarnessRegistry, saveHarnessRegistry } from '../harness-registry';
import { scaffoldHarnessSchema, dropHarnessSchema } from '../scaffold-harness-schema';
import { removeHarnessFromWorkspace } from '../harness-membership';
import { setHiveStarted } from '../hive/started';
import { requestUrgentHiveWake } from '../hive/urgent-wake';
import { clearHiveTimeWake } from '../hive/wake';
import { surveyHive } from '../hive/survey';
import { syncFeatureBlockEdges } from '../dbos/feature-blockers-edges';
import { liveAcceptancePorts } from './outcome-metrics';
import { collectGroundTruth, runBaselineSuite, type GroundTruthCtx } from './ground-truth';
import { liveGroundTruthPortsFromSql } from './ground-truth-live';
import { SEED_APP_DIR } from './scenarios';
import type { HiveScenario } from './scenario';
import type { LiveHiveOps, LiveRunStats } from './live-ports';
import { packLiveRunCapture, type LiveRunCapture, type SpawnRunRow } from './live-capture';

const execFileP = promisify(execFile);

/** Spawn statuses that count as a TERMINAL placement (the in-flight predicate is the complement). */
const IN_FLIGHT_PLACEMENT_STATUSES = ['working', 'recovering'] as const;

interface SpawnRow {
  spawn_id: string;
  feature_id: string | null;
  status: string;
  started_at: string | Date;
  finished_at: string | Date | null;
  duration_ms: string | number | null;
}

/** The run's confirmed `spawned_agents` rows for the member, mapped to {@link SpawnRunRow}. */
async function readSpawnRows(sql: postgres.Sql, member: string, workspaceId: string): Promise<SpawnRunRow[]> {
  const rows = await sql<SpawnRow[]>`
    SELECT spawn_id, feature_id, status, started_at, finished_at, duration_ms
      FROM harness_shared.spawned_agents
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${member}`;
  return rows.map((r) => ({
    spawnId: r.spawn_id,
    featureId: r.feature_id,
    status: r.status,
    startedAtMs: new Date(r.started_at).getTime(),
    finishedAtMs: r.finished_at != null ? new Date(r.finished_at).getTime() : null,
    durationMs: r.duration_ms != null ? Number(r.duration_ms) : null,
  }));
}

/** The run's stats from the member's HFC rows (cost is first-live-run EKG wiring — see file header). */
async function readLiveRunStats(sql: postgres.Sql, member: string, workspaceId: string): Promise<LiveRunStats> {
  const rows = await sql<{ total: number; completed: number }[]>`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE status = 'passed')::int AS completed
      FROM harness_shared.harness_features_consolidated
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${member}`;
  return { costUsd: 0, workItemsTotal: rows[0]?.total ?? 0, workItemsCompleted: rows[0]?.completed ?? 0 };
}

export interface CaptureRunDataInput {
  member: string;
  repoPath: string;
  scenario: HiveScenario;
  workspaceId: string;
  maxChars: number;
}

/**
 * The LIVE `readRunTrace` — gather the full {@link LiveRunCapture} BEFORE teardown removes the clone
 * + member schema: run the scenario's acceptance command in the clone, collect the ground truth
 * (b459e's `liveGroundTruthPortsFromSql` over the member's HFC/spawn rows) with the regression floor
 * (pre = the pristine seed-app fixture, post = the run's mutated clone), and read the confirmed spawn
 * rows. The capture rides `extra.capture` to the (post-teardown) replay extractor. NO LLM spend —
 * the only live cost is the drive that produced these rows.
 */
export async function captureRunData(
  sql: postgres.Sql,
  input: CaptureRunDataInput,
): Promise<{ distilledTrace: string; traceRef: string; extra: Record<string, unknown> }> {
  const { member, repoPath, scenario, workspaceId, maxChars } = input;
  const ctx: GroundTruthCtx = { scenario, repoPath, hiveSlug: member, workspaceId };

  const acceptance = await liveAcceptancePorts().runAcceptance({ repoPath, acceptance: scenario.acceptance });

  const baseline = async () => {
    const [pre, post] = await Promise.all([runBaselineSuite(SEED_APP_DIR), runBaselineSuite(repoPath)]);
    return { pre, post };
  };
  const groundTruth = await collectGroundTruth(liveGroundTruthPortsFromSql({ sql, baseline }), ctx);

  const spawnRows = await readSpawnRows(sql, member, workspaceId);

  const capture: LiveRunCapture = { acceptance, groundTruth, spawnRows };

  // A compact human-readable trace for the (optional, advisory) HE-06 judge — capped at maxChars.
  const claimed = groundTruth.workItems.filter((w) => w.claimedDone).length;
  const real = groundTruth.workItems.filter((w) => w.actuallyDone && w.hasCommit).length;
  const trace =
    `Scenario ${scenario.id} (${scenario.shape}) — acceptance ${acceptance.passed ? 'PASS' : 'FAIL'}; ` +
    `${claimed} claimed done / ${real} genuinely done (commit+work); ${spawnRows.length} bee spawns. ` +
    `Review:\n${groundTruth.reviewOutput}`;
  const distilledTrace = trace.slice(0, maxChars);

  return { distilledTrace, traceRef: `hive-eval://${member}`, extra: packLiveRunCapture(capture) };
}

export interface LiveHiveOpsDeps {
  workspaceId: string;
  /** Per-run scratch parent dir (the base + clone live under it). Default `os.tmpdir()/hive-eval`. */
  scratchParent?: string;
}

/**
 * Bind the concrete {@link LiveHiveOps} for a workspace. Every IO op the orchestration calls is a
 * real seam here; `makeLiveHivePorts(liveHiveOps({ workspaceId }), { workspaceId })` is the live
 * `HiveRunPorts` the cadence runs once the owner sets a budget (P-051).
 */
export function liveHiveOps(deps: LiveHiveOpsDeps): LiveHiveOps {
  const ws = deps.workspaceId;
  const scratchParent = deps.scratchParent ?? join(tmpdir(), 'hive-eval');
  const sqlClient = (): postgres.Sql => getOrgPg().sql;

  return {
    scratchRoot: (slug) => join(scratchParent, slug),
    copyDir: (src, dest) => cp(src, dest, { recursive: true }),
    exec: async (cmd, args) => {
      const { stdout } = await execFileP(cmd, args, { maxBuffer: 16 * 1024 * 1024 });
      return { stdout };
    },
    rm: (path) => rm(path, { recursive: true, force: true }),

    async createHive({ slug, workspaceId }) {
      // Idle (no wakeInSeconds — driveToCompletion starts it), repo-less, no learning-pack seed.
      const res = await createHiveHarness({ slug, workspaceId, learningPack: null });
      if (!res.ok) {
        throw new Error(`hive-eval createHive('${slug}') failed: ${res.error ?? 'unknown'} ${res.message ?? ''}`.trim());
      }
    },

    async registerMember({ member, clonePath, hiveHome, workspaceId }) {
      // Register the hermetic clone as a (non-hive) MEMBER harness with `hive_slug` → the home so
      // surveyHive scans it; then scaffold its schema. We set hive_slug DIRECTLY (not addHarnessToHive)
      // so the throwaway clone never gets a git-sync routine seeded — it must not federate/push.
      const reg = await loadHarnessRegistry(workspaceId);
      if (!reg.projects.some((p) => p.slug === member)) {
        reg.projects.push({ slug: member, path: clonePath, hive_slug: hiveHome });
        await saveHarnessRegistry(reg, workspaceId);
      }
      await scaffoldHarnessSchema(member);
    },

    async seedFeature({ member, featureId, title, spec }) {
      // Direct HFC insert keyed on the SCENARIO item id (the throwaway convention ground-truth-live
      // defaults its idMap to: feature_id === scenario id), todo/feature — mirrors createWorkItem's
      // write (workspace_id filled by the fill_ws_features trigger from the member's project row).
      const sql = sqlClient();
      const now = Date.now();
      await sql.unsafe(
        `INSERT INTO harness_shared.harness_features_consolidated (
           harness_slug, feature_id, title, summary, status, attempts,
           item_kind, needs_design, needs_human_review, ts, created_ts, updated_ts
         ) VALUES ($1, $2, $3, $4, 'todo', 0, 'feature', FALSE, FALSE, $5, $6, $7)
         ON CONFLICT (harness_slug, feature_id) DO NOTHING`,
        [member, featureId, title, spec, now, now, now],
      );
    },

    syncBlockEdges: ({ member, featureId, blockedBy }) => syncFeatureBlockEdges(member, featureId, [...blockedBy]),

    async startHive({ hiveHome, workspaceId, kickoff }) {
      // The core of hive:start: persist started=true (the watchdog's liveness bit) + wake the Queen.
      await setHiveStarted(workspaceId, hiveHome, true);
      await requestUrgentHiveWake({ reason: kickoff, harness: hiveHome, workspaceId });
    },

    pauseHive: ({ hiveHome, workspaceId }) => setHiveStarted(workspaceId, hiveHome, false),

    async survey({ hiveHome, workspaceId }) {
      const s = await surveyHive(workspaceId, hiveHome);
      return { plans: s.plans, frontier: s.frontier };
    },

    async countInFlightPlacements({ hiveHome, workspaceId }) {
      const sql = sqlClient();
      const rows = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM harness_shared.hive_placements
         WHERE workspace_id = ${workspaceId} AND install_slug = ${hiveHome}
           AND status = ANY(${[...IN_FLIGHT_PLACEMENT_STATUSES]})`;
      return rows[0]?.n ?? 0;
    },

    readRunStats: ({ member, workspaceId }) => readLiveRunStats(sqlClient(), member, workspaceId),

    readRunTrace: (input) => captureRunData(sqlClient(), input),

    async dropMember({ member, workspaceId }) {
      await removeHarnessFromWorkspace(workspaceId, member).catch(() => {});
      await dropHarnessSchema(member).catch(() => {});
    },

    async dissolveHive({ hiveHome, workspaceId }) {
      // The durable inverse of createHive (mirrors hive:dissolve's core, minus the bee-cancel — the
      // drive already paused the hive, so its bees are terminal by teardown): stop re-waking,
      // deregister, drop schema. Best-effort throughout (teardown must not mask the run's outcome).
      await setHiveStarted(workspaceId, hiveHome, false).catch(() => {});
      const sql = sqlClient();
      await clearHiveTimeWake(sql, hiveHome).catch(() => {});
      await removeHarnessFromWorkspace(workspaceId, hiveHome).catch(() => {});
      await dropHarnessSchema(hiveHome).catch(() => {});
    },

    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}
