// Operational probe for plan papercusp-db-backup-invalid-db-2026-09-27 (READ-ONLY).
// Run from the papercusp repo root:
//   npx tsx docs/evidence/papercusp-db-backup-invalid-db-operational-probe-2026-09-29.mts \
//     > docs/evidence/papercusp-db-backup-invalid-db-operational-probe-2026-09-29.json
// Emits one operational-test-evidence JSON document on stdout; exit 0 iff every assertion passed.
// Reads: the live cluster catalog (sudo -n -u postgres psql, SELECT only), the user systemd units
// and their journals, /mnt/backup/db-dumps/STATUS.json, and harness_shared.backup_snapshots.
// Writes nothing. Assertion ids are the lowercased spec ids they target.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const startedAt = new Date().toISOString();
const assertions: Array<{ id: string; passed: boolean; evidence: string }> = [];
const observations: Record<string, unknown> = {};
const assert = (id: string, passed: boolean, evidence: string) => assertions.push({ id, passed, evidence });
const psql = (db: string, sql: string): string[][] =>
  execFileSync('sudo', ['-n', '-u', 'postgres', 'psql', '-d', db, '-At', '-F', '\t', '-c', sql], { encoding: 'utf8' })
    .trim().split('\n').filter(Boolean).map((line) => line.split('\t'));
const sh = (cmd: string, args: string[]) => execFileSync(cmd, args, { encoding: 'utf8' });
const unit = (name: string) => Object.fromEntries(
  sh('systemctl', ['--user', 'show', name, '-p', 'Result', '-p', 'ExecMainStatus', '-p', 'ExecMainExitTimestamp'])
    .trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
// journalctl --since/--until parse LOCAL time on this box; pass an explicit UTC offset.
const journal = (name: string, since: string, until: string) =>
  sh('journalctl', ['--user', '-u', name, '--since', since, '--until', until, '--no-pager', '-o', 'short-iso']);

const PLAN = 'papercusp-db-backup-invalid-db-2026-09-27';
// The reaper's own scope (bin/reap-invalid-test-databases.sh NAME_RE).
const REAPER_SCOPE = `datname ~ '^(papercusp_it_baseline|org)_[0-9a-f]{12}$'`;

// ── R-1 (P-001, P-004): the first post-fix scheduled run exited 0 WHILE INVALID databases existed ──
const firstRun = journal('papercusp-db-backup.service', '2026-09-27 11:55:00 -04:00', '2026-09-27 12:40:00 -04:00');
const skipped = /WARN skipping (\d+) INVALID database\(s\)/.exec(firstRun);
const finished = /Finished papercusp-db-backup\.service/.test(firstRun);
const failedUnit = /papercusp-db-backup\.service: (Failed|Main process exited, code=exited, status=[1-9])/.test(firstRun);
const backupUnit = unit('papercusp-db-backup.service');
const status = JSON.parse(readFileSync('/mnt/backup/db-dumps/STATUS.json', 'utf8')) as {
  ok: boolean; failed: string[]; invalidSkipped: string[]; lastRunIso: string;
};
observations.r1 = {
  firstRunInvalidSkipped: skipped ? Number(skipped[1]) : null, firstRunFinished: finished, firstRunFailed: failedUnit,
  currentUnit: backupUnit, statusJson: { ok: status.ok, failed: status.failed, invalidSkipped: status.invalidSkipped, lastRunIso: status.lastRunIso },
};
const r1 = !!skipped && Number(skipped[1]) > 0 && finished && !failedUnit
  && backupUnit.Result === 'success' && backupUnit.ExecMainStatus === '0' && status.ok === true && status.failed.length === 0;
const r1Evidence = `2026-09-27 12:00 EDT scheduled run skipped ${skipped?.[1] ?? '?'} INVALID database(s) and finished (no failure line); `
  + `unit now Result=${backupUnit.Result} ExecMainStatus=${backupUnit.ExecMainStatus}; STATUS.json ok=${status.ok} failed=[${status.failed.join(',')}] at ${status.lastRunIso}`;
assert('auto-bar-r-1-p-001', r1, r1Evidence);
assert('auto-bar-r-1-p-004', r1, r1Evidence);

// ── R-3 (P-002): after the live reaper run, no INVALID database within the reaper scope remains ──
const [[invalidAll, invalidInScope]] = psql('postgres',
  `SELECT count(*) FILTER (WHERE datconnlimit = -2), count(*) FILTER (WHERE datconnlimit = -2 AND ${REAPER_SCOPE}) FROM pg_database`);
const reaperUnit = unit('papercusp-invalid-db-reaper.service');
const firstReap = journal('papercusp-invalid-db-reaper.service', '2026-09-27 12:40:00 -04:00', '2026-09-27 13:30:00 -04:00');
const droppedLines = firstReap.match(/DROPPED \S+/g) ?? [];
observations.r3 = { invalidAll: Number(invalidAll), invalidInScope: Number(invalidInScope), reaperUnit, firstLiveRunDropped: droppedLines.length };
assert('auto-bar-r-3-p-002', Number(invalidInScope) === 0 && droppedLines.length > 0 && reaperUnit.Result === 'success',
  `live census: ${invalidInScope} INVALID in reaper scope (${invalidAll} INVALID cluster-wide); first live reaper run 2026-09-27 dropped ${droppedLines.length}; reaper unit Result=${reaperUnit.Result}`);

// ── R-2 (P-002), live half: a backup:snapshot_create snapshot preceded the first destructive run ──
const [[snapId, snapReason, snapStatus, snapFinished]] = psql('papercusp',
  `SELECT id, trigger_reason, status, to_char(finished_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') FROM harness_shared.backup_snapshots WHERE workspace_id = 'papercusp-workspace' AND id = 77748`);
const firstDrop = /^(\S+) .*DROPPED /m.exec(firstReap)?.[1] ?? null;
const snapBeforeDrop = !!firstDrop && Date.parse(snapFinished) < Date.parse(firstDrop);
observations.r2Snapshot = { snapId, snapReason, snapStatus, snapFinished, firstDrop };
assert('auto-bar-r-2-p-002', snapReason === 'pre_destructive' && snapStatus === 'ok' && snapBeforeDrop,
  `snapshot ${snapId} (${snapReason}, ${snapStatus}) finished ${snapFinished}, before the first live DROP at ${firstDrop}`);

const passed = assertions.filter((a) => a.passed).length;
process.stdout.write(`${JSON.stringify({
  schemaVersion: 1,
  kind: 'operational-test-evidence',
  name: 'papercusp-db-backup invalid-db operational probe (R-1, R-2 snapshot, R-3)',
  framework: 'shell',
  command: ['npx', 'tsx', 'docs/evidence/papercusp-db-backup-invalid-db-operational-probe-2026-09-29.mts'],
  exitCode: passed === assertions.length ? 0 : 1,
  startedAt,
  finishedAt: new Date().toISOString(),
  summary: `${passed}/${assertions.length} live assertions passed for plan ${PLAN}.`,
  assertions,
  plan: PLAN,
  observations,
}, null, 2)}\n`);
process.exitCode = passed === assertions.length ? 0 : 1;
