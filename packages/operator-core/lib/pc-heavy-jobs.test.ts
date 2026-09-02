/**
 * EI-22066972653982768: `processes:kill { taskId }` only reaches ledger-enrolled
 * processes, so it refuses the exact live pid of a pc-heavy test child with
 * `unsupported_kind` — leaving `pkill -f <pattern>` (the pattern-kill this repo
 * forbids) as the only way to stop a runaway `npm run test:affected`.
 * `scripts/pc-heavy-jobs.mjs` closes that gap by reading the admission records
 * pc-heavy already writes and offering an identity-verified kill.
 *
 * The property these tests exist to protect is the REUSE-SAFETY REFUSAL: a
 * record names a pid AND the start_ticks that pid had when the record was
 * written. PID wrap happens ~daily on this box under fleet load, so a stale
 * record can name a pid now owned by something else — killing it would take out
 * a bystander (the failure mode that has twice killed the owner's live desktop
 * via `pkill -f`). Every kill path below therefore asserts on whether a signal
 * was sent AT ALL, not merely on the returned verdict: a refusal that still
 * signalled would pass a verdict-only assertion while doing the exact damage
 * this script exists to prevent.
 *
 * All signals are injected (`killFn`) and all waiting is injected (`sleepFn`),
 * so the suite never signals a real process.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  classifyRecord,
  fieldsAfterComm,
  formatJob,
  killJob,
  listJobs,
  parseAdmissionRecord,
  parseFlags,
  readPgid,
  readStartTicks,
  resolveAdmissionDir,
} from '../../../scripts/pc-heavy-jobs.mjs';

let root: string | null = null;

function makeRoot() {
  root = mkdtempSync(join(tmpdir(), 'pc-heavy-jobs-'));
  const procRoot = join(root, 'proc');
  const admissionDir = join(root, 'psi-admissions');
  mkdirSync(procRoot, { recursive: true });
  mkdirSync(admissionDir, { recursive: true });
  return { procRoot, admissionDir };
}

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = null;
});

/**
 * Write a realistic /proc/<pid>/stat. Field 22 (starttime) is the 20th token
 * after the comm field, and field 5 (pgrp) is the 3rd — the exact offsets
 * pc-heavy.sh's own `_pc_heavy_proc_start_ticks` relies on.
 */
function fixtureProc(
  procRoot: string,
  pid: number,
  opts: { pgid?: number; startTicks: number | string; comm?: string },
) {
  const dir = join(procRoot, String(pid));
  mkdirSync(dir, { recursive: true });
  const pgid = opts.pgid ?? pid;
  const afterComm = [
    'S', '1', String(pgid), String(pgid), '0', '-1', '0', '0', '0', '0',
    '0', '0', '0', '0', '0', '20', '0', '1', '0', String(opts.startTicks),
  ];
  writeFileSync(
    join(dir, 'stat'),
    `${pid} (${opts.comm ?? 'node'}) ${afterComm.join(' ')}\n`,
  );
}

function fixtureRecord(
  admissionDir: string,
  admissionId: string,
  fields: Record<string, string | number>,
) {
  const body =
    ['version=1', `admission_id=${admissionId}`]
      .concat(Object.entries(fields).map(([k, v]) => `${k}=${v}`))
      .join('\n') + '\n';
  writeFileSync(join(admissionDir, `${admissionId}.state`), body);
}

describe('stat parsing mirrors pc-heavy.sh', () => {
  it('splits through the LAST ") " so a comm containing spaces/parens cannot shift fields', () => {
    // A process may legally be named `(evil) 1 2 3`. Splitting on the FIRST
    // ")" would make every later field off-by-N and silently return the wrong
    // number as start_ticks — which would then never match and turn every kill
    // into a false "recycled" refusal.
    const line = `42 ((evil) 1 2 3) S 1 42 42 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 987654`;
    const fields = fieldsAfterComm(line);
    expect(fields[0]).toBe('S');
    expect(fields[2]).toBe('42'); // field 5, pgrp
    expect(fields[19]).toBe('987654'); // field 22, starttime
  });

  it('reads start_ticks and pgid from a fixture /proc, and returns null when absent', () => {
    const { procRoot } = makeRoot();
    fixtureProc(procRoot, 1234, { startTicks: 555, pgid: 1234 });
    expect(readStartTicks(1234, { procRoot })).toBe('555');
    expect(readPgid(1234, { procRoot })).toBe('1234');
    expect(readStartTicks(9999, { procRoot })).toBeNull();
    expect(readStartTicks('not-a-pid', { procRoot })).toBeNull();
  });
});

