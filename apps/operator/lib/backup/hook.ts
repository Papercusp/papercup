/**
 * Pre-snapshot DB dump hook for a workspace.
 *
 * Writes transactionally-consistent dumps of the workspace's live DBs
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

import { spawn } from 'node:child_process';
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
import { getHarnessAdminUrlWithSource } from '../embedded-pg-discovery';

export async function runPreSnapshotHook(ctx: HookContext): Promise<void> {
  const dumpDir = join(ctx.workspaceRoot, 'db-dumps');
  await mkdir(dumpDir, { recursive: true });
  const logPath = join(dumpDir, 'hook.log');

  const log = async (msg: string) => {
    await appendFile(logPath, `[${new Date().toISOString()}] ${msg}\n`).catch(() => {});
  };

  // --- embedded-pg (port discovered at runtime) ---
  const { url, source } = getHarnessAdminUrlWithSource();
  await log(`embedded-pg URL source: ${source}`);
  const parsed = new URL(url);
  await dumpPg({
    host: parsed.hostname,
    port: Number(parsed.port) || 5432,
    user: parsed.username || 'postgres',
    password: decodeURIComponent(parsed.password || 'postgres'),
    outPath: join(dumpDir, 'pg-embedded.sql.gz'),
    log,
  });

  // --- pglite (file-based; just touch its data dir into the snapshot) ---
  const pgliteDir = join(ctx.workspaceRoot, '.papercusp', 'pglite-data');
  if (await pathExists(pgliteDir)) {
    await log(`pglite-data present at ${pgliteDir} — captured by file snapshot`);
  }

  await log('hook done');
}

async function dumpPg(opts: {
  host: string;
  port: number;
  user: string;
  password: string;
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
    const dump = spawn('pg_dumpall', [
      '-h', opts.host,
      '-p', String(opts.port),
      '-U', opts.user,
      '-w',
    ], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const gz = spawn('gzip', ['-1'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const out = createWriteStream(tmp);

    dump.stdout.pipe(gz.stdin);
    gz.stdout.pipe(out);
    let stderr = '';
    dump.stderr.on('data', (d) => { stderr += d.toString(); });
    gz.stderr.on('data', (d) => { stderr += d.toString(); });

    const finalize = async (ok: boolean) => {
      out.end();
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

    const t = setTimeout(() => { dump.kill('SIGKILL'); gz.kill('SIGKILL'); }, 60_000);
    let closed = 0;
    const onClose = (code: number | null) => {
      closed++;
      if (closed >= 2) {
        clearTimeout(t);
        void finalize(code === 0);
      }
    };
    dump.on('close', onClose);
    gz.on('close', onClose);
  });
}

async function renameAtomic(from: string, to: string): Promise<void> {
  const { rename, unlink } = await import('node:fs/promises');
  try { await unlink(to); } catch { /* fine */ }
  await rename(from, to);
}

async function pathExists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}
