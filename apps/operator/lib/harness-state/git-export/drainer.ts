/**
 * Git-export drainer (plan harness-state-storage-unification-2026-06-01, P-003b).
 *
 * Reads undrained `git_export_outbox` rows for a (workspace, harness) and
 * projects each into a `.harness/state/<dir>/<key>.{md|json}` file (put) or
 * removes it (del), via the pure serialize module, then marks `exported_at`.
 * At-least-once: a row is marked exported ONLY after its file write resolves.
 *
 * Git COMMIT of the written files is intentionally NOT done here — pass an
 * `onChanged` hook (the boot wiring supplies a debounced committer) so this
 * module stays pure-IO + unit/integration testable without a git repo.
 */
import type postgres from 'postgres';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { gitFilePath, serializeRow } from './serialize';

export interface DrainGitExportOpts {
  sql: postgres.Sql;
  workspaceId: string;
  harnessSlug: string;
  /** Absolute harness root (where `.harness/state/` lives). */
  harnessRoot: string;
  /** Max rows per drain. Default 500. */
  limit?: number;
  /** Called with the set of changed repo-relative paths after a successful drain. */
  onChanged?: (relPaths: string[]) => void | Promise<void>;
  /** Clock override (epoch ms) for the exported_at stamp — tests. */
  now?: number;
}

export interface GitExportResult {
  exported: number;
  deleted: number;
  changedPaths: string[];
}

/** Drain one batch of git-export outbox rows for (workspace, harness). */
export async function drainGitExportOnce(opts: DrainGitExportOpts): Promise<GitExportResult> {
  const { sql, workspaceId, harnessSlug, harnessRoot, limit = 500 } = opts;
  const rows = await sql<
    { id: number; table_name: string; op: 'put' | 'del'; key: string; row: Record<string, unknown> | null }[]
  >`
    SELECT id, table_name, op, key, row
      FROM harness_shared.git_export_outbox
     WHERE workspace_id = ${workspaceId}
       AND harness_slug = ${harnessSlug}
       AND exported_at IS NULL
     ORDER BY id ASC
     LIMIT ${limit}`;

  let exported = 0;
  let deleted = 0;
  const changedPaths: string[] = [];

  for (const r of rows) {
    const rel = gitFilePath(r.table_name, r.key);
    const abs = join(harnessRoot, rel);
    if (r.op === 'del') {
      await rm(abs, { force: true });
      deleted += 1;
    } else {
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, serializeRow(r.table_name, r.row ?? {}), 'utf8');
      exported += 1;
    }
    changedPaths.push(rel);
    // mark exported ONLY after the file op resolved (at-least-once).
    const stamp = opts.now ?? Date.now();
    await sql`UPDATE harness_shared.git_export_outbox SET exported_at = ${stamp} WHERE id = ${r.id}`;
  }

  if (changedPaths.length > 0 && opts.onChanged) await opts.onChanged(changedPaths);
  return { exported, deleted, changedPaths };
}