describe('record parsing and classification', () => {
  it('parses key=value lines and keeps unknown keys', () => {
    const rec = parseAdmissionRecord(
      'version=1\npid=7\nstart_ticks=99\nfuture_field=x=y\n\nbroken\n',
    );
    expect(rec.pid).toBe('7');
    expect(rec.start_ticks).toBe('99');
    // value containing '=' survives; malformed line skipped, not fatal
    expect(rec.future_field).toBe('x=y');
    expect(rec.broken).toBeUndefined();
  });

  it('classifies live / gone / recycled / malformed', () => {
    expect(classifyRecord({ pid: '7', start_ticks: '99' }, '99')).toBe('live');
    expect(classifyRecord({ pid: '7', start_ticks: '99' }, null)).toBe('gone');
    expect(classifyRecord({ pid: '7', start_ticks: '99' }, '100')).toBe('recycled');
    expect(classifyRecord({ pid: 'x', start_ticks: '99' }, '99')).toBe('malformed');
    expect(classifyRecord({ pid: '7' }, '99')).toBe('malformed');
  });
});

describe('listJobs', () => {
  it('reports verified liveness per record and never deletes stale ones', () => {
    const { procRoot, admissionDir } = makeRoot();
    fixtureProc(procRoot, 100, { startTicks: 111 });
    fixtureProc(procRoot, 200, { startTicks: 999 }); // recycled: ticks differ
    fixtureRecord(admissionDir, 'live-job', {
      pid: 100, start_ticks: 111, priority: 10, state: 'active', memory_current_mib: 512,
    });
    fixtureRecord(admissionDir, 'recycled-job', {
      pid: 200, start_ticks: 222, priority: 10, state: 'active',
    });
    fixtureRecord(admissionDir, 'gone-job', {
      pid: 300, start_ticks: 333, priority: 50, state: 'frozen',
    });

    const jobs = listJobs({ admissionDir, procRoot });
    const byId = Object.fromEntries(jobs.map((j) => [j.admissionId, j]));
    expect(byId['live-job'].status).toBe('live');
    expect(byId['recycled-job'].status).toBe('recycled');
    expect(byId['gone-job'].status).toBe('gone');
    expect(byId['live-job'].memoryCurrentMib).toBe('512');

    // Inspection must not mutate shared runtime state: pc-heavy's coordinator
    // may be mid-election against this very directory. Reaping is its job.
    expect(existsSync(join(admissionDir, 'recycled-job.state'))).toBe(true);
    expect(existsSync(join(admissionDir, 'gone-job.state'))).toBe(true);
  });

  it('returns [] for a missing admission directory instead of throwing', () => {
    expect(listJobs({ admissionDir: '/nonexistent/psi-admissions', procRoot: '/proc' })).toEqual([]);
  });

  it('renders a job line containing the admission id and pid', () => {
    const { procRoot, admissionDir } = makeRoot();
    fixtureProc(procRoot, 100, { startTicks: 111 });
    fixtureRecord(admissionDir, 'live-job', { pid: 100, start_ticks: 111, priority: 10, state: 'active' });
    const line = formatJob(listJobs({ admissionDir, procRoot })[0]);
    expect(line).toContain('live-job');
    expect(line).toContain('100');
  });
});

