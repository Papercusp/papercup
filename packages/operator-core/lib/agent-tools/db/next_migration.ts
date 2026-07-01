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
 *   next = GREATEST(max-on-disk, max-reserved-in-ledger, max-applied) + 1
 * recorded atomically in harness_shared.migration_reservations. Folding in the
 * filesystem max means even an UNRESERVED on-disk file (a peer who wrote
 * NNN-*.sql without reserving) is still respected.
 *
 * EI-353: the disk leg scans BOTH the serving checkout and the canonical
 * integration tree — the deployed operator (:3070) runs from the release tree,
 * which lags staging, so a freshly-written staging migration was invisible and
 * 233 got handed out twice. The applied set (schema_migrations) is the third
 * GREATEST input: an applied filename's number is taken by definition, even if
 * its file is absent from every scanned tree and it was never reserved.
 */

import { z } from 'zod';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { resolveSqlDir } from '../../migration-drift';
import { resolveAgentIdentity } from '../coordination/identity';

// Fixed advisory-lock key for migration-number allocation — serialises
// concurrent db:next-migration calls across connections/processes.
const ALLOC_ADVISORY_KEY = 873_135;

const json = (payload: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
});

/** Highest leading-number among `NNN-*.sql` files across the dirs (0 if none). */
function maxNumberOnDisk(sqlDirs: string[]): number {
  let max = 0;
  for (const dir of sqlDirs) {
    for (const f of fs.readdirSync(dir)) {
      const m = /^(\d+)-/.exec(f);
      if (m) max = Math.max(max, Number.parseInt(m[1]!, 10));
    }
  }
  return max;
}

/**
 * Sql dirs to scan for the filesystem max. The serving checkout's dir alone is
 * not enough (EI-353): on the deployed :3070 host the serving tree is the
 * release checkout, which lags the canonical staging tree, so a migration just
 * written there is invisible to a cwd-relative scan. PAPERCUSP_INTEGRATION_ROOT
 * (exported into the operator's unit env — see release-config.ts) names the
 * canonical tree; fold its sql dir in when present.
 */
function candidateSqlDirs(): string[] {
  const dirs = new Set<string>();
  const serving = resolveSqlDir();
  if (serving) dirs.add(serving);
  const integrationRoot = process.env.PAPERCUSP_INTEGRATION_ROOT?.trim();
  if (integrationRoot) {
    const canonical = path.resolve(integrationRoot, 'libs/papercusp/libs/db/sql');
    if (fs.existsSync(canonical)) dirs.add(canonical);
  }
  return [...dirs];
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
    'Atomically reserve the next migration number for a libs/papercusp/libs/db/sql/<NNN>-*.sql file. Hands out GREATEST(max-on-disk across the serving + canonical staging trees, max-reserved, max-applied)+1 under a pg advisory lock so two agents racing `ls | tail` never collide. Returns the number + a suggested filename/path; write the file there and it auto-applies on the next operator restart (A1 boot-apply).',
  guidance: {
    when: 'BEFORE creating a new SQL migration file — reserve the number first instead of `ls | tail`, so a concurrent agent cannot pick the same NNN.',
    notWhen: 'Applying a migration (that is the boot auto-apply / db:migrate) or checking drift (db:check_drift).',
    chaining: 'db:next-migration { name } → write the returned path → restart the operator (boot auto-applies) or db:migrate.',
    seeAlso: [
      'db:migrate (apply the migration you wrote)',
      'db:check_drift (check drift after applying)',
    ],
  },
  capability: 'locks:write',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
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
    const sqlDirs = candidateSqlDirs();
    if (sqlDirs.length === 0)
      return json({ ok: false, error: 'sql dir (libs/papercusp/libs/db/sql) not found' });

    const fsMax = maxNumberOnDisk(sqlDirs);
    const { ownerLabel } = resolveAgentIdentity(ctx);
    const slug = slugify(args.name ?? '');
    const { sql } = getOrgPg();

    const allocated = await sql.begin(async (tx) => {
      // Serialise concurrent allocations — the advisory lock is held for the
      // txn, so the read-compute-insert below is atomic across callers.
      await tx`SELECT pg_advisory_xact_lock(${ALLOC_ADVISORY_KEY})`;
      const rows = await tx<{ next: number }[]>`
        SELECT GREATEST(
                 ${fsMax},
                 COALESCE((SELECT MAX(num) FROM harness_shared.migration_reservations), 0),
                 -- An APPLIED migration's number is taken by definition, even when
                 -- its file is in no scanned tree and was never reserved (EI-353).
                 COALESCE((SELECT MAX(substring(filename FROM '^([0-9]+)-')::int)
                             FROM harness_shared.schema_migrations
                            WHERE filename ~ '^[0-9]+-'), 0)
               ) + 1 AS next`;
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
