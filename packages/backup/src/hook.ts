/**
 * Pre-snapshot DB dump hook for a workspace.
 *
 * Writes transactionally-consistent per-database dumps of the workspace's live DBs
 * into `<workspaceRoot>/db-dumps/` so kopia captures them in the same
 * snapshot as the file tree. Restoration path:
 *   1. Restore the snapshot to a clone.
 *   2. `gzip -d` and `psql -f` the dumps into a fresh PG to rebuild
 *      live DB state (faster + more robust than restoring the raw
 *      data dir).
 *
 * The hook only handles per-workspace state. Host PG (:5432) and host
 * sqlite (Restart harness DBs) are the systemd kopia job's concern,
 * not this one.
 *
 * Failure modes:
 *   - PG not running: log + skip, snapshot still proceeds.
 *   - sqlite locked: log + skip, snapshot still proceeds.
 * Never throws — losing a dump is better than losing the snapshot.
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createWriteStream } from 'node:fs';
import { appendFile } from 'node:fs/promises';

interface HookContext {
  workspaceId: string;
  workspaceRoot: string;
}

// Embedded PG port is no longer fixed — desktop picks at boot and writes
// it to ~/.papercusp/embedded-pg.json (or honors PAPERCUSP_PG_PORT env).
// Use the discovery helper instead of a hardcoded port.
import { backupHost } from './config';

// Keep the hot-state dump bounded and restorable. A full database dump on the
// standing dev box includes multi-GB telemetry/audit streams and plugin schemas
// the harness_admin role cannot read; that made the hook produce only a tiny
// pg_dumpall header while logging success. The release-critical state we need to
// prove in restore drills lives in these durable tables: harness registry,
// plans, work items, backup metadata, and operator/hive settings.
const CRITICAL_TABLES = [
  'harness_shared.harness_registry',
  'harness_shared.hive_settings',
  'harness_shared.operator_settings',
  'harness_shared.orchestrator_settings',
  'harness_shared.pr_reviewer_settings',
  'harness_shared.workspace_backup_settings',
  'harness_shared.backup_snapshots',
  'harness_shared.harness_plans',
  'harness_shared.harness_plan_parts',
  'harness_shared.harness_plan_status',
  'harness_shared.plan_revisions',
  'harness_shared.plan_item_assignments',
  'harness_shared.plan_item_claims',
  'harness_shared.work_items',
] as const;

/**
 * gzip args for the PG dump. `--rsyncable` inserts periodic flush
 * points so an unchanged region of the dump compresses to a stable
 * byte range — which lets kopia's content-defined chunker dedup it
 * across the snapshot cadence. Without it, gzip's output shifts
 * wholesale on any input change and every 5-minute snapshot stores a
 * fresh full copy of the dump (this was a contributor to repo bloat).
 *
 * GNU gzip supports the flag; BSD gzip (macOS) does not — probe once
 * and cache. On BSD we fall back to plain `-1`; kopia still chunks the
 * raw gzip stream, just with worse dedup.
 */
let _gzipRsyncable: boolean | null = null;
function gzipArgs(): string[] {
  if (_gzipRsyncable === null) {
    try {
      const probe = spawnSync('gzip', ['--help'], { encoding: 'utf8' });
      _gzipRsyncable = /--rsyncable/.test(`${probe.stdout ?? ''}${probe.stderr ?? ''}`);
    } catch {
      _gzipRsyncable = false;
    }
  }
  return _gzipRsyncable ? ['-1', '--rsyncable'] : ['-1'];
}

