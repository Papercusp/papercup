/**
 * Extra env for invoke-once spawns from the durable pipeline
 * (`dbos-retire-legacy-orchestrator-2026-05-31` P-008 fix).
 *
 * The crux: `harnessSlug(projectDir)` in the orchestrator resolves the slug via
 * `HARNESS_SLUG` env → a registry curl to `:3055/api/harness/projects` →
 * `basename(projectDir)`. In the DBOS-spawned context the env was unset AND the
 * `:3055` registry curl fails (the operator moved to Vite; that route is on the
 * Hono host now), so it fell back to the directory basename — e.g. `sheets-clone`
 * instead of the registry slug `sheets` → `search_path=harness_sheets_clone`
 * (a schema that doesn't exist) → the director reads no feature state and exits
 * with EMPTY output (the "decide invoke failed exit=0 empty=true" ERROR).
 *
 * The runner/finalizer already know the authoritative registry slug (it's how
 * `resolveProject` found the path), so we pass it explicitly as `HARNESS_SLUG` —
 * `harnessSlug()` prefers the env over basename, fixing the schema resolution.
 */
export interface PipelineSpawnEnvInput {
  /** The authoritative registry slug (NOT the dir basename). */
  harnessSlug: string;
  /** Idempotency key for an agent run (omit for finalizer curator/documenter). */
  idempotencyKey?: string;
  /** Workspace to pin the spawn to (the pipeline's captured workspace). */
  workspaceId?: string;
}

export function buildPipelineExtraEnv(input: PipelineSpawnEnvInput): Record<string, string> {
  const env: Record<string, string> = {
    // Force the registry slug so invoke-once's pg-bootstrap uses harness_<slug>
    // (correct schema), never basename(projectDir).
    HARNESS_SLUG: input.harnessSlug,
    // P-040: this spawn is under the DBOS orchestrator (cross-feature concurrency),
    // so the worker chunk-loop routes its file claims through the PG-backed
    // SuLocksCoordinator (the same backend locks:* uses) instead of the in-process
    // FileLockQueue. Only set on pipeline spawns — the single-feature / manual /
    // test path stays in-process. invoke-once also requires DATABASE_URL (set by
    // buildInvokeOnce) before it actually uses the PG backend.
    PAPERCUSP_CHUNK_LOCK_PG: '1',
  };
  if (input.idempotencyKey) env.IDEMPOTENCY_KEY = input.idempotencyKey;
  if (input.workspaceId) env.PAPERCUSP_WORKSPACE_ID = input.workspaceId;
  return env;
}
