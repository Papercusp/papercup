/**
 * db:check_drift — report migration drift (plan fleet-coordination-painpoints,
 * P-005). DETECTION ONLY: which `libs/papercusp/libs/db/sql/*.sql` files are
 * not yet recorded in `harness_shared.schema_migrations` on the live DB.
 *
 * Migrations auto-apply on operator boot, but the :3070 host has no hot-reload,
 * so a migration added since the last restart shows here as `missing` until
 * the operator restarts (or `db:migrate` applies it). `extra` (applied but the
 * file is gone) is unusual — investigate.
 */

import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { checkMigrationDrift } from '../../migration-drift';

export default defineTool({
  name: 'db:check_drift',
  description:
    'Report DB migration drift — sql/*.sql files not yet applied (per harness_shared.schema_migrations). Detection only. Checks BOTH the tree serving this call AND the canonical staging tree agents author migrations in (EI-18757486483124756) — `in_sync` is false if EITHER lags. `missing`/`missing_canonical` = added since the last operator boot; restart the operator (boot auto-applies) or use db:migrate. `extra` = applied but file gone (investigate). `content_drift` = applied migrations whose bytes CHANGED after they ran (EI-19365742982915607) — the edit never executed and no restart will run it; repair with a NEW migration. `schema_ahead` = the DB was migrated by a newer tree than this one.',
  guidance: {
    when: 'After adding a migration, or when a runtime "missing column/relation" error suggests the live DB lags the sql/ dir.',
    notWhen: 'Applying a migration — that is the boot auto-apply (restart) or db:migrate for a one-off.',
    chaining:
      "missing or missing_canonical non-empty → restart the operator (or db:migrate the file under exclusive(db-schema)). " +
      "EI-18757486483124756: `sql_dir` is whichever tree served THIS call (often the RELEASE checkout, e.g. via the " +
      "papercusp-su MCP endpoint) — `canonical_sql_dir` is the SEPARATE staging tree agents author migrations in " +
      "(resolved via PAPERCUSP_INTEGRATION_ROOT, independent of `sql_dir`). `missing_canonical` is scanned against " +
      "that canonical tree directly, so a migration you JUST wrote in staging is caught there even when `sql_dir` " +
      "points elsewhere and its own `missing` reads clean — `in_sync` is false whenever either is non-empty.",
    seeAlso: [
      'db:migrate (apply a pending migration)',
      'db:next-migration (scaffold the next migration file)',
    ],
  },
  capability: 'locks:read',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  args: z.object({}),
  async handler() {
    const d = await checkMigrationDrift();
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            in_sync: d.inSync,
            missing: d.missing,
            extra: d.extra,
            on_disk_count: d.onDisk.length,
            applied_count: d.applied.length,
            sql_dir: d.sqlDir,
            // EI-18757486483124756: independent of `sql_dir` — the canonical
            // tree every agent authors migrations in, so `in_sync` can no
            // longer read true while a just-authored migration sits
            // unapplied there, regardless of which tree served this call.
            canonical_sql_dir: d.canonicalStagingSqlDir,
            missing_canonical: d.missingCanonical,
            // EI-19365742982915607: applied migrations edited AFTER they ran.
            // Never self-heals — no restart re-runs a recorded migration — so
            // the file on disk silently misdescribes the live schema until a
            // NEW migration re-applies it. Deliberately does not gate
            // `in_sync` (see MigrationDrift.contentDrift).
            content_drift: d.contentDrift,
            content_drift_sql_dir: d.contentDriftSqlDir,
            // WI-5050: applied migrations numbered beyond this tree's max —
            // the shared DB was migrated by a NEWER tree, so this tree's
            // queries can hit "relation does not exist". Computed since
            // WI-5050 but never surfaced until now.
            schema_ahead: d.schemaAhead,
          }),
        },
      ],
    };
  },
});
