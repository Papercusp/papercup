/**
 * Real GymRunnerPorts adapter (P-001 wiring) — binds the smoke-PROVEN operations into
 * the GymRunnerPorts interface that the tested runGymPipeline orchestration consumes.
 *
 *   cloneSubstrate          → git clone + checkout --detach (execFile, no shell)
 *   registerThrowawayHarness→ POST /api/harness/projects (scaffolds harness_<slug>)
 *   applyPromptOverride     → gym-PG upsert harness_shared.harness_prompt_overrides
 *   fileFeature             → gym-PG insert harness_features_consolidated (avoids the
 *                              legacy SQLite /features/import path)
 *   startPipeline           → POST /api/admin/dbos/pipeline/start?superuser=1 + bearer
 *   pollStatus              → gym-PG dbos.workflow_status + harness_features_consolidated
 *   teardownHarness         → gym-PG DROP SCHEMA + clear overrides + rm clone
 *
 * I/O is injectable (fetch/exec/rm default to real) so the HTTP + exec ports are unit-
 * testable; the gym-PG ports are validated by the boot smoke / P-014. NOTE: gym-PG
 * jsonb reads come back as strings (none read here). Slugs are gym-prefixed hyphen-free
 * → safe to splice into the DROP SCHEMA identifier.
 */
import { execFile as execFileCb } from 'node:child_process';
import { rm as rmCb } from 'node:fs';
import { promisify } from 'node:util';
import type { Sql } from 'postgres';
import { buildSubstrateCloneCommands } from './clone';
import type { GymRunnerPorts } from './gym-runner';

const execFileP = promisify(execFileCb);
const rmP = promisify(rmCb);

const SAFE_SLUG = /^[a-z0-9]+$/;

export interface GymRunnerPortsConfig {
  /** Base URL of the dedicated gym-operator, e.g. http://127.0.0.1:3971. */
  operatorBaseUrl: string;
  /** A postgres-js client connected to the gym PG. */
  gymSql: Sql;
  /** Superuser bearer (from ~/.papercusp/superuser-token) for the admin route. */
  superuserToken: string;
  /** The gym operator's pinned workspace (used to scope filed features). */
  workspaceId: string;
  fetchFn?: typeof fetch;
  exec?: (cmd: string, args: string[]) => Promise<void>;
  rm?: (path: string) => Promise<void>;
}

export function createGymRunnerPorts(cfg: GymRunnerPortsConfig): GymRunnerPorts {
  const doFetch = cfg.fetchFn ?? fetch;
  const exec = cfg.exec ?? (async (cmd: string, args: string[]) => { await execFileP(cmd, args); });
  const rm = cfg.rm ?? (async (p: string) => { await rmP(p, { recursive: true, force: true }); });
  const sql = cfg.gymSql;

  return {
    async cloneSubstrate({ source, commit, destDir }) {
      const { commands } = buildSubstrateCloneCommands({ source, commit, destDir });
      for (const c of commands) await exec(c.argv[0], c.argv.slice(1));
    },

    async registerThrowawayHarness({ slug, clonePath }) {
      const res = await doFetch(`${cfg.operatorBaseUrl}/api/harness/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug, path: clonePath }),
      });
      if (!res.ok) throw new Error(`registerThrowawayHarness ${slug} → ${res.status}: ${await res.text()}`);
      // The route returns HTTP 200 even when scaffoldHarnessSchema() throws — it
      // reports the failure as `provisioning:{ok:false,error}`. A swallowed scaffold
      // failure means the per-harness `harness_features` VIEW is never created, and
      // the worker's `UPDATE harness_features` 42P01s deep in the pipeline. Fail loud
      // HERE so the gym surfaces the real cause at registration, not as a mystery
      // mid-run error. (Missing/true `provisioning` → success: non-scaffold paths.)
      const body = (await res.json().catch(() => ({}))) as { provisioning?: { ok?: boolean; error?: string } };
      if (body.provisioning && body.provisioning.ok === false) {
        throw new Error(`registerThrowawayHarness ${slug}: schema scaffold failed: ${body.provisioning.error ?? 'unknown error'}`);
      }
    },

    async applyPromptOverride({ workspaceId, slug, role, promptMd }) {
      await sql`
        INSERT INTO harness_shared.harness_prompt_overrides (workspace_id, harness_slug, role, prompt_md, updated_at)
        VALUES (${workspaceId}, ${slug}, ${role}, ${promptMd}, ${Date.now()})
        ON CONFLICT (workspace_id, harness_slug, role) DO UPDATE
          SET prompt_md = EXCLUDED.prompt_md, updated_at = EXCLUDED.updated_at`;
    },

    async fileFeature({ slug, featureId, spec }) {
      await sql`
        INSERT INTO harness_shared.harness_features_consolidated (harness_slug, feature_id, workspace_id, title, status, summary)
        VALUES (${slug}, ${featureId}, ${cfg.workspaceId}, ${featureId}, ${'todo'}, ${spec})
        ON CONFLICT (harness_slug, feature_id) DO NOTHING`;
    },

    async startPipeline({ slug, featureId }) {
      const res = await doFetch(`${cfg.operatorBaseUrl}/api/admin/dbos/pipeline/start?superuser=1`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.superuserToken}` },
        body: JSON.stringify({ harnessSlug: slug, featureId }),
      });
      if (!res.ok) throw new Error(`startPipeline ${slug}/${featureId} → ${res.status}: ${await res.text()}`);
      const body = (await res.json()) as { workflowID?: string };
      if (!body.workflowID) throw new Error(`startPipeline returned no workflowID`);
      return { workflowID: body.workflowID };
    },

    async pollStatus({ workflowID, slug, featureId }) {
      const wf = await sql<{ status: string }[]>`
        SELECT status FROM dbos.workflow_status WHERE workflow_uuid = ${workflowID} LIMIT 1`;
      const feat = await sql<{ status: string }[]>`
        SELECT status FROM harness_shared.harness_features_consolidated
         WHERE harness_slug = ${slug} AND feature_id = ${featureId} LIMIT 1`;
      return { workflowStatus: wf[0]?.status ?? 'PENDING', featureStatus: feat[0]?.status ?? null };
    },

    async teardownHarness({ slug, clonePath, workspaceId }) {
      if (SAFE_SLUG.test(slug)) {
        await sql.unsafe(`DROP SCHEMA IF EXISTS harness_${slug} CASCADE`).catch(() => {});
      }
      await sql`DELETE FROM harness_shared.harness_prompt_overrides WHERE workspace_id = ${workspaceId} AND harness_slug = ${slug}`.catch(() => {});
      await sql`DELETE FROM harness_shared.harness_features_consolidated WHERE harness_slug = ${slug}`.catch(() => {});
      await rm(clonePath).catch(() => {});
    },

    now: () => Date.now(),
    sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
  };
}
