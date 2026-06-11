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
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { checkMigrationDrift } from '../../migration-drift';

export default defineTool({
  name: 'db:check_drift',
  description:
    'Report DB migration drift — sql/*.sql files not yet applied (per harness_shared.schema_migrations). Detection only. `missing` = added since the last operator boot; restart the operator (boot auto-applies) or use db:migrate. `extra` = applied but file gone (investigate).',
  guidance: {
    when: 'After adding a migration, or when a runtime "missing column/relation" error suggests the live DB lags the sql/ dir.',
    notWhen: 'Applying a migration — that is the boot auto-apply (restart) or db:migrate for a one-off.',
    chaining: 'missing non-empty → restart the operator (or db:migrate the file under exclusive(db-schema)).',
  },
  capability: 'locks:read',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES, 'bee'],
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
          }),
        },
      ],
    };
  },
});
