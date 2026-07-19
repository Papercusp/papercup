/**
 * Pre-snapshot DB dump hook for a workspace.
 *
 * Writes transactionally-consistent per-database dumps of the workspace's live DBs
 * into `<workspaceRoot>/db-dumps/` so kopia captures them in the same
 * snapshot as the file tree. Restoration path:
 *   1. Restore the snapshot to a clone.
 *   2. Import `pg-embedded.sql.gz` into a fresh PG via
 *      `scripts/restore-pg-dump.sh` (faster + more robust than restoring
 *      the raw data dir). Don't hand-roll `gzip -d` + `psql -f` — PG18's
 *      pg_dump wraps the dump in `\restrict`/`\unrestrict` markers that
 *      desync plain psql's COPY parser part-way through and eventually
 *      OOM it (EI-13868), and the import needs a superuser-capable role
 *      to run the dump's `CREATE EXTENSION` statements. The script strips
 *      the markers (safe for this self-generated, trusted dump) and runs
 *      the import as a superuser — see that script for the full story.
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
import { mkdir, stat, statfs, unlink } from 'node:fs/promises';
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
// the harness_admin role cannot read; pg_dumpall also needs pg_authid privileges
// harness_admin deliberately lacks. Dump the complete harness_shared SCHEMA so a
// clean restore gets functions/triggers/indexes, but omit DATA for high-volume,
// derived telemetry tables. Release-critical state (plans, work items, backup
// metadata, settings, etc.) remains included with data.
const EXCLUDED_TABLE_DATA = [
  'harness_shared.route_invocations',
  'harness_shared.tool_invocations',
  'harness_shared.harness_run_output',
  'harness_shared.test_runs',
  'harness_shared.session_turns',
  'harness_shared.decision_ledger',
  'harness_shared.agent_activity',
  'harness_shared.coord_event_log',
  'harness_shared.operator_turns',
  'harness_shared.pot_throughput_ticks',
  'harness_shared.substrate_outbox',
  'harness_shared.pipeline_events',
  'harness_shared.operator_curation_log',
  'harness_shared.backup_events',
  'harness_shared.memory_vec_openai',
  'harness_shared.event_wake_deliveries',
  'harness_shared.shared_presence',
  'harness_shared.benchmark_rollout',
  'harness_shared.benchmark_run_result',
  'harness_shared.spawned_agents',
  'harness_shared.agent_usage_samples',
  'harness_shared.telemetry_reports_archive',
  'harness_shared.audit_log',
] as const;

const MIN_RESTORABLE_DUMP_BYTES = 10_000;
const PG_DUMP_TIMEOUT_MS = 15 * 60_000;
const GIB = 1024n * 1024n * 1024n;

export interface PreSnapshotHookResult {
  ok: boolean;
  bytes?: number;
  error?: string;
}

/**
 * Keep enough space to finish a dump and leave the host recoverable. The
 * percentage keeps this usable on smaller desktop disks; the 100GiB ceiling
 * prevents an unnecessarily large reserve on workstation volumes.
 */
function requiredFreeBytes(totalBytes: bigint): bigint {
  const tenPercent = totalBytes / 10n;
  return tenPercent < 10n * GIB
    ? 10n * GIB
    : tenPercent > 100n * GIB
      ? 100n * GIB
      : tenPercent;
}

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

// Every workspace currently draws from the same harness_shared database.
// Serialize dump pipelines process-wide so multiple due workspaces cannot each
// drive pg_dump+gzip against the host at once. The tail always recovers, so one
// degraded dump cannot poison future work.
let dumpQueue: Promise<void> = Promise.resolve();

export function runPreSnapshotHook(ctx: HookContext): Promise<PreSnapshotHookResult> {
  const run = dumpQueue.then(() => runPreSnapshotHookNow(ctx));
  dumpQueue = run.then(() => undefined, () => undefined);
  return run;
}

