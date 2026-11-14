import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import postgres from 'postgres';
import { expect, it } from 'vitest';
import { startDedicatedNativePg, resolveNativePgBinDir } from '../../../libs/test-config/src/dedicated-native-pg';
import { resumeRetainedState } from '../../../scripts/backup/resume-retained-state.mjs';

const exec = promisify(execFile);

it('resumes a real interrupted index restore without copying completed rows twice', async () => {
  const work = await mkdtemp(join(tmpdir(), 'pg-restore-resume-'));
  const retainedRoot = await mkdtemp(join(work, 'retry-preload-'));
  await mkdir(join(retainedRoot, 'clusters'));
  const bin = resolveNativePgBinDir();
  const pg = await startDedicatedNativePg({ baseDir: join(retainedRoot, 'clusters') });
  const admin = postgres(pg.getConnectionUri(), { max: 1, onnotice: () => {} });
  const uri = (database: string) => {
    const url = new URL(pg.getConnectionUri()); url.pathname = `/${database}`; return url.toString();
  };
  let source: ReturnType<typeof postgres> | undefined;
  let gate: ReturnType<typeof postgres> | undefined;
  let target: ReturnType<typeof postgres> | undefined;
  let restore: ReturnType<typeof spawn> | undefined;
  const ctl = (args: string[]) => exec(join(bin, 'pg_ctl'), ['-D', pg.dataDir, ...args], { timeout: 30_000 });
  try {
    await admin.unsafe('CREATE DATABASE resume_source');
    await admin.unsafe('CREATE DATABASE workstation_state_restore');
    source = postgres(uri('resume_source'), { max: 1, onnotice: () => {} });
    await source.unsafe(`
      CREATE FUNCTION public.gated_identity(i integer) RETURNS integer
      LANGUAGE plpgsql IMMUTABLE AS $$
      BEGIN PERFORM pg_advisory_xact_lock(83119); RETURN i; END $$;
      CREATE TABLE public.canary(i integer);
      INSERT INTO public.canary VALUES (1), (2), (3);
      CREATE INDEX canary_gated_idx ON public.canary(public.gated_identity(i));
    `);
    const archive = join(work, 'archive');
    await exec(join(bin, 'pg_dump'), ['--format=directory', '--file', archive, uri('resume_source')], { timeout: 30_000 });
    const { stdout: toc } = await exec(join(bin, 'pg_restore'), ['--list', archive], { timeout: 30_000 });
    const extensionPreflight = await source`SELECT extname, extversion FROM pg_extension`;
    gate = postgres(uri('workstation_state_restore'), { max: 1, onnotice: () => {} });
    await gate`SELECT pg_advisory_lock(83119)`;
    const logPath = join(retainedRoot, 'restore-full-state.log');
    const fd = await open(logPath, 'w');
    let closed: Promise<void>;
    try {
      restore = spawn(join(bin, 'pg_restore'), ['--exit-on-error', '--jobs=2', '--verbose', '--dbname', uri('workstation_state_restore'), archive],
        { detached: true, stdio: ['ignore', fd.fd, fd.fd] });
      closed = new Promise((resolve, reject) => {
        restore!.once('error', reject); restore!.once('close', () => resolve());
      });
      const deadline = Date.now() + 15_000;
      for (;;) {
        const [row] = await admin`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
          WHERE datname='workstation_state_restore' AND wait_event='advisory') AS waiting`;
        if (row.waiting) break;
        if (restore.exitCode !== null || Date.now() > deadline) throw new Error(`index gate not reached: ${await readFile(logPath, 'utf8')}`);
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      // Kill this owned process group before cancelling its server transaction,
      // matching a managed interruption without manufacturing an archive error.
      process.kill(-restore.pid!, 'SIGTERM');
      const killTimer = setTimeout(() => { try { process.kill(-restore!.pid!, 'SIGKILL'); } catch {} }, 3_000);
      try { await closed; } finally { clearTimeout(killTimer); }
    } finally { await fd.close(); }

    // A stopped server establishes rollback, rather than assuming a disconnected
    // client's last CREATE INDEX could not still commit.
    await ctl(['stop', '-m', 'fast', '-w', '-t', '15']);
    await Promise.allSettled([admin.end({ timeout: 1 }), source.end({ timeout: 1 }), gate.end({ timeout: 1 })]);
    const lineage = { snapshot: 'a'.repeat(32), rootObject: 'k' + 'b'.repeat(32) };
    await writeFile(join(work, 'proof.json'), JSON.stringify({ ...lineage, root: work }));
    await writeFile(join(work, 'archive-toc.log'), toc);
    await writeFile(join(retainedRoot, 'proof.json'), JSON.stringify({ ...lineage, root: retainedRoot,
      priorProof: join(work, 'proof.json'), archive, privatePort: pg.port, isolated: true,
      sourceTier: 'papercusp-state', transcriptDataRestored: false, phase: 'restore-complete-state-database',
      reserveBytes: '1024', extensionPreflight }));
    // The real admission contract reserves two minutes. Exhaust the child
    // slice during preflight and verify a durable failure/cleanup receipt,
    // then resume the same unchanged source through the normal path.
    const shortEnv = { ...process.env };
    Object.defineProperty(shortEnv, 'PAPERCUSP_TASK_DEADLINE_EPOCH_MS', {
      enumerable: true, get: () => String(Date.now() + 120_001),
    });
    await expect(resumeRetainedState({ root: retainedRoot, env: shortEnv, countTables: ['public.canary'] }))
      .rejects.toThrow('child cutoff reached');
    const [aborted] = (await readdir(retainedRoot)).filter(name => name.startsWith('resume-'));
    const interruptedProof = JSON.parse(await readFile(join(retainedRoot, aborted, 'proof.json'), 'utf8'));
    expect(interruptedProof.phase).toBe('failed');
    expect(interruptedProof.clusterStopped).toBe(true);
    expect(interruptedProof.cleanupReserveMs).toBeGreaterThanOrEqual(120_000);
    const configPath = join(pg.dataDir, 'postgresql.auto.conf');
    const originalConfig = await readFile(configPath, 'utf8');
    await writeFile(configPath, originalConfig + "\nmax_connections = 'not-a-number'\n");
    try {
      await expect(resumeRetainedState({ root: retainedRoot,
        env: { ...process.env, PAPERCUSP_TASK_DEADLINE_EPOCH_MS: String(Date.now() + 180_000) },
        countTables: ['public.canary'] })).rejects.toThrow('retained restore failed');
      const [failedStart] = (await readdir(retainedRoot)).filter(name => name.startsWith('resume-') && name !== aborted);
      const failedProof = JSON.parse(await readFile(join(retainedRoot, failedStart, 'proof.json'), 'utf8'));
      expect(failedProof.clusterStopped).toBe(true);
      expect(failedProof.errorDetails.program).toBe(join(bin, 'pg_ctl'));
      expect(failedProof.errorDetails.code).toBe(1);
      expect(failedProof.errorDetails.stderr).toContain('could not start server');
      expect(failedProof.serverLogTail).toContain('not-a-number');
    } finally { await writeFile(configPath, originalConfig); }
    const proof = await resumeRetainedState({ root: retainedRoot,
      env: { ...process.env, PAPERCUSP_TASK_DEADLINE_EPOCH_MS: String(Date.now() + 180_000) },
      countTables: ['public.canary'] });
    expect(proof.phase).toBe('passed');
    expect(proof.clusterStopped).toBe(true);
    expect(proof.cleanupReserveMs).toBeGreaterThanOrEqual(120_000);
    expect(proof.counts).toEqual({ 'public.canary': '3' });
    const receipt = JSON.parse(await readFile(join(proof.root, 'proof.json'), 'utf8'));
    expect(receipt.clusterStopped).toBe(true);
    // Re-open only for the independent assertion; the runner's own stopped
    // receipt above is checked before this separate readback begins.
    await ctl(['start', '-w', '-t', '15', '-l', join(work, 'assertion.log'), '-o',
      `-p ${pg.port} -c listen_addresses=127.0.0.1 -c unix_socket_directories= -c shared_preload_libraries=pg_stat_statements,pg_textsearch`]);
    target = postgres(uri('workstation_state_restore'), { max: 1, onnotice: () => {} });
    expect(await target`SELECT i FROM public.canary ORDER BY i`).toEqual([{ i: 1 }, { i: 2 }, { i: 3 }]);
    const [after] = await target`SELECT indisvalid FROM pg_index WHERE indexrelid='public.canary_gated_idx'::regclass`;
    expect(after.indisvalid).toBe(true);
  } finally {
    if (restore?.exitCode === null && restore.signalCode === null && restore.pid) {
      try { process.kill(-restore.pid, 'SIGKILL'); } catch {}
    }
    await Promise.allSettled([admin.end({ timeout: 1 }), source?.end({ timeout: 1 }), gate?.end({ timeout: 1 }), target?.end({ timeout: 1 })]);
    let live = false;
    try { await ctl(['status']); live = true; } catch (error) {
      if ((error as { code?: number }).code !== 3) throw error;
    }
    if (live) await ctl(['stop', '-m', 'fast', '-w', '-t', '15']);
    await pg.stop();
    await rm(work, { recursive: true, force: true });
  }
}, 120_000);