describe('killJob reuse-safety refusals', () => {
  it('REFUSES a recycled pid and sends NO signal', async () => {
    const { procRoot, admissionDir } = makeRoot();
    // pid 200 is alive but is a DIFFERENT process than the one admitted.
    fixtureProc(procRoot, 200, { startTicks: 999 });
    fixtureRecord(admissionDir, 'recycled-job', { pid: 200, start_ticks: 222, state: 'active' });

    const sent: Array<[number, string]> = [];
    const res = await killJob('recycled-job', {
      admissionDir, procRoot, selfPid: 1,
      killFn: (pid: number, sig: string) => { sent.push([pid, sig]); },
      sleepFn: async () => {},
    });

    expect(res.ok).toBe(false);
    expect(res.outcome).toBe('refused:recycled');
    // The property that matters: a bystander was never signalled.
    expect(sent).toEqual([]);
  });

  it('REFUSES a dead pid and sends NO signal', async () => {
    const { procRoot, admissionDir } = makeRoot();
    fixtureRecord(admissionDir, 'gone-job', { pid: 300, start_ticks: 333, state: 'active' });
    const sent: Array<[number, string]> = [];
    const res = await killJob('gone-job', {
      admissionDir, procRoot, selfPid: 1,
      killFn: (pid: number, sig: string) => { sent.push([pid, sig]); },
      sleepFn: async () => {},
    });
    expect(res.ok).toBe(false);
    expect(res.outcome).toBe('refused:gone');
    expect(sent).toEqual([]);
  });

  it('REFUSES to signal our own process group', async () => {
    const { procRoot, admissionDir } = makeRoot();
    // Our own pid 500 sits in process group 400, and 400 is the admitted job.
    fixtureProc(procRoot, 400, { startTicks: 444, pgid: 400 });
    fixtureProc(procRoot, 500, { startTicks: 555, pgid: 400 });
    fixtureRecord(admissionDir, 'self-job', { pid: 400, start_ticks: 444, state: 'active' });

    const sent: Array<[number, string]> = [];
    const res = await killJob('self-job', {
      admissionDir, procRoot, selfPid: 500,
      killFn: (pid: number, sig: string) => { sent.push([pid, sig]); },
      sleepFn: async () => {},
    });
    expect(res.ok).toBe(false);
    expect(res.outcome).toBe('refused:self');
    expect(sent).toEqual([]);
  });

  it('reports not-found for an unknown admission id', async () => {
    const { procRoot, admissionDir } = makeRoot();
    const sent: Array<[number, string]> = [];
    const res = await killJob('nope', {
      admissionDir, procRoot, selfPid: 1,
      killFn: (pid: number, sig: string) => { sent.push([pid, sig]); },
      sleepFn: async () => {},
    });
    expect(res.outcome).toBe('not-found');
    expect(sent).toEqual([]);
  });
});

describe('killJob signalling', () => {
  it('SIGTERMs the process GROUP and stops escalating once the job exits', async () => {
    const { procRoot, admissionDir } = makeRoot();
    fixtureProc(procRoot, 100, { startTicks: 111 });
    fixtureRecord(admissionDir, 'live-job', { pid: 100, start_ticks: 111, state: 'active' });

    const sent: Array<[number, string]> = [];
    const res = await killJob('live-job', {
      admissionDir, procRoot, selfPid: 1, graceMs: 1000,
      killFn: (pid: number, sig: string) => { sent.push([pid, sig]); },
      // The process exits during the first grace poll.
      sleepFn: async () => { rmSync(join(procRoot, '100'), { recursive: true, force: true }); },
    });

    expect(res.ok).toBe(true);
    expect(res.outcome).toBe('terminated');
    // Negative pid == process group, matching pc-heavy's `kill -TERM -- "-<pid>"`.
    // Signalling only the leader leaves the npm→node→vitest children orphaned.
    expect(sent).toEqual([[-100, 'SIGTERM']]);
  });

  it('escalates to SIGKILL on the group when the job survives the grace window', async () => {
    const { procRoot, admissionDir } = makeRoot();
    fixtureProc(procRoot, 100, { startTicks: 111 });
    fixtureRecord(admissionDir, 'stubborn', { pid: 100, start_ticks: 111, state: 'active' });

    const sent: Array<[number, string]> = [];
    const res = await killJob('stubborn', {
      admissionDir, procRoot, selfPid: 1, graceMs: 500,
      killFn: (pid: number, sig: string) => { sent.push([pid, sig]); },
      sleepFn: async () => {}, // process never exits
    });

    expect(sent).toEqual([[-100, 'SIGTERM'], [-100, 'SIGKILL']]);
    expect(res.outcome).toBe('still-alive');
    expect(res.ok).toBe(false);
  });

  it('does not escalate onto a pid that was recycled DURING the grace window', async () => {
    const { procRoot, admissionDir } = makeRoot();
    fixtureProc(procRoot, 100, { startTicks: 111 });
    fixtureRecord(admissionDir, 'racy', { pid: 100, start_ticks: 111, state: 'active' });

    const sent: Array<[number, string]> = [];
    const res = await killJob('racy', {
      admissionDir, procRoot, selfPid: 1, graceMs: 1000,
      killFn: (pid: number, sig: string) => { sent.push([pid, sig]); },
      // The job exits and the pid is immediately reused by something else. A
      // liveness-only check (`kill -0`) would read "still alive" here and
      // SIGKILL the newcomer; re-verifying start_ticks is what prevents it.
      sleepFn: async () => { fixtureProc(procRoot, 100, { startTicks: 777 }); },
    });

    expect(res.outcome).toBe('terminated');
    expect(sent).toEqual([[-100, 'SIGTERM']]);
  });

  it('dry-run verifies identity but sends nothing', async () => {
    const { procRoot, admissionDir } = makeRoot();
    fixtureProc(procRoot, 100, { startTicks: 111 });
    fixtureRecord(admissionDir, 'live-job', { pid: 100, start_ticks: 111, state: 'active' });
    const sent: Array<[number, string]> = [];
    const res = await killJob('live-job', {
      admissionDir, procRoot, selfPid: 1, dryRun: true,
      killFn: (pid: number, sig: string) => { sent.push([pid, sig]); },
      sleepFn: async () => {},
    });
    expect(res.ok).toBe(true);
    expect(res.outcome).toBe('dry-run');
    expect(sent).toEqual([]);
  });
});

