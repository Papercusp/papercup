import { execFile, spawn } from 'node:child_process';
import { access, chmod, lstat, mkdtemp, open, readFile, readdir, realpath, rename, statfs, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import postgres from 'postgres';
import { resolveNativePgBinDir } from '../../libs/test-config/src/dedicated-native-pg.ts';
import { admitTaskDeadline } from '../lib/task-deadline.mjs';
import { planPgRestoreResume } from './pg-restore-resume.mjs';

const reject = reason => { throw new Error(`retained_restore_refused: ${reason}`); };

/** Reuse this attempt's stopped private PG and immutable archive; never initdb,
 * replay completed COPY, edit the old receipt, or remove retained evidence. */
export async function resumeRetainedState({ root, env = process.env,
  countTables = ['harness_shared.agent_facts', 'harness_shared.documents'] }) {
  const exec = promisify(execFile);
  root = resolve(root);
  if (await realpath(root) !== root) reject('redirected attempt root');
  const input = JSON.parse(await readFile(join(root, 'proof.json'), 'utf8'));
  if (input.root !== root || input.isolated !== true || input.sourceTier !== 'papercusp-state' ||
      input.transcriptDataRestored !== false || input.phase !== 'restore-complete-state-database')
    reject('unexpected retained attempt identity or phase');
  const prior = JSON.parse(await readFile(input.priorProof, 'utf8'));
  if (prior.snapshot !== input.snapshot || prior.rootObject !== input.rootObject ||
      input.archive !== join(prior.root, 'archive') || input.priorProof !== join(prior.root, 'proof.json'))
    reject('archive lineage mismatch');
  if (!Array.isArray(input.extensionPreflight) || !input.extensionPreflight.length ||
      input.extensionPreflight.some(row => typeof row.extname !== 'string' || typeof row.extversion !== 'string'))
    reject('recorded extension inventory required');
  const clusterRoot = join(root, 'clusters');
  const clusters = (await readdir(clusterRoot)).filter(name => name.startsWith('papercusp-native-pg-'));
  if (clusters.length !== 1) reject('one retained private cluster required');
  const dataDir = join(clusterRoot, clusters[0]);
  const dataStat = await lstat(dataDir);
  if (!dataStat.isDirectory() || dataStat.uid !== process.getuid() || await realpath(dataDir) !== dataDir ||
      (await readFile(join(dataDir, 'PG_VERSION'), 'utf8')).trim() !== '18')
    reject('private PG18 ownership mismatch');
  const port = input.privatePort;
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) reject('invalid recorded private port');
  const bin = resolveNativePgBinDir(env);
  const fast = async (command, args) => {
    try {
      return await exec(join(bin, command), args,
        { timeout: 30_000, maxBuffer: 32 * 1024 * 1024, env: { ...env, LC_ALL: 'C' } });
    } catch (error) {
      error.nativeCommand = { program: join(bin, command), code: error.code ?? null,
        signal: error.signal ?? null, killed: error.killed === true,
        stdout: String(error.stdout ?? '').slice(-4000), stderr: String(error.stderr ?? '').slice(-4000) };
      throw error;
    }
  };
  const status = async () => {
    try { await fast('pg_ctl', ['-D', dataDir, 'status']); return 'running'; }
    catch (error) { if (error.code === 3) return 'stopped'; throw error; }
  };
  if (await status() !== 'stopped') reject('target still running');
  try { await access(join(dataDir, 'postmaster.pid')); reject('postmaster pid file remains'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { await fast('pg_isready', ['-h', '127.0.0.1', '-p', String(port), '-t', '2']); reject('port occupied'); }
  catch (error) { if (error.code !== 2) throw error; }
  const [{ stdout: toc }, savedToc, log] = await Promise.all([
    fast('pg_restore', ['--list', input.archive]),
    readFile(join(prior.root, 'archive-toc.log'), 'utf8'),
    readFile(join(root, 'restore-full-state.log'), 'utf8'),
  ]);
  if (toc !== savedToc) reject('current archive differs from recorded TOC');
  const plan = planPgRestoreResume({ toc, log, exitOnError: true, interrupted: true });
  const admission = admitTaskDeadline({ env });
  if (admission.childCutoffEpochMs === null) reject('managed execution deadline required');
  const reserve = BigInt(input.reserveBytes);
  if (reserve <= 0n) reject('invalid original storage reserve');
  const available = async () => { const s = await statfs(root, { bigint: true }); return s.bavail * s.bsize; };
  if (await available() < reserve) reject('original protected storage reserve unavailable');
  if (!countTables.length || countTables.some(name => !/^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/.test(name)))
    reject('invalid verification table');

  const attempt = await mkdtemp(join(root, 'resume-'));
  await chmod(attempt, 0o700);
  const list = join(attempt, 'remaining.list');
  await writeFile(list, plan.remainingList, { mode: 0o600 });
  const proof = { snapshot: input.snapshot, rootObject: input.rootObject, priorProof: join(root, 'proof.json'),
    root: attempt, dataDir, privatePort: port, archive: input.archive, isolated: true,
    sourceTier: input.sourceTier, transcriptDataRestored: false, startedAt: new Date().toISOString(),
    tocSha256: plan.tocSha256, priorLogSha256: plan.logSha256, completedBefore: plan.completedIds.length,
    remainingItems: plan.remainingIds.length, inFlightBefore: plan.inFlightIds, ...admission,
    reserveBytes: String(reserve), phase: 'preflight', clusterStopped: true };
  const save = async () => {
    proof.updatedAt = new Date().toISOString();
    const path = join(attempt, 'proof.json');
    await writeFile(path + '.tmp', JSON.stringify(proof, null, 2), { mode: 0o600 });
    await rename(path + '.tmp', path);
  };
  let child, killTimer, sql, startAttempted = false, abortReason;
  const abort = reason => {
    abortReason ??= reason;
    if (child?.pid) { try { process.kill(-child.pid, 'SIGTERM'); } catch (e) { if (e.code !== 'ESRCH') throw e; } }
    if (child?.pid && !killTimer) killTimer = setTimeout(() => {
      if (child?.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; } }
    }, 10_000);
  };
  const onSignal = () => abort(new Error('managed termination'));
  const cutoff = setTimeout(() => abort(new Error('child cutoff reached; cleanup reserve retained')),
    Math.max(0, admission.childCutoffEpochMs - Date.now()));
  const storage = setInterval(() => {
    available().then(bytes => { if (bytes < reserve) abort(new Error('protected storage reserve reached')); }).catch(abort);
  }, 15_000);
  process.on('SIGTERM', onSignal); process.on('SIGINT', onSignal);
  try {
    await save();
    if (abortReason) throw abortReason;
    proof.phase = 'start-private-pg'; proof.clusterStopped = null; await save();
    if (abortReason) { proof.clusterStopped = true; throw abortReason; }
    startAttempted = true;
    await fast('pg_ctl', ['-D', dataDir, 'start', '-w', '-t', '20', '-l', join(attempt, 'server.log'), '-o',
      `-p ${port} -c listen_addresses=127.0.0.1 -c unix_socket_directories= -c logging_collector=off ` +
      '-c shared_preload_libraries=pg_stat_statements,pg_textsearch -c effective_io_concurrency=1 -c maintenance_io_concurrency=1']);
    proof.clusterStopped = false; proof.phase = 'reconcile-target'; await save();
    sql = postgres(`postgres://postgres@127.0.0.1:${port}/workstation_state_restore`,
      { max: 1, connect_timeout: 10, connection: { statement_timeout: 5000 }, onnotice: () => {} });
    const [identity] = await sql`SELECT current_setting('data_directory') AS dir,
      current_database() AS db, current_setting('shared_preload_libraries') AS preloads`;
    if (identity.dir !== dataDir || identity.db !== 'workstation_state_restore' || !identity.preloads.includes('pg_textsearch'))
      reject('running target identity mismatch');
    const extensions = await sql`SELECT extname, extversion FROM pg_extension`;
    for (const expected of input.extensionPreflight) {
      if (!extensions.some(row => row.extname === expected.extname && row.extversion === expected.extversion))
        reject(`restored extension version mismatch: ${expected.extname}`);
    }
    for (const id of plan.inFlightIds) {
      const line = toc.split('\n').find(value => value.startsWith(`${id};`));
      const index = /^\d+; \d+ \d+ INDEX ([a-z_][a-z0-9_]*) ([a-z_][a-z0-9_]*) \S+$/.exec(line);
      if (!index) reject('index catalog identity unsupported');
      const [row] = await sql`SELECT to_regclass(${`${index[1]}.${index[2]}`}) AS idx`;
      if (row.idx !== null) reject('interrupted index exists; explicit reconciliation required');
    }
    if (abortReason) throw abortReason;
    proof.phase = 'restore-remaining-state'; await save();
    const fd = await open(join(attempt, 'restore-remaining.log'), 'wx', 0o600);
    try {
      const result = await new Promise((resolveResult, rejectResult) => {
        child = spawn(join(bin, 'pg_restore'), ['--exit-on-error', '--jobs=2', '--verbose', '--use-list', list,
          '--dbname', `postgres://postgres@127.0.0.1:${port}/workstation_state_restore`, input.archive],
        { detached: true, stdio: ['ignore', fd.fd, fd.fd], env: { ...env, LC_ALL: 'C' } });
        child.once('error', rejectResult);
        child.once('close', (code, signal) => resolveResult({ code, signal }));
      });
      child = undefined; clearTimeout(killTimer); killTimer = undefined;
      if (abortReason) throw abortReason;
      if (result.code !== 0) throw new Error(`strict remaining restore failed: ${JSON.stringify(result)}`);
    } finally { await fd.close(); }
    proof.phase = 'verify-restored-state'; await save();
    proof.counts = {};
    for (const table of countTables) {
      const qualified = table.split('.').map(name => `"${name}"`).join('.');
      const [row] = await sql.unsafe(`SELECT count(*)::text AS count FROM ${qualified}`);
      if (BigInt(row.count) <= 0n) throw new Error(`required restored table empty: ${table}`);
      proof.counts[table] = row.count;
    }
    if (abortReason) throw abortReason;
    proof.phase = 'passed';
  } catch (error) {
    proof.phase = 'failed'; proof.error = String(error.stack ?? error);
    if (error.nativeCommand) proof.errorDetails = error.nativeCommand;
    try { proof.serverLogTail = (await readFile(join(attempt, 'server.log'), 'utf8')).slice(-4000); }
    catch (logError) { proof.serverLogReadError = String(logError.code ?? logError); }
  } finally {
    clearTimeout(cutoff); clearInterval(storage); clearTimeout(killTimer);
    process.off('SIGTERM', onSignal); process.off('SIGINT', onSignal);
    await sql?.end({ timeout: 5 }).catch(() => {});
    if (startAttempted) {
      try {
        if (await status() === 'running') await fast('pg_ctl', ['-D', dataDir, 'stop', '-m', 'fast', '-w', '-t', '30']);
        proof.clusterStopped = await status() === 'stopped';
        if (!proof.clusterStopped) throw new Error('private server remains live');
      } catch (error) { proof.clusterStopped = false; proof.phase = 'failed'; proof.cleanupError = String(error); }
    }
    proof.finishedAt = new Date().toISOString(); await save();
  }
  if (proof.phase !== 'passed') throw new Error(`retained restore failed; proof=${join(attempt, 'proof.json')}; ${proof.error ?? proof.cleanupError}`);
  return proof;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length !== 3) reject('usage: node --experimental-strip-types scripts/backup/resume-retained-state.mjs <recorded-attempt-root>');
  const proof = await resumeRetainedState({ root: process.argv[2] });
  console.log(JSON.stringify(proof));
}
