/**
 * Summarize a `vm/sample-footprint.py` JSON-lines capture into per-class CPU and memory.
 *
 * Plan agent-capacity-and-cost-gcp-2026-09-30, S7 (WI-10004395): the Papercusp Server's own
 * cost on a cloud VM, so the capacity model can subtract a fixed per-VM overhead before it
 * divides by agents.
 *
 * Two CPU numbers, deliberately kept apart:
 * - `totalCpuPct` comes from the cgroup's `cpu.stat usage_usec`. It is exact and includes
 *   processes that started and exited between two samples (short `git` runs, workers).
 * - per-class `cpuPct` comes from each process's utime+stime delta, and only counts processes
 *   seen at BOTH ends of an interval. The gap between their sum and the total is reported as
 *   `unattributedCpuPct` rather than hidden.
 *
 * CPU percentages are of ONE core (100 = one core busy), the unit `top` uses.
 *
 *   npx tsx scripts/agent-capacity/footprint-summary.ts <capture.jsonl> [--from=<s>] [--to=<s>]
 *
 * `--from` / `--to` are seconds relative to the first sample, so a boot phase and a steady
 * phase can be summarized separately from one capture.
 */
import { readFileSync } from 'node:fs';
import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';

export interface ProcRow {
  pid: number;
  ppid: number;
  comm: string;
  cls: string;
  rss_kb: number;
  anon_kb: number;
  ticks: number;
}
export interface Sample {
  t: number;
  cg: { mem?: number; anon?: number; file?: number; cpu_usec?: number };
  procs: ProcRow[];
}
export interface Header {
  host: string;
  label: string;
  cgroup: string;
  clk_tck: number;
  nproc: number;
  mem_total_kb: number;
  interval: number;
  started: number;
}
export interface Capture {
  header: Header;
  samples: Sample[];
}

export interface Stat {
  mean: number;
  p95: number;
  max: number;
}
export interface ClassSummary {
  cls: string;
  /** Distinct pids seen in the window. */
  processes: number;
  cpuPct: Stat;
  rssMb: Stat;
  anonMb: Stat;
}
export interface Summary {
  host: string;
  label: string;
  windowSec: number;
  samples: number;
  totalCpuPct: Stat;
  unattributedCpuPct: number;
  cgroupMemMb: Stat;
  cgroupAnonMb: Stat;
  classes: ClassSummary[];
}

export function parseCapture(text: string): Capture {
  let header: Header | null = null;
  const samples: Sample[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as { header?: Header } & Partial<Sample>;
    if (row.header) {
      // A re-run appends a second header to the same file; keep the first capture only.
      if (header) break;
      header = row.header;
    } else if (typeof row.t === 'number') {
      samples.push({ t: row.t, cg: row.cg ?? {}, procs: row.procs ?? [] });
    }
  }
  if (!header) throw new Error('capture has no header line');
  return { header, samples };
}

export function stat(values: number[]): Stat {
  if (values.length === 0) return { mean: 0, p95: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)];
  return { mean, p95, max: sorted[sorted.length - 1] };
}

const MB = 1024 * 1024;

