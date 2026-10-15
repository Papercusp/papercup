/** R-1/R-2 evidence adapters. Reuse kernel mounts, canonical move logs and audit_log;
 * observation is read-only apart from retaining a boot witness in the existing ledger.
 * A mount observed twice in one boot is never reboot proof. */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, readdir, realpath, lstat } from 'node:fs/promises';
import { hostname } from 'node:os';
import { z } from 'zod';

export const COLD_MOUNTS_INSTRUMENT_KEY = 'storage:cold-mounts-reboot';
export const COLD_MOVES_INSTRUMENT_KEY = 'storage:cold-bulk-cutover';
const MOUNT_ACTION = 'storage:cold-mount-observation';
const TARGETS = [
  { path: '/mnt/cold-a', source: '/dev/sda2' },
  { path: '/mnt/cold-b', source: '/dev/sdb3' },
] as const;
type Sql = Pick<import('postgres').Sql, 'unsafe'>;
type Verdict = 'pass' | 'fail' | 'unknown';
export interface ColdEvidence { verdict: Verdict; detail: string }
const outcome = (verdict: Verdict, detail: string): ColdEvidence => ({ verdict, detail });
const unescapeField = (s: string) => s.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
const observationSchema = z.object({
  host: z.string().min(1), bootId: z.string().uuid(), at: z.string().datetime({ offset: true }),
  mounts: z.array(z.object({ path: z.string(), source: z.string(), type: z.string(),
    uuid: z.string(), uuidSource: z.string(), nofail: z.boolean() })).length(2),
});
export type ColdMountObservation = z.infer<typeof observationSchema>;

/** Parse kernel mountinfo and fstab together; resolving UUID symlinks is a separate native read. */
export function parseColdMounts(mountinfo: string, fstab: string) {
  return TARGETS.map(target => {
    const mounted = mountinfo.split('\n').map(line => line.split(' ')).filter(fields => unescapeField(fields[4] ?? '') === target.path);
    const entries = fstab.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'))
      .map(line => line.split(/\s+/)).filter(fields => unescapeField(fields[1] ?? '') === target.path);
    const fields = mounted.length === 1 ? mounted[0]! : [];
    const dash = fields.indexOf('-');
    const entry = entries.length === 1 ? entries[0]! : [];
    return { path: target.path, source: dash >= 0 ? unescapeField(fields[dash + 2] ?? '') : '',
      type: dash >= 0 ? fields[dash + 1] ?? '' : '',
      uuid: entry[0]?.startsWith('UUID=') ? entry[0].slice(5) : '',
      nofail: entry[2] === 'xfs' && (entry[3] ?? '').split(',').includes('nofail') };
  });
}

export function assessColdMounts(current: unknown, previous: unknown): ColdEvidence {
  const now = observationSchema.safeParse(current);
  if (!now.success) return outcome('unknown', 'No complete kernel/fstab/UUID/boot observation.');
  const valid = (s: ColdMountObservation) => TARGETS.every(t => {
    const rows = s.mounts.filter(m => m.path === t.path);
    return rows.length === 1 && rows[0]!.source === t.source && rows[0]!.uuidSource === t.source &&
      rows[0]!.type === 'xfs' && rows[0]!.nofail && /^[a-f0-9-]{36}$/i.test(rows[0]!.uuid);
  });
  if (!valid(now.data)) return outcome('fail', 'A required XFS mount or its unique UUID/nofail fstab mapping is missing or incorrect.');
  const before = observationSchema.safeParse(previous);
  if (!before.success || before.data.host !== now.data.host || before.data.bootId === now.data.bootId ||
      Date.parse(before.data.at) >= Date.parse(now.data.at) || !valid(before.data)) {
    return outcome('unknown', 'Current mounts are valid; a valid earlier observation from a different boot on this host is still required.');
  }
  if (!TARGETS.every(t => before.data.mounts.find(m => m.path === t.path)!.uuid === now.data.mounts.find(m => m.path === t.path)!.uuid)) {
    return outcome('fail', 'The cold volume UUID changed across the observed reboot.');
  }
  return outcome('pass', `Both UUID/nofail XFS mounts survived boot ${before.data.bootId} -> ${now.data.bootId}.`);
}

