/**
 * P-001 "minimal bootable unit" — the spawn spec for the dedicated gym-operator.
 *
 * Per D-018 (Option A), the gym runs the real pipeline on ONE long-lived headless
 * operator+DBOS process, NOT the live :3070 fleet operator. This builder encodes
 * the exact environment that makes that instance hermetic:
 *
 *   - booted from a PINNED papercup checkout (a worktree/clone parked at a fixed
 *     SHA) so the harness-under-test code can't drift mid-run (D-016);
 *   - pointed at a DEDICATED gym PG database (both admin-DSN resolution keys), so
 *     no gym schema/run ever touches the live PG and no live DSN leaks in;
 *   - on a DEDICATED port; DBOS autoloop scoped (default: manual) so the runner
 *     starts each pipeline explicitly for deterministic 1-feature-per-harness runs;
 *   - DBOS app-version pinned to the harness commit, isolating the gym DBOS app
 *     from the live one and keeping workflow recovery stable for the run.
 *
 * Pure: returns the spawn spec; the caller spawns with `{ ...process.env, ...env }`
 * so these explicit gym overrides win (dotenv.config() does not override set vars).
 */
import { isPinnedCommit } from './clone';

export interface GymOperatorBootConfig {
  /** Absolute path to the pinned papercup checkout (worktree/clone @ harnessCommit). */
  pinnedCheckoutPath: string;
  /** The pinned harness-under-test commit SHA (D-016) — recorded as gym_runs_params.harness_commit. */
  harnessCommit: string;
  /** DSN of the dedicated gym Postgres database. */
  gymDatabaseUrl: string;
  /** Dedicated Hono port for this instance. */
  honoPort: number;
  /** Workspace id to pin for the instance's lifetime. */
  workspaceId: string;
  /** PAPERCUSP_DBOS_ORCHESTRATOR_HARNESSES; default 'none' (manual dispatch only). */
  autoloopScope?: string;
  /** PAPERCUSP_DBOS_MAX_PIPELINES; default 4 (matches the DBOS pipeline queue). */
  maxPipelines?: number;
  /** Bind interface; default loopback. */
  bindHost?: string;
  /** Optional pin of the agent CLI command (AGENT_CMD). */
  agentCmd?: string;
  /** Optional pin of per-role models (AGENT_MODELS json). */
  agentModels?: Record<string, string>;
}

export interface GymOperatorBootSpec {
  command: string;
  args: string[];
  cwd: string;
  /** The explicit gym overrides; merge onto process.env (these win). */
  env: Record<string, string>;
}

