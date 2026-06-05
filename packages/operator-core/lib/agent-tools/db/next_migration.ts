/**
 * db:next-migration — atomically allocate the next migration number
 * (handoff-coordination-dx-followups-2026-06-04 §A1).
 *
 * Agents pick the next `NNN` for a `libs/papercusp/libs/db/sql/<NNN>-*.sql`
 * file by `ls | tail`, so two agents racing both choose the same number — and
 * on the native :5432 box only one of the colliding files applies, so a table
 * goes silently dark (seen this session: two `131-*.sql`, and a live 134 race).
 *
 * This hands out a guaranteed-unique number under a pg advisory lock:
 *   next = GREATEST(max-number-on-disk, max-reserved-in-ledger) + 1
 * recorded atomically in harness_shared.migration_reservations. Folding in the
 * filesystem max means even an UNRESERVED on-disk file (a peer who wrote
 * NNN-*.sql without reserving) is still respected.
 */

import { z } from 'zod';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { defineTool } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { resolveSqlDir } from '../../migration-drift';
import { resolveAgentIdentity } from '../coordination/identity';

const SU_ROLES = [
  'scoper', 'architect', 'worker', 'validator', 'reviewer',
  'debugger', 'operator', 'documenter', 'curator',
] as const;

// Fixed advisory-lock key for migration-number allocation — serialises
// concurrent db:next-migration calls across connections/processes.
const ALLOC_ADVISORY_KEY = 873_135;

const json = (payload: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
});

/** Highest leading-number among `NNN-*.sql` files in the dir (0 if none). */
function maxNumberOnDisk(sqlDir: string): number {
  let max = 0;
  for (const f of fs.readdirSync(sqlDir)) {
    const m = /^(\d+)-/.exec(f);
    if (m) max = Math.max(max, Number.parseInt(m[1]!, 10));
  }
  return max;
}

function slugify(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'TODO-rename'
  );
}

export default defineTool({
  name: 'db:next-migration',
  description:
    'Atomically reserve the next migration number for a libs/papercusp/libs/db/sql/<NNN>-*.sql file. Hands out GREATEST(max-on-disk, max-reserved)+1 under a pg advisory lock so two agents racing `ls | tail` never collide. Returns the number + a suggested filename/path; write the file there and it auto-applies on the next operator restart (A1 boot-apply).',
  guidance: {
    when: 'BEFORE creating a new SQL migration file — reserve the number first instead of `ls | tail`, so a concurrent agent cannot pick the same NNN.',
    notWhen: 'Applying a migration (that is the boot auto-apply / db:migrate) or checking drift (db:check_drift).',
    chaining: 'db:next-migration { name } → write the returned path → restart the operator (boot auto-applies) or db:migrate.',
  },
  capability: 'locks:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    name: z
      .string()
      .optional()
      .describe('Short kebab-case description for the suggested filename, e.g. "add-foo-index".'),
    intent: z
      .string()
      .optional()
      .describe('One line on what the migration does — recorded in the ledger so peers see what this NNN is for.'),
  }),
  async handler(args, ctx) {
    const sqlDir = resolveSqlDir();
    if (!sqlDir) return json({ ok: false, error: 'sql dir (libs/papercusp/libs/db/sql) not found' });

    const fsMax = maxNumberOnDisk(sqlDir);
    const { ownerLabel } = resolveAgentIdentity(ctx);
    const slug = slugify(args.name ?? '');
    const { sql } = getOrgPg();

    const allocated = await sql.begin(async (tx) => {
      // Serialise concurrent allocations — the advisory lock is held for the
      // txn, so the read-compute-insert below is atomic across callers.
      await tx`SELECT pg_advisory_xact_lock(${ALLOC_ADVISORY_KEY})`;
      const rows = await tx<{ next: number }[]>`
        SELECT GREATEST(${fsMax}, COALESCE(MAX(num), 0)) + 1 AS next
          FROM harness_shared.migration_reservations`;
      const next = Number(rows[0]!.next);
      const filename = `${String(next).padStart(3, '0')}-${slug}.sql`;
      await tx`
        INSERT INTO harness_shared.migration_reservations (num, filename, reserved_by, intent)
        VALUES (${next}, ${filename}, ${ownerLabel}, ${args.intent ?? null})`;
      return { next, filename };
    });

    return json({
      ok: true,
      number: allocated.next,
      suggested_filename: allocated.filename,
      path: path.posix.join('libs/papercusp/libs/db/sql', allocated.filename),
      reserved_by: ownerLabel,
      note: 'Reserved. Write the migration at this path; it auto-applies on the next operator restart (A1 native boot-apply), or via db:migrate for a one-off.',
    });
  },
});