export function summarize(capture: Capture, opts: { from?: number; to?: number } = {}): Summary {
  const { header } = capture;
  const t0 = capture.samples[0]?.t ?? 0;
  const samples = capture.samples.filter((s) => {
    const rel = s.t - t0;
    return (opts.from === undefined || rel >= opts.from) && (opts.to === undefined || rel <= opts.to);
  });
  const hz = header.clk_tck || 100;

  const totalCpu: number[] = [];
  const perClassCpu = new Map<string, number[]>();
  let attributedSum = 0;
  let totalSum = 0;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1];
    const b = samples[i];
    const dt = b.t - a.t;
    if (dt <= 0) continue;
    const intervalCpu = new Map<string, number>();
    const before = new Map(a.procs.map((p) => [p.pid, p]));
    for (const p of b.procs) {
      const prev = before.get(p.pid);
      // A recycled pid (different comm, or ticks going backwards) is a different process.
      if (!prev || prev.comm !== p.comm || p.ticks < prev.ticks) continue;
      const pct = ((p.ticks - prev.ticks) / hz / dt) * 100;
      intervalCpu.set(p.cls, (intervalCpu.get(p.cls) ?? 0) + pct);
    }
    const attributed = [...intervalCpu.values()].reduce((s, v) => s + v, 0);
    if (a.cg.cpu_usec !== undefined && b.cg.cpu_usec !== undefined) {
      const total = ((b.cg.cpu_usec - a.cg.cpu_usec) / 1e6 / dt) * 100;
      totalCpu.push(total);
      totalSum += total;
      attributedSum += attributed;
    }
    for (const [cls, pct] of intervalCpu) {
      const list = perClassCpu.get(cls) ?? [];
      list.push(pct);
      perClassCpu.set(cls, list);
    }
  }
  const intervals = Math.max(0, samples.length - 1);

  const classes = new Map<string, { pids: Set<number>; rss: number[]; anon: number[] }>();
  for (const s of samples) {
    const tick = new Map<string, { rss: number; anon: number }>();
    for (const p of s.procs) {
      const cur = tick.get(p.cls) ?? { rss: 0, anon: 0 };
      cur.rss += p.rss_kb;
      cur.anon += p.anon_kb;
      tick.set(p.cls, cur);
      const c = classes.get(p.cls) ?? { pids: new Set<number>(), rss: [], anon: [] };
      c.pids.add(p.pid);
      classes.set(p.cls, c);
    }
    // A class absent from this sample contributes 0 MB, so short-lived classes average low.
    for (const [cls, c] of classes) {
      const cur = tick.get(cls) ?? { rss: 0, anon: 0 };
      c.rss.push(cur.rss / 1024);
      c.anon.push(cur.anon / 1024);
    }
  }

  const classSummaries: ClassSummary[] = [...classes.entries()].map(([cls, c]) => {
    // Pad with zeros for intervals where the class used no measurable CPU.
    const cpu = [...(perClassCpu.get(cls) ?? [])];
    while (cpu.length < intervals) cpu.push(0);
    return { cls, processes: c.pids.size, cpuPct: stat(cpu), rssMb: stat(c.rss), anonMb: stat(c.anon) };
  });
  classSummaries.sort((x, y) => y.rssMb.mean - x.rssMb.mean);

  return {
    host: header.host,
    label: header.label,
    windowSec: samples.length > 1 ? samples[samples.length - 1].t - samples[0].t : 0,
    samples: samples.length,
    totalCpuPct: stat(totalCpu),
    unattributedCpuPct: totalCpu.length ? (totalSum - attributedSum) / totalCpu.length : 0,
    cgroupMemMb: stat(samples.flatMap((s) => (s.cg.mem === undefined ? [] : [s.cg.mem / MB]))),
    cgroupAnonMb: stat(samples.flatMap((s) => (s.cg.anon === undefined ? [] : [s.cg.anon / MB]))),
    classes: classSummaries,
  };
}

function fmt(s: Stat, digits = 1): string {
  return `${s.mean.toFixed(digits)} / ${s.p95.toFixed(digits)} / ${s.max.toFixed(digits)}`;
}

export function renderTable(s: Summary): string {
  const lines = [
    `host=${s.host} label=${s.label} window=${Math.round(s.windowSec)}s samples=${s.samples}`,
    `total CPU % of one core (mean / p95 / max): ${fmt(s.totalCpuPct)}  unattributed mean: ${s.unattributedCpuPct.toFixed(1)}`,
    `cgroup memory MB: ${fmt(s.cgroupMemMb, 0)}  of which anon: ${fmt(s.cgroupAnonMb, 0)}`,
    '',
    'class | procs | CPU % (mean/p95/max) | RSS MB (mean/p95/max) | anon MB (mean/p95/max)',
    ...s.classes.map((c) => `${c.cls} | ${c.processes} | ${fmt(c.cpuPct)} | ${fmt(c.rssMb, 0)} | ${fmt(c.anonMb, 0)}`),
  ];
  return lines.join('\n');
}

function num(argv: string[], name: string): number | undefined {
  const raw = argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  return raw === undefined ? undefined : Number(raw);
}

if (isCliEntry(import.meta.url)) {
  const [file, ...rest] = process.argv.slice(2);
  if (!file) {
    console.error('usage: footprint-summary.ts <capture.jsonl> [--from=<s>] [--to=<s>] [--json]');
    process.exit(2);
  }
  const summary = summarize(parseCapture(readFileSync(file, 'utf8')), { from: num(rest, 'from'), to: num(rest, 'to') });
  console.log(rest.includes('--json') ? JSON.stringify(summary, null, 2) : renderTable(summary));
}
