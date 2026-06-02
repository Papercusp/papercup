/**
 * db:migrate — the blessed path to apply a schema migration, coordinated (P-027).
 *
 * Acquires exclusive(db-schema) with a drain so in-flight schema-dependent
 * work finishes before destructive DDL runs, then applies the migration,
 * then releases. Use this instead of a raw `psql -f` so peers are coordinated.
 *
 * Safe by default: no `confirm` → DRY RUN (no lock, no psql). With confirm it
 * acquires + drains, and applies the file ONLY if PAPERCUSP_ALLOW_DB_MIGRATE=1.
 */

import { z } from 'zod';
import { spawnSync } from 'node:child_process';
import { defineTool } from '@papercusp/agent-mcp';
import { readIdentity } from '../locks/identity';
import { resolveAgentIdentity } from '../coordination/identity';
import { guardResource } from '../locks/resource-lock-guard';
import { getHarnessAdminUrl } from '@/lib/embedded-pg-discovery';
import type { ResourceHolder } from '../locks/su-lock-store';

const MAX_DRAIN_SEC = 300;
const DEFAULT_DRAIN_SEC = 60;

const SU_ROLES = [
  'scoper', 'architect', 'worker', 'validator', 'reviewer',
  'debugger', 'operator', 'documenter', 'curator',
] as const;

const json = (payload: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
});

const holderJson = (h: ResourceHolder) => ({
  owner: h.owner, owner_label: h.owner_label, mode: h.mode, status: h.status,
});

export default defineTool({
  name: 'db:migrate',
  description:
    'Apply a SQL migration file, coordinated. DRY RUN unless confirm:true. With confirm, acquires exclusive(db-schema) and drains schema-dependent work (wait:{max_drain_sec}) before running psql -f <file>, then releases. The real apply also requires PAPERCUSP_ALLOW_DB_MIGRATE=1. Prefer this over a raw psql -f.',
  guidance: {
    when: 'Applying a migration / destructive DDL that could disrupt in-flight queries. Dry-run to see holders; confirm to drain + apply.',
    notWhen: 'Read-only SQL needs no lock. Never apply migrations casually on a shared box.',
    chaining: 'db:migrate { file } (dry) → review → db:migrate { file, confirm: true }.',
  },
  capability: 'locks:write',
  timeoutSec: MAX_DRAIN_SEC + 60,
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    file: z.string().min(1).describe('Absolute path to the .sql migration file to apply.'),
    confirm: z.boolean().optional(),
    max_drain_sec: z.number().int().nonnegative().max(MAX_DRAIN_SEC).optional(),
  }),
  async handler(args, ctx) {
    if (!args.confirm) {
      return json({
        ok: true,
        dry_run: true,
        would_run: `psql <admin-url> -v ON_ERROR_STOP=1 -f ${args.file}`,
        note: 'Pass confirm:true to acquire exclusive(db-schema), drain, then apply. The real apply also requires PAPERCUSP_ALLOW_DB_MIGRATE=1.',
      });
    }

    const { ownerId, ownerLabel, coordinationDomain } = readIdentity(ctx);
    const coordIdentity = resolveAgentIdentity(ctx);
    const enabled = process.env.PAPERCUSP_ALLOW_DB_MIGRATE === '1';

    const outcome = await guardResource(
      {
        coordinationDomain,
        ownerId,
        ownerLabel,
        coordIdentity,
        resource: 'db-schema',
        mode: 'exclusive',
        maxDrainSec: args.max_drain_sec ?? DEFAULT_DRAIN_SEC,
        reason: `apply migration ${args.file}`,
      },
      async () => {
        if (!enabled) {
          return json({
            ok: true,
            drained: true,
            applied: false,
            note: 'Drain complete, but apply WITHHELD — set PAPERCUSP_ALLOW_DB_MIGRATE=1 to enable the real psql apply.',
          });
        }
        const url = getHarnessAdminUrl();
        const r = spawnSync('psql', [url, '-v', 'ON_ERROR_STOP=1', '-f', args.file], {
          encoding: 'utf8',
        });
        if (r.status !== 0) {
          return json({ ok: false, applied: false, exit_code: r.status, stderr: (r.stderr ?? '').slice(-2000) });
        }
        return json({ ok: true, drained: true, applied: true, file: args.file });
      },
    );

    if (outcome.acquired) return outcome.result;
    return json({
      ok: false,
      reason: `resource_${outcome.reason}`,
      resource: 'db-schema',
      holders: outcome.holders.map(holderJson),
    });
  },
});
