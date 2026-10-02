/**
 * WI-10005184: pc-heavy's per-slot memory reserve was a fixed 14 GiB because an
 * admitted job runs in its CALLER's cgroup, so nothing measured what one job
 * actually used. The preemptible monitor now walks the job's own process tree
 * and appends one peak line per job to a bounded ledger
 * (<PC_HEAVY_DIR>/job-peaks.tsv), which a later slice derives the reserve from.
 *
 * The property guarded first is that the measurement covers the WHOLE job tree:
 * the allocation happens in a grandchild, and the leader alone holds far less
 * than the asserted floor, so a leader-only (or cgroup-of-the-caller)
 * measurement fails the first test.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pcHeavyFixtureOptions } from './testing/pc-heavy-fixture';

const SCRIPT = process.env.PROBE_SCRIPT ?? resolve(__dirname, '../../../scripts/pc-heavy.sh');
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pc-heavy-peak-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

type Peak = { at: number; anonMib: number; rssMib: number; samples: number; secs: number; exit: number; label: string };

function readLedger(path: string): Peak[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => {
    const m = /^at=(\d+) anon_mib=(\d+) rss_mib=(\d+) samples=(\d+) secs=(\d+) exit=(\d+) label=(.*)$/.exec(line);
    if (!m) throw new Error(`unparseable ledger line: ${line}`);
    return {
      at: Number(m[1]), anonMib: Number(m[2]), rssMib: Number(m[3]), samples: Number(m[4]),
      secs: Number(m[5]), exit: Number(m[6]), label: m[7],
    };
  });
}

/** Drive the real asynchronous monitor directly, outside the host's admission queue. */
function monitored(command: string[], env: Record<string, string> = {}) {
  return spawnSync('bash', [SCRIPT, '--pc-heavy-internal-preempt-run',
    String(process.pid), join(dir, 'exclusive-intent'), ...command], {
    ...pcHeavyFixtureOptions(dir, {
      PATH: process.env.PATH ?? '',
      PC_HEAVY_NO_SELF_COPY: '1',
      PC_HEAVY_PREEMPT_PID_DIR: dir,
      PC_HEAVY_PREEMPT_POLL_SEC: '0.02',
      PC_HEAVY_PREEMPT_EXCLUSIVE: '0',
      PC_HEAVY_PSI_ADMISSION: '0',
      PC_HEAVY_PEAK_SAMPLE_SEC: '1',
      ...env,
    }), encoding: 'utf8', timeout: 20_000,
  });
}

/** A node leader that spawns a child which holds `mib` of touched memory for `holdMs`. */
function allocatingTree(mib: number, holdMs: number): string[] {
  const grandchild = `const b=Buffer.alloc(${mib}*1024*1024,1);setTimeout(()=>{process.stdout.write(String(b[1]))},${holdMs})`;
  const leader = `const r=require('node:child_process').spawnSync(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'inherit'});process.exit(r.status??1)`;
  return [process.execPath, '-e', leader];
}