describe('falsifiability control', () => {
  /**
   * A guard test that has never failed is a guard you have not tested. The
   * subject here is an imported MODULE, so the sanctioned way to prove these
   * assertions discriminate is a deliberately-wrong implementation kept
   * PERMANENTLY beside them as a control — never a mutation of the shared tree
   * (git-sync sweeps the whole checkout on a schedule and would commit it).
   *
   * This control is the tempting shortcut the real code deliberately rejects:
   * "the pid is alive, so signal it" — i.e. `kill -0`, ignoring start_ticks.
   */
  function classifyLivenessOnly(record: { pid?: string }, liveTicks: string | null) {
    return liveTicks === null ? 'gone' : 'live';
  }

  it('the naive liveness-only rule accepts a recycled pid that the real rule refuses', () => {
    const record = { pid: '200', start_ticks: '222' };
    const liveTicksOfSomeoneElse = '999';

    // The wrong implementation would greenlight signalling a bystander...
    expect(classifyLivenessOnly(record, liveTicksOfSomeoneElse)).toBe('live');
    // ...which is exactly what the real one refuses. If this ever inverts, the
    // refusal tests above have stopped discriminating and are passing vacuously.
    expect(classifyRecord(record, liveTicksOfSomeoneElse)).toBe('recycled');
  });

  it('calibration: both rules agree on a genuinely live job, so the control is not simply always-wrong', () => {
    const record = { pid: '100', start_ticks: '111' };
    expect(classifyLivenessOnly(record, '111')).toBe('live');
    expect(classifyRecord(record, '111')).toBe('live');
  });
});

describe('admission dir resolution mirrors pc-heavy.sh', () => {
  it('honours PC_HEAVY_ADMISSION_DIR, then PC_HEAVY_DIR, then XDG_RUNTIME_DIR, then /tmp', () => {
    expect(resolveAdmissionDir({ PC_HEAVY_ADMISSION_DIR: '/a' })).toBe('/a');
    expect(resolveAdmissionDir({ PC_HEAVY_DIR: '/b' })).toBe('/b/psi-admissions');
    expect(resolveAdmissionDir({ XDG_RUNTIME_DIR: '/c' })).toBe('/c/pc-heavy-slots/psi-admissions');
    expect(resolveAdmissionDir({})).toBe('/tmp/pc-heavy-slots/psi-admissions');
  });
});

describe('parseFlags', () => {
  it('parses bare and valued long flags', () => {
    const f = parseFlags(['kill', 'id', '--dry-run', '--grace-ms=250']);
    expect(f['dry-run']).toBe(true);
    expect(f['grace-ms']).toBe('250');
    expect(f.missing).toBeUndefined();
  });
});