export async function observeColdMounts(): Promise<ColdMountObservation> {
  const bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
  const [mountinfo, fstab] = await Promise.all([readFile('/proc/self/mountinfo', 'utf8'), readFile('/etc/fstab', 'utf8')]);
  const mounts = await Promise.all(parseColdMounts(mountinfo, fstab).map(async mount => ({ ...mount,
    uuidSource: mount.uuid && /^[a-f0-9-]{36}$/i.test(mount.uuid)
      ? await realpath(`/dev/disk/by-uuid/${mount.uuid}`).catch(() => '') : '',
  })));
  if ((await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim() !== bootId) throw new Error('Boot changed during mount observation.');
  return observationSchema.parse({ host: hostname(), bootId, at: new Date().toISOString(), mounts });
}

export async function measureColdMounts(sql: Sql, workspaceId: string,
  observe: () => Promise<ColdMountObservation> = observeColdMounts): Promise<ColdEvidence> {
  const current = observationSchema.parse(await observe());
  const previous = await sql.unsafe(`SELECT details FROM harness_shared.audit_log
    WHERE workspace_id=$1 AND actor='system:storage-conformance' AND action=$2
      AND details->>'host'=$3 AND details->>'bootId'<>$4 AND ts<$5
    ORDER BY ts DESC, id DESC LIMIT 1`, [workspaceId, MOUNT_ACTION, current.host, current.bootId, Date.parse(current.at)]);
  if (assessColdMounts(current, null).verdict === 'fail') return assessColdMounts(current, null);
  // Keep one witness per boot (not one new row on every sweep). No table or schedule is added.
  await sql.unsafe(`INSERT INTO harness_shared.audit_log(id,ts,actor,action,subject,details,workspace_id)
    SELECT $1,$2,'system:storage-conformance',$3,$4,$5::text::jsonb,$6
    WHERE NOT EXISTS (SELECT 1 FROM harness_shared.audit_log WHERE workspace_id=$6
      AND actor='system:storage-conformance' AND action=$3 AND subject=$4)`,
  [randomUUID(), Date.parse(current.at), MOUNT_ACTION, `${current.host}:${current.bootId}`, JSON.stringify(current), workspaceId]);
  return assessColdMounts(current, previous[0]?.details);
}

export interface ColdMove { name: string; source: string; destination: string; log: string; repointed: boolean; asideAbsent: boolean }
/** Strictly assess the actual move script's VERIFY1/VERIFY2/DONE protocol. A new
 * COPY starts a new attempt; a stale successful attempt cannot mask a failed retry. */
export function assessColdMoves(moves: readonly ColdMove[], backup: unknown, measuredAt: string): ColdEvidence {
  if (moves.length < 3 || new Set(moves.map(m => m.source)).size !== moves.length) return outcome('unknown', 'The required bulk and owner-copy inventory is incomplete or duplicated.');
  let cutover = 0;
  for (const move of moves) {
    let phase = 0, done = 0, lastAt = 0;
    for (const line of move.log.split('\n')) {
      const match = /^(\S+) (COPY|VERIFY1|VERIFY2|DONE|FAIL|WARN|MISMATCH2?|SKIP) (\S+)(.*)$/.exec(line);
      if (!match || match[3] !== move.name) continue;
      const at = Date.parse(match[1]!);
      if (!Number.isFinite(at) || at < lastAt || at > Date.parse(measuredAt)) return outcome('unknown', `Invalid move clock: ${move.name}.`);
      lastAt = at;
      const action = match[2]!, tail = match[4]!;
      if (action === 'COPY') { phase = 0; done = 0; }
      else if (action === 'VERIFY1' || action === 'VERIFY2') {
        const counts = /^ entries src=(\d+) dst=(\d+) bytes src=(\d+) dst=(\d+)$/.exec(tail);
        if (!counts || counts.slice(1).some(n => !Number.isSafeInteger(Number(n))) ||
            BigInt(counts[1]!) !== BigInt(counts[2]!) || BigInt(counts[3]!) !== BigInt(counts[4]!)) return outcome('fail', `Entry/byte verification failed: ${move.name}.`);
        if (action === 'VERIFY1') phase = 1;
        else if (phase === 1) phase = 2;
        else return outcome('fail', `VERIFY2 lacks a preceding VERIFY1: ${move.name}.`);
      } else if (action === 'DONE') {
        if (phase !== 2 || tail !== ` -> ${move.destination} (source removed, symlink left)`) return outcome('fail', `Source removal lacks ordered verification: ${move.name}.`);
        done = at; phase = 3;
      } else if (action !== 'SKIP') return outcome('fail', `Move has a failure or incomplete source removal: ${move.name}.`);
    }
    if (!done) return outcome('unknown', `No verified completed cutover for ${move.name}.`);
    if (!move.repointed || !move.asideAbsent) return outcome('fail', `The old consumer path is not redirected or a source aside remains: ${move.name}.`);
    cutover = Math.max(cutover, done);
  }
  const parsed = z.object({ repositoryPath: z.literal('/mnt/cold-a/Backup/kopia-repo'),
    host: z.string().min(1), snapshotHost: z.string().min(1), snapshotId: z.string().min(1),
    startedAt: z.string().datetime({ offset: true }), finishedAt: z.string().datetime({ offset: true }), complete: z.literal(true) }).safeParse(backup);
  if (!parsed.success || parsed.data.host !== parsed.data.snapshotHost || Date.parse(parsed.data.startedAt) <= cutover ||
      Date.parse(parsed.data.finishedAt) < Date.parse(parsed.data.startedAt) || Date.parse(parsed.data.finishedAt) > Date.parse(measuredAt)) {
    return outcome('unknown', 'A successful same-host Kopia snapshot in the moved repository must start after the entire cutover.');
  }
  return outcome('pass', `${moves.length} verified cutovers and post-cutover Kopia snapshot ${parsed.data.snapshotId}.`);
}

function kopiaJson(args: string[]): Promise<unknown> {
  return new Promise((resolve, reject) => execFile('kopia', args, { timeout: 15_000, maxBuffer: 2 * 1024 * 1024, shell: false }, (error, stdout) => {
    if (error) return reject(new Error('Native Kopia evidence is unavailable.'));
    try { resolve(JSON.parse(stdout)); } catch { reject(new Error('Native Kopia JSON is malformed.')); }
  }));
}

/** Observe symlink repointing and the existing script inventory, never copy/delete data. */
export async function measureColdMoves(runKopia: (args: string[]) => Promise<unknown> = kopiaJson): Promise<ColdEvidence> {
  const [bulkLog, ownerLog, sources, destinations] = await Promise.all([
    readFile('/mnt/cold-a/meta/MOVES.log', 'utf8'), readFile('/mnt/cold-b/meta/move-owner-copies.log', 'utf8'),
    readdir('/mnt/data'), readdir('/mnt/cold-b'),
  ]);
  if (bulkLog.length > 2 * 1024 * 1024 || ownerLog.length > 2 * 1024 * 1024) return outcome('unknown', 'Move log exceeds the bounded evidence reader.');
  const inventory = ownerLog.split('\n').filter(line => /^\S+ START dirs: /.test(line)).flatMap(line => line.replace(/^\S+ START dirs: /, '').split(/\s+/));
  const names = [...new Set([...inventory, ...sources, ...destinations].filter(n => /^(Debug[^/]*|back)$/.test(n)))];
  if (!names.length) return outcome('unknown', 'No owner-copy inventory.');
  const specs = [
    { name: 'kopia-repo', source: '/mnt/data/Backup/kopia-repo', destination: '/mnt/cold-a/Backup/kopia-repo', log: bulkLog },
    { name: 'papercusp-backups', source: '/mnt/data/papercusp-backups', destination: '/mnt/cold-a/papercusp-backups', log: bulkLog },
    ...names.map(name => ({ name, source: `/mnt/data/${name}`, destination: `/mnt/cold-b/${name}`, log: ownerLog })),
  ];
  const moves = await Promise.all(specs.map(async m => ({ ...m,
    // A parent (for example Backup/) may be the symlink. Resolve the consumer's
    // whole path instead of requiring the leaf itself to be a symlink.
    repointed: await realpath(m.source).then(path => path === m.destination).catch(() => false),
    asideAbsent: await lstat(`/mnt/data/.moving-to-cold-b-${m.name}`).then(() => false, (e: NodeJS.ErrnoException) => e.code === 'ENOENT'),
  })));
  // Missing cutover evidence can be decided without launching a potentially large snapshot listing.
  const preliminary = assessColdMoves(moves, null, new Date().toISOString());
  if (!preliminary.detail.startsWith('A successful same-host')) return preliminary;
  const status = await runKopia(['repository', 'status', '--json']) as { storage?: { config?: { path?: string } } };
  if (status?.storage?.config?.path !== '/mnt/cold-a/Backup/kopia-repo') return outcome('unknown', 'Native Kopia repository status does not select the moved repository.');
  const snapshots = await runKopia(['snapshot', 'list', '--all', '--json']);
  if (!Array.isArray(snapshots) || snapshots.length > 20_000) return outcome('unknown', 'Native Kopia snapshot inventory is missing or capped.');
  for (const s of snapshots) {
    const assessment = assessColdMoves(moves, { repositoryPath: status.storage.config.path, host: hostname(),
      snapshotHost: s?.source?.host, snapshotId: s?.id, startedAt: s?.startTime, finishedAt: s?.endTime,
      complete: s?.rootEntry?.obj && s?.stats?.errorCount === 0 ? true : false }, new Date().toISOString());
    if (assessment.verdict === 'pass') return assessment;
  }
  return preliminary;
}