async function runPreSnapshotHookNow(ctx: HookContext): Promise<PreSnapshotHookResult> {
  const dumpDir = join(ctx.workspaceRoot, 'db-dumps');
  await mkdir(dumpDir, { recursive: true });
  const logPath = join(dumpDir, 'hook.log');

  const log = async (msg: string) => {
    await appendFile(logPath, `[${new Date().toISOString()}] ${msg}\n`).catch(() => {});
  };

  // The dump is written beside the workspace, not in the Kopia repository.
  // Refuse before spawning pg_dump when that filesystem is already in its
  // emergency reserve. This prevents backup work from turning low space into
  // an unrecoverable ENOSPC incident.
  try {
    const fs = await statfs(ctx.workspaceRoot);
    const blockSize = BigInt(fs.bsize);
    const freeBytes = blockSize * BigInt(fs.bavail);
    const totalBytes = blockSize * BigInt(fs.blocks);
    const reserveBytes = requiredFreeBytes(totalBytes);
    if (freeBytes < reserveBytes) {
      const error = `insufficient free space (${freeBytes} available; ${reserveBytes} reserve)`;
      await log(`pg SKIP: ${error}`);
      await log('hook done (degraded)');
      return { ok: false, error };
    }
  } catch (err) {
    // A statfs failure should not disable backups on an unusual filesystem;
    // dumpPg still handles ENOSPC and cleans its transaction file.
    await log(`free-space probe unavailable: ${String(err)}`);
  }

  // --- embedded-pg (port discovered at runtime) ---
  const { url, source } = backupHost().getHarnessAdminUrl();
  await log(`embedded-pg URL source: ${source}`);
  const parsed = new URL(url);
  const result = await dumpPg({
    host: parsed.hostname,
    port: Number(parsed.port) || 5432,
    user: parsed.username || 'postgres',
    password: decodeURIComponent(parsed.password || 'postgres'),
    database: decodeURIComponent(parsed.pathname.replace(/^\//, '')) || 'papercusp',
    outPath: join(dumpDir, 'pg-embedded.sql.gz'),
    log,
  });

  await log(`hook done (${result.ok ? 'ok' : 'degraded'})`);
  return result;
}

async function dumpPg(opts: {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  outPath: string;
  log: (msg: string) => Promise<void>;
}): Promise<PreSnapshotHookResult> {
  const tmp = `${opts.outPath}.tmp`;
  // A crash/timeout from an earlier attempt must not become the next
  // snapshot's input. This is paired with the `*.tmp` Kopia policy rule.
  await unlink(tmp).catch(() => {});
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PGPASSWORD: opts.password,
    PGCONNECT_TIMEOUT: '5',
  };
  return new Promise<PreSnapshotHookResult>((resolve) => {
    const dump = spawn('pg_dump', [
      '-h', opts.host,
      '-p', String(opts.port),
      '-U', opts.user,
      '-w',
      '-d', opts.database,
      '--no-owner',
      '--no-privileges',
      '-n', 'harness_shared',
      // Every extension the harness_shared schema actually depends on at
      // DDL time must be dumped, not just `vector`. EI-13868: a restore
      // drill found the dump omitted `pg_trgm`, so importing into a fresh
      // DB failed 3x with "gin_trgm_ops does not exist for access method
      // gin" the moment the trigram GIN index (594-memory-canonical-trgm-
      // lexical.sql) tried to create — CREATE INDEX validates the operator
      // class at DDL time, unlike a plpgsql function body's pgcrypto calls
      // (000-baseline.sql: pgp_sym_encrypt/gen_salt), which aren't checked
      // until called. Include `pgcrypto` too so those functions actually
      // work post-restore instead of failing silently the first time
      // they're invoked.
      '-e', 'vector',
      '-e', 'pg_trgm',
      '-e', 'pgcrypto',
      ...EXCLUDED_TABLE_DATA.map((table) => `--exclude-table-data=${table}`),
    ], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const gz = spawn('gzip', gzipArgs(), { stdio: ['pipe', 'pipe', 'pipe'] });
    const out = createWriteStream(tmp);

    dump.stdout.pipe(gz.stdin);
    gz.stdout.pipe(out);
    let stderr = '';
    dump.stderr.on('data', (d) => { stderr += d.toString(); });
    gz.stderr.on('data', (d) => { stderr += d.toString(); });

    const t = setTimeout(() => {
      stderr += `pg dump timed out after ${PG_DUMP_TIMEOUT_MS}ms\n`;
      dump.kill('SIGKILL');
      gz.kill('SIGKILL');
    }, PG_DUMP_TIMEOUT_MS);
    let settled = false;
    const finalize = async (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      if (!out.destroyed) out.end();
      let result: PreSnapshotHookResult;
      if (ok) {
        try {
          const s = await stat(tmp);
          if (s.size >= MIN_RESTORABLE_DUMP_BYTES) {
            await renameAtomic(tmp, opts.outPath);
            await opts.log(`pg ${opts.host}:${opts.port} ok (${s.size} bytes)`);
            result = { ok: true, bytes: s.size };
          } else {
            const detail = stderr.trim().slice(0, 200);
            const error = `empty dump${detail ? `: ${detail}` : ''}`;
            await unlink(tmp).catch(() => {});
            await opts.log(`pg ${opts.host}:${opts.port} SKIP (empty dump)${detail ? `: ${detail}` : ''}`);
            result = { ok: false, error };
          }
        } catch (e) {
          const error = `stat: ${String(e)}`;
          await unlink(tmp).catch(() => {});
          await opts.log(`pg ${opts.host}:${opts.port} FAIL ${error}`);
          result = { ok: false, error };
        }
      } else {
        const error = stderr.trim().slice(0, 200) || 'dump pipeline failed';
        await unlink(tmp).catch(() => {});
        await opts.log(`pg ${opts.host}:${opts.port} FAIL: ${error}`);
        result = { ok: false, error };
      }
      resolve(result!);
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
    // The pg_dump→gzip pipe (`dump.stdout.pipe(gz.stdin)`) is the OTHER
    // unguarded socket. If gzip dies mid-stream — SIGKILL from the 60s
    // timeout above, an OOM kill under host load, or a plain crash — gz.stdin
    // becomes a broken pipe and pg_dump's next write throws `write EPIPE`.
    // That EPIPE surfaces as an 'error' event on the gz.stdin Socket (and, in
    // some Node versions, on dump.stdout), NOT as a promise rejection — so it
    // bypasses BOTH finalize()'s resolve-only contract and the caller's
    // `.catch()`, and (as seen 2026-07-10) crashes the whole DETACHED deploy
    // process right at the pre-deploy snapshot step, blocking every green-pin
    // ship. The child-`on('error')` handlers above only cover SPAWN failures,
    // not the stdin/stdout stream sockets, so add explicit handlers here that
    // degrade exactly like every other dump failure: abandon the dump, let the
    // snapshot proceed.
    gz.stdin.on('error', (e) => {
      stderr += `gzip stdin pipe failed: ${e.message}\n`;
      try { dump.kill('SIGKILL'); } catch { /* already gone */ }
      try { gz.kill('SIGKILL'); } catch { /* already gone */ }
      void finalize(false);
    });
    dump.stdout.on('error', (e) => {
      stderr += `pg_dump stdout pipe failed: ${e.message}\n`;
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
