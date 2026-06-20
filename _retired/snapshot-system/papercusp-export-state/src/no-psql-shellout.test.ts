/**
 * Regression guard: no runtime-shipped code may shell out to `psql` or
 * `pg_dump` — with the single allowed exception of the snapshot subsystem's
 * `pg-dump.ts` (the per-harness / shared-schema dump) and `binaries.ts`
 * (the presence probe). Everything else must use postgres-js.
 *
 * Why: psql isn't shipped, so non-snapshot runtime code must not depend on
 * it. The snapshot capture path legitimately invokes the system `pg_dump`
 * binary (postgres-js can't produce a full schema dump); that's the only
 * sanctioned shell-out and lives behind the ALLOW set below.
 */
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import { join, relative } from 'node:path';

const ROOTS = [
  // Operator app (runtime; ships in desktop bundle)
  '/home/marsh-office/papercupai-workspace/papercup/apps/operator/app',
  '/home/marsh-office/papercupai-workspace/papercup/apps/operator/lib',
  '/home/marsh-office/papercupai-workspace/papercup/packages/operator-core/lib',
  // Snapshot subsystem
  '/home/marsh-office/papercupai-workspace/papercup/libs/papercusp-export-state/src',
  // Other shipped libs
  '/home/marsh-office/papercupai-workspace/papercup/libs/papercusp-shared/src',
];

// Allowed shell-outs — the system `pg_dump` invocation in pg-dump.ts and
// the presence-probe in binaries.ts. Plus the db:migrate tool, which IS the
// sanctioned dev-only migration applier (a lock-coordinated `psql -f` wrapper
// gated behind PAPERCUSP_ALLOW_DB_MIGRATE — psql runs full .sql files
// postgres-js can't). Everything else must use postgres-js.
const ALLOW = new Set<string>([
  'libs/papercusp-export-state/src/pg-dump.ts',
  'libs/papercusp-export-state/src/binaries.ts',
  'packages/operator-core/lib/agent-tools/db/migrate.ts',
]);

const TS_EXT = /\.(ts|tsx|mts|cts|mjs|cjs|js)$/;

async function walk(dir: string, out: string[] = []): Promise<string[]> {
  let entries: { name: string; isDir: boolean }[] = [];
  try {
    entries = (await fs.readdir(dir, { withFileTypes: true })).map((e) => ({
      name: e.name,
      isDir: e.isDirectory(),
    }));
  } catch {
    return out; // dir may not exist in some checkouts
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.next' || e.name === 'dist' || e.name.startsWith('.')) continue;
    const full = join(dir, e.name);
    if (e.isDir) await walk(full, out);
    else if (TS_EXT.test(e.name) && !/\.test\.(ts|tsx|mts|js|mjs)$/.test(e.name)) out.push(full);
  }
  return out;
}

// Catches both:
//   - direct child_process: spawn('psql', ...) / execFile('pg_dump', ...) etc.
//   - indirect-via-wrapper: runStream('pg_dump', ...) / pgRun('psql', ...) / etc.
// The second form is matched by `'psql'`/`'pg_dump'` immediately followed by
// `,` or `)` — i.e., the literal is being used as the first arg of a call.
// Comment mentions ("// psql ..." / "/* pg_dump */") aren't string literals,
// so they don't match. The bare-word check is intentionally separate from
// the verb list so wrapper functions can't smuggle a shell-out past us.
const SHELLOUT_DIRECT = /(?:spawn|spawnSync|exec|execSync|execFile|execFileSync)\s*\(\s*['"`](?:psql|pg_dump)['"`]/;
const SHELLOUT_INDIRECT = /['"`](?:psql|pg_dump)['"`]\s*[,)]/;

describe('no-psql-shellout (regression guard)', () => {
  it('snapshot subsystem and runtime-shipped code do not shell out to psql/pg_dump', async () => {
    const offenders: string[] = [];
    const repoRoot = '/home/marsh-office/papercupai-workspace/papercup';
    for (const root of ROOTS) {
      const files = await walk(root);
      for (const f of files) {
        const rel = relative(repoRoot, f);
        if (ALLOW.has(rel)) continue;
        const text = await fs.readFile(f, 'utf8');
        if (SHELLOUT_DIRECT.test(text) || SHELLOUT_INDIRECT.test(text)) {
          offenders.push(rel);
        }
      }
    }
    expect(offenders, `unexpected psql/pg_dump shell-outs (use postgres-js instead):\n  ${offenders.join('\n  ')}`).toEqual([]);
  });
});