export async function runPreSnapshotHook(ctx: HookContext): Promise<void> {
  const dumpDir = join(ctx.workspaceRoot, 'db-dumps');
  await mkdir(dumpDir, { recursive: true });
  const logPath = join(dumpDir, 'hook.log');

  const log = async (msg: string) => {
    await appendFile(logPath, `[${new Date().toISOString()}] ${msg}\n`).catch(() => {});
  };

  // --- embedded-pg (port discovered at runtime) ---
  const { url, source } = backupHost().getHarnessAdminUrl();
  await log(`embedded-pg URL source: ${source}`);
  const parsed = new URL(url);
  await dumpPg({
    host: parsed.hostname,
    port: Number(parsed.port) || 5432,
    user: parsed.username || 'postgres',
    password: decodeURIComponent(parsed.password || 'postgres'),
    database: decodeURIComponent(parsed.pathname.replace(/^\//, '')) || 'papercusp',
    outPath: join(dumpDir, 'pg-embedded.sql.gz'),
    log,
  });

  await log('hook done');
}

async function dumpPg(opts: {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  outPath: string;
  log: (msg: string) => Promise<void>;
}): Promise<void> {
  const tmp = `${opts.outPath}.tmp`;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PGPASSWORD: opts.password,
    PGCONNECT_TIMEOUT: '5',
  };
  await new Promise<void>((resolve) => {
    const dump = spawn('pg_dump', [
      '-h', opts.host,
      '-p', String(opts.port),
      '-U', opts.user,
      '-w',
      '-d', opts.database,
      '--no-owner',
      '--no-privileges',
      ...CRITICAL_TABLES.flatMap((table) => ['-t', table]),
    ], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const gz = spawn('gzip', gzipArgs(), { stdio: ['pipe', 'pipe', 'pipe'] });
    const out = createWriteStream(tmp);

    dump.stdout.pipe(gz.stdin);
    gz.stdout.pipe(out);
    let stderr = '';
    dump.stderr.on('data', (d) => { stderr += d.toString(); });
    gz.stderr.on('data', (d) => { stderr += d.toString(); });

    const t = setTimeout(() => { dump.kill('SIGKILL'); gz.kill('SIGKILL'); }, 60_000);
    let settled = false;
    const finalize = async (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      if (!out.destroyed) out.end();
      if (ok) {
        try {
          const s = await stat(tmp);
          if (s.size > 100) {
            await renameAtomic(tmp, opts.outPath);
            await opts.log(`pg ${opts.host}:${opts.port} ok (${s.size} bytes)`);
          } else {
            await opts.log(`pg ${opts.host}:${opts.port} SKIP (empty dump): ${stderr.trim().slice(0, 200)}`);
          }
        } catch (e) {
          await opts.log(`pg ${opts.host}:${opts.port} FAIL stat: ${String(e)}`);
        }
      } else {
        await opts.log(`pg ${opts.host}:${opts.port} FAIL: ${stderr.trim().slice(0, 200)}`);
      }
      resolve();
    };

    // A missing binary (pg_dump / gzip) makes Node emit an 'error'
    // event on the child; with no listener that crashes the operator
    // process. Route it through finalize(false) so the snapshot still
    // proceeds without the dump.
    dump.on('error', (e) => {
      stderr += `pg_dump spawn failed: ${e.message}\n`;
      try { gz.kill('SIGKILL'); } catch { /* already gone */ }
      void finalize(false);
    });
    gz.on('error', (e) => {
      stderr += `gzip spawn failed: ${e.message}\n`;
      try { dump.kill('SIGKILL'); } catch { /* already gone */ }
      void finalize(false);
    });
    // The output file stream fails independently of the children —
    // disk full (ENOSPC), bad path (EISDIR/EACCES). An unhandled
    // stream 'error' crashes the operator just like an unhandled child
    // spawn error, so route it through finalize(false) too.
    out.on('error', (e) => {
      stderr += `output stream failed: ${e.message}\n`;
      try { dump.kill('SIGKILL'); } catch { /* already gone */ }
      try { gz.kill('SIGKILL'); } catch { /* already gone */ }
      void finalize(false);
    });

    let dumpClosed = false;
    let gzipClosed = false;
    let dumpCode: number | null = null;
    let gzipCode: number | null = null;
    const maybeFinalize = () => {
      if (dumpClosed && gzipClosed) {
        void finalize(dumpCode === 0 && gzipCode === 0);
      }
    };
    dump.on('close', (code: number | null) => {
      dumpClosed = true;
      dumpCode = code;
      if (code !== 0) stderr += `pg_dump exited ${code ?? 'null'}\n`;
      maybeFinalize();
    });
    gz.on('close', (code: number | null) => {
      gzipClosed = true;
      gzipCode = code;
      if (code !== 0) stderr += `gzip exited ${code ?? 'null'}\n`;
      maybeFinalize();
    });
  });
}

async function renameAtomic(from: string, to: string): Promise<void> {
  const { rename, unlink } = await import('node:fs/promises');
  try { await unlink(to); } catch { /* fine */ }
  await rename(from, to);
}
