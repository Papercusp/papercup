import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildTable, parseRampLog, renderMarkdown } from './capacity-table';
import type { Header, Sample } from './footprint-summary';
import { hourlyPriceUsd } from './gcp-rails';

const MiB = 2 ** 20;
const header: Header = { host: 'cap-p005-s4', label: 'x', cgroup: '/sys/fs/cgroup/capdrv.slice', clk_tck: 100, nproc: 4, mem_total_kb: 16 * 1024 * 1024, interval: 5, started: 0 };

const end = (label: string, n: number, verdict: string) =>
  `RAMP_STEP_END p005-${label}-n${n} n=${n} rc=0 ${verdict} runs=${n} wallSlowdown=1.${n}0 diverged=0 toolDiverged=0 2026-10-01T03:20:00Z`;

/** A capture whose slice burns `cores` cores and holds `anonMb` of anon above a 100 MB t0. */
function capture(cores: number, anonMb: number): string {
  const s = (t: number, anon: number): Sample => ({ t, cg: { cpu_usec: t * cores * 1e6, anon: anon * MiB, mem: anon * 2 * MiB }, procs: [] });
  return [{ header }, s(0, 100), s(5, 100 + anonMb), s(10, 100 + anonMb)].map((r) => JSON.stringify(r)).join('\n') + '\n';
}

describe('capacity-table', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'captable-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function vm(mt: string, label: string, log: string[], at?: { n: number; cores: number; anonMb: number; peaksMiB: number[] }) {
    const dir = path.join(root, mt);
    mkdirSync(path.join(dir, 'fp'), { recursive: true });
    writeFileSync(path.join(dir, `ramp-${label}.log`), ['RAMP_STEP_START ignored', ...log, `RAMP_DONE ${label}`].join('\n') + '\n');
    if (!at) return;
    const run = `p005-${label}-n${at.n}`;
    writeFileSync(path.join(dir, 'fp', `${run}.jsonl`), capture(at.cores, at.anonMb));
    mkdirSync(path.join(dir, 'runs', run), { recursive: true });
    writeFileSync(path.join(dir, 'runs', run, 'agents.jsonl'), at.peaksMiB.map((p) => JSON.stringify({ memPeakBytes: p * MiB, cpuUsec: 1 })).join('\n') + '\n');
  }

  it('takes capacity from the last step that passed before the first SATURATED one, and measures at that step', () => {
    vm('e2-standard-4', 'mixed-normal', [end('mixed-normal', 1, 'OK'), end('mixed-normal', 2, 'OK'), end('mixed-normal', 4, 'SATURATED reason=wallSlowdown=1.80')], {
      n: 2,
      cores: 2,
      anonMb: 200,
      peaksMiB: [1024, 3072],
    });
    const [row] = buildTable(root, 120);
    expect(row).toMatchObject({ machineType: 'e2-standard-4', label: 'mixed-normal', capacity: 2, censored: false, saturatedAt: { n: 4, reason: 'wallSlowdown=1.80' }, wallSlowdown: 1.2 });
    expect(row.coresPerAgent).toBeCloseTo(1, 6); // 2 cores across 2 agents
    expect(row.sliceAnonMbPerAgent).toBeCloseTo(100, 6); // p95 anon net of the 100 MB t0, per agent
    expect(row.sessionPeakMiB).toEqual({ p50: 1024, p95: 3072 });
    expect(row.usdPerAgentMonth).toBeCloseTo((hourlyPriceUsd('e2-standard-4', 120) * 730) / 2, 9);
    expect(renderMarkdown([row])).toMatch(/\| e2-standard-4 \| mixed-normal \| 2 \| 4 \(wallSlowdown=1\.80\) \|/);
  });

  it('marks a ramp that never saturated as censored: capacity is a floor and the cost an upper bound', () => {
    vm('e2-standard-32', 'claude-normal', [end('claude-normal', 1, 'OK'), end('claude-normal', 2, 'OK')], { n: 2, cores: 1, anonMb: 50, peaksMiB: [512] });
    const [row] = buildTable(root, 120);
    expect(row).toMatchObject({ capacity: 2, censored: true, saturatedAt: null });
    expect(row.usdPerAgentMonth).not.toBeNull();
    const md = renderMarkdown([row]);
    expect(md).toMatch(/\| ≥2 \| never \|/);
    expect(md).toMatch(/\| ≤\d+\.\d{2} \|$/m);
  });

  it('gives capacity 0 and no cost when the first step saturates, and never reads a later OK step', () => {
    vm('e2-standard-4', 'mixed-heavy', [end('mixed-heavy', 1, 'SATURATED reason=oom_kill=1'), end('mixed-heavy', 2, 'OK')]);
    const [row] = buildTable(root, 120);
    expect(row).toMatchObject({ capacity: 0, censored: false, saturatedAt: { n: 1, reason: 'oom_kill=1' }, coresPerAgent: null, sessionPeakMiB: null, usdPerAgentMonth: null });
    expect(renderMarkdown([row]).split('\n')[2]).toMatch(/\| — \|$/);
  });

  it('parses only RAMP_STEP_END lines, keeping the saturation reason and slowdown', () => {
    const steps = parseRampLog(['noise', end('a-b', 8, 'OK'), end('a-b', 16, 'SATURATED reason=driver-rc=1,failed=2')].join('\n'));
    expect(steps).toEqual([
      { label: 'a-b', n: 8, ok: true, reason: null, wallSlowdown: 1.8 },
      { label: 'a-b', n: 16, ok: false, reason: 'driver-rc=1,failed=2', wallSlowdown: 1.16 },
    ]);
  });
});