export function buildGymOperatorBootSpec(cfg: GymOperatorBootConfig): GymOperatorBootSpec {
  if (!isPinnedCommit(cfg.harnessCommit)) {
    throw new Error(
      `gym harness-under-test commit must be a pinned hex SHA (D-016), got: ${JSON.stringify(cfg.harnessCommit)}`,
    );
  }

  const env: Record<string, string> = {
    // Hermetic PG: pin every DSN key the operator AND its spawned worker subprocess
    // consult. getHarnessAdminUrl() (operator side) reads HARNESS_ADMIN_DATABASE_URL >
    // DATABASE_URL; the orchestrator pg-bootstrap (WORKER subprocess, inheriting this
    // env) reads PAPERCUSP_DATABASE_URL > ~/.papercusp/embedded-pg.json > :5432/papercusp.
    // Pin ALL THREE so neither the live DATABASE_URL nor a live embedded-pg.json can leak
    // in — without PAPERCUSP_DATABASE_URL the worker silently connects to the live dev DB
    // (a hermeticity breach) where the gym harness schema is absent → UPDATE 42P01.
    DATABASE_URL: cfg.gymDatabaseUrl,
    HARNESS_ADMIN_DATABASE_URL: cfg.gymDatabaseUrl,
    PAPERCUSP_DATABASE_URL: cfg.gymDatabaseUrl,
    // GYM-1 layer-2 fix (gym-unwedge-scout-novelty-2026-07-02): the org-pg APP
    // resolver (libs/db connection.ts resolveAppUrl) consults HARNESS_DATABASE_URL
    // FIRST and NEVER falls back to DATABASE_URL — unpinned, the gym-operator fell
    // through to the hardcoded harness_app:harness_app_pwd@localhost:5432 default
    // against the LIVE native PG → "password authentication failed" on EVERY
    // getOrgPg() consumer at boot. This was the REAL error behind the 12-day
    // gym-cycle:error streak (masked by the detail-dropping recorder, also fixed).
    HARNESS_DATABASE_URL: cfg.gymDatabaseUrl,
    PAPERCUSP_HONO_PORT: String(cfg.honoPort),
    PAPERCUSP_BIND_HOST: cfg.bindHost ?? '127.0.0.1',
    PAPERCUSP_WORKSPACE_ID: cfg.workspaceId,
    // Boot the durable orchestrator; keep auto-dispatch off by default so the
    // runner owns when each feature pipeline starts (deterministic).
    PAPERCUSP_DBOS_ENABLE: '1',
    // Generic routines engine (git-sync-auto-commit P-001) — git-sync + future
    // per-harness scheduled tasks. Routines stay inert unless active=true.
    PAPERCUSP_DBOS_ROUTINES: '1',
    PAPERCUSP_DBOS_ORCHESTRATOR_HARNESSES: cfg.autoloopScope ?? 'none',
    PAPERCUSP_DBOS_MAX_PIPELINES: String(cfg.maxPipelines ?? 4),
    // Isolate the gym DBOS application + keep recovery stable for the run.
    DBOS__APPVERSION: `gym-${cfg.harnessCommit.slice(0, 12)}`,
    // Not the Tauri desktop/IPC context.
    PAPERCUSP_IPC_ENABLE: '0',
    // EI-368: headless utility profile — skip the voice cluster, hyperbee
    // substrate, and embedder warm-up. The gym never uses them, they inherit
    // port scans from the launcher env, and they carry the heavy native-module
    // surface suspected in the intermittent boot abort (Napi::Error terminate
    // mid-DBOS-migration → half-migrated dbos schema → "column was_forked_from
    // does not exist" on the first pipeline call).
    PAPERCUSP_UTILITY_HOST: '1',
    // The gym REQUIRES DBOS launched: its readiness gate (/api/health/ready) is
    // `dbosEnabled ? dbosLaunched : true`, and it runs feature pipelines through
    // DBOS. backgroundWorkersEnabled() — which bundles the DBOS launch — defaults
    // OFF under VITEST and under an inherited PAPERCUSP_BACKGROUND_WORKERS=0 (the
    // dev-box .env.local / the :3170 staging operator set it request-only). Either
    // leak leaves PAPERCUSP_DBOS_ENABLE=1 waiting on a launch that never happens →
    // /api/health/ready stuck at 503 → the runner's 120s readiness timeout (the
    // gym cycle then fails before it starts). Seal both, matching this spec's
    // hermeticity contract: force backgroundWorkers ON (the gym runs against its
    // OWN isolated DB, so no EI-126 two-host conflict; PAPERCUSP_UTILITY_HOST still
    // strips the dogfood/voice/embedder legs) and blank an inherited VITEST so a
    // test/CI-spawned gym boots as a real operator, not a suppressed vitest worker.
    PAPERCUSP_BACKGROUND_WORKERS: '1',
    VITEST: '',
  };

  if (cfg.agentCmd) env.AGENT_CMD = cfg.agentCmd;
  // ALWAYS pin per-role models (default `{}` = no overrides → every role runs AGENT_CMD's
  // model). This SEALS the gym from the launcher's inherited AGENT_MODELS — e.g. the dev
  // box's `.env.local` carries `{"worker":"opus"}` for the live fleet, which would otherwise
  // leak in and silently run the gym worker on opus (inflated cost, and a different model
  // per machine → non-reproducible, violating D-016). Callers pin a stronger worker
  // explicitly via cfg.agentModels when they want production-fidelity.
  env.AGENT_MODELS = JSON.stringify(cfg.agentModels ?? {});

  return {
    command: 'npx',
    args: ['tsx', 'bin/hono-host.ts'],
    cwd: `${cfg.pinnedCheckoutPath}/apps/operator`,
    env,
  };
}