describe.skipIf(process.platform !== 'linux')('pc-heavy per-job peak ledger (WI-10005184)', () => {
  it('records the peak of the whole job tree, not just the leader', () => {
    const run = monitored(allocatingTree(192, 2500), { PC_HEAVY_PEAK_LABEL: 'tree probe' });
    expect(run.status, run.stderr).toBe(0);
    const peaks = readLedger(join(dir, 'job-peaks.tsv'));
    expect(peaks).toHaveLength(1);
    const [peak] = peaks;
    // The leader alone holds well under 150 MiB anonymous; only the grandchild's
    // 192 MiB buffer can lift the sum past this floor.
    expect(peak.anonMib).toBeGreaterThanOrEqual(150);
    expect(peak.rssMib).toBeGreaterThanOrEqual(peak.anonMib);
    expect(peak.samples).toBeGreaterThanOrEqual(2);
    expect(peak.exit).toBe(0);
    expect(peak.label).toBe('tree probe');
  }, 30_000);

  it('records a killed job with its exit status, so an OOM-shaped death still leaves a peak', () => {
    const run = monitored([process.execPath, '-e',
      "const b=Buffer.alloc(64*1024*1024,1);setTimeout(()=>process.kill(process.pid,'SIGKILL'),1500)"]);
    expect(run.status).toBe(137);
    const [peak] = readLedger(join(dir, 'job-peaks.tsv'));
    expect(peak?.exit).toBe(137);
    expect(peak?.anonMib).toBeGreaterThanOrEqual(48);
  }, 30_000);

  it.each([[''], ['0'], ['off']])('writes nothing when PC_HEAVY_PEAK_LEDGER=%j', (value) => {
    const run = monitored([process.execPath, '-e', 'setTimeout(()=>{},300)'], { PC_HEAVY_PEAK_LEDGER: value });
    expect(run.status, run.stderr).toBe(0);
    expect(existsSync(join(dir, 'job-peaks.tsv'))).toBe(false);
  }, 30_000);

  it('honours an explicit ledger path', () => {
    const ledger = join(dir, 'nested', 'peaks.tsv');
    const run = monitored([process.execPath, '-e', 'setTimeout(()=>{},300)'], { PC_HEAVY_PEAK_LEDGER: ledger });
    expect(run.status, run.stderr).toBe(0);
    expect(readLedger(ledger)).toHaveLength(1);
  }, 30_000);

  it('trims the ledger back to PC_HEAVY_PEAK_LEDGER_MAX once it reaches twice that', () => {
    const ledger = join(dir, 'job-peaks.tsv');
    const old = [1, 2, 3].map((n) => `at=${n} anon_mib=${n} rss_mib=${n} samples=1 secs=1 exit=0 label=old-${n}`);
    writeFileSync(ledger, `${old.join('\n')}\n`);
    const run = monitored([process.execPath, '-e', 'setTimeout(()=>{},300)'],
      { PC_HEAVY_PEAK_LEDGER_MAX: '2', PC_HEAVY_PEAK_LABEL: 'newest' });
    expect(run.status, run.stderr).toBe(0);
    const peaks = readLedger(ledger);
    expect(peaks.map((p) => p.label)).toEqual(['old-3', 'newest']);
  }, 30_000);

  it('labels a job from its command words through the ordinary admission route, without leaking the label to the job', () => {
    const job = join(dir, 'probe-job.sh');
    writeFileSync(job, '#!/usr/bin/env bash\necho "LABEL_ENV=${PC_HEAVY_PEAK_LABEL-unset}"\nsleep 1.2\n');
    const run = spawnSync('bash', [SCRIPT, '--', 'bash', job, '--verbose', 'first', 'second'], {
      ...pcHeavyFixtureOptions(dir, {
        PATH: process.env.PATH ?? '',
        PC_HEAVY_NO_SELF_COPY: '1',
        PC_HEAVY_DIR: dir,
        PC_HEAVY_SLOTS: '1',
        PC_HEAVY_IONICE: '',
        PC_HEAVY_PREEMPTIBLE: '1',
        PC_HEAVY_PREEMPT_EXCLUSIVE: '0',
        PC_HEAVY_PREEMPT_POLL_SEC: '0.02',
        PC_HEAVY_PSI_ADMISSION: '0',
        PC_HEAVY_PEAK_SAMPLE_SEC: '1',
        PC_HEAVY_MEM_PSI_OVERRIDE: '0',
        PC_HEAVY_MEMAVAIL_GIB_OVERRIDE: '4096',
        PC_HEAVY_CGROUP_MEMORY_MAX_MIB_OVERRIDE: 'max',
        PC_HEAVY_CGROUP_MEMORY_CURRENT_MIB_OVERRIDE: '100',
      }), encoding: 'utf8', timeout: 20_000,
    });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain('LABEL_ENV=unset');
    const [peak] = readLedger(join(dir, 'job-peaks.tsv'));
    // Options are skipped, paths reduced to basenames, and the label capped at three words.
    expect(peak?.label).toBe('bash probe-job.sh first');
  }, 30_000);
});
