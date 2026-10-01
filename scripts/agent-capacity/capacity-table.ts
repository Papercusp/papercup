/**
 * Build the P-005 capacity table from the ramp results pulled back from the ramp VMs
 * (plan agent-capacity-and-cost-gcp-2026-09-30, P-005 / WI-10004376; method per D-009).
 *
 *   npx tsx scripts/agent-capacity/capacity-table.ts <root> [--disk-gb 120] [--json]
 *
 * `<root>/<machine-type>/` holds what `vm/p005-ramp.sh` left on one VM:
 *   ramp-<label>.log                          its stdout (the RAMP_STEP_END verdicts)
 *   fp/p005-<label>-n<N>.jsonl                the capdrv.slice footprint capture per step
 *   runs/p005-<label>-n<N>/agents.jsonl       one row per replayed session per step
 *
 * Capacity for a (machine, workload) is the largest N whose step passed before the first
 * SATURATED step; the ramp script owns that verdict, so it is read, never recomputed here. A
 * ramp that never saturated is CENSORED: its capacity is at least the largest N tested, and
 * the cost it implies is an upper bound. Cost per agent-month is the machine's list price
 * (gcp-rails, disk included) x 730 h / ACTIVE agents, where active agents is the mean number of
 * sessions the capacity step actually held in flight (`achieved=` on its verdict line, capped at
 * N). Dividing by N overstated capacity whenever slots sat idle between sessions: the lever ramp
 * (D-020) passed n=96 on e2-custom-16-32768 with only 73.2 in flight and flat throughput, and the
 * table priced it at 96. Per-agent cores and anon are normalized the same way.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseCapture, summarize, type Capture } from './footprint-summary';
import { hourlyPriceUsd } from './gcp-rails';

export interface StepVerdict {
  label: string;
  n: number;
  ok: boolean;
  /**
   * The step never held N sessions in flight (WI-10004672), so it measured the driver, not the
   * machine: it is neither a pass nor a saturation, and it ends what the ramp can say.
   */
  underdriven: boolean;
  /** Why the step saturated (`driver-rc=1,failed=2`) or was underdriven (`achieved=12.7/64`); null when it passed. */
  reason: string | null;
  wallSlowdown: number | null;
  /** Mean sessions in flight over the step (`achieved=X/N`); null on a log that predates the field. */
  achieved: number | null;
}

/** The step verdicts in a ramp log, in order. */
export function parseRampLog(text: string): StepVerdict[] {
  const out: StepVerdict[] = [];
  for (const line of text.split('\n')) {
    const m = /^RAMP_STEP_END p005-(.+)-n(\d+) n=\d+ rc=-?\d+ (OK|SATURATED reason=(\S*)|UNDERDRIVEN (achieved=\S*))(.*)$/.exec(line.trim());
    if (!m) continue;
    const slow = /wallSlowdown=([\d.]+)/.exec(m[6]);
    const ach = /(?:^|\s)achieved=([\d.]+)\/\d+/.exec(line.trim());
    out.push({
      label: m[1],
      n: Number(m[2]),
      ok: m[3] === 'OK',
      underdriven: m[5] !== undefined,
      reason: m[4] ?? m[5] ?? null,
      wallSlowdown: slow ? Number(slow[1]) : null,
      achieved: ach ? Number(ach[1]) : null,
    });
  }
  return out;
}

export interface SessionRow {
  memPeakBytes: number | null;
  cpuUsec: number | null;
  /** The replay's tool outcomes differed from the recording's (load-driver), so its CPU is not the recorded session's. */
  toolDiverged?: boolean | null;
}

export interface CapacityRow {
  machineType: string;
  label: string;
  /** Largest N that passed; 0 when even the first step saturated. */
  capacity: number;
  /** True when no step saturated, so `capacity` is a lower bound. */
  censored: boolean;
  saturatedAt: { n: number; reason: string } | null;
  /** The ramp stopped at an UNDERDRIVEN step: capacity beyond the last pass is unmeasured, not refuted. */
  underdrivenAt: { n: number; reason: string } | null;
  /** Measured at the capacity step (null when there is none). */
  wallSlowdown: number | null;
  /**
   * Mean sessions in flight at the capacity step, capped at `capacity`; equals `capacity` when the
   * log has no `achieved=` field. Every per-agent figure below divides by this, not by N.
   */
  activeAgents: number | null;
  coresPerAgent: number | null;
  sliceAnonMbPerAgent: number | null;
  sessionPeakMiB: { p50: number; p95: number } | null;
  /**
   * Share of the sessions replayed at the capacity step whose tool outcomes diverged from the
   * recording (null when there are none). In P-005 this is a fixed set of recordings that diverge
   * on every run, so a high share means the capacity rests partly on replays that did different
   * tool work than the real session did.
   */
  toolDivergedShare: number | null;
  usdPerHour: number;
  /** null when capacity is 0. An upper bound when `censored`. */
  usdPerAgentMonth: number | null;
  /**
   * The same capacity priced at the measured SPOT rate (spot does not change what a machine can
   * hold). null when capacity is 0 or the family has no measured spot price (WI-10004749).
   */
  usdPerAgentMonthSpot: number | null;
}

function spotHourlyOrNull(machineType: string, diskGb: number): number | null {
  try {
    return hourlyPriceUsd(machineType, diskGb, { spot: true });
  } catch {
    return null;
  }
}

const pct = (xs: number[], p: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
};

export function capacityRow(
  machineType: string,
  label: string,
  steps: readonly StepVerdict[],
  atCapacity: { capture: Capture | null; sessions: readonly SessionRow[] },
  diskGb: number,
): CapacityRow {
  const mine = steps.filter((s) => s.label === label);
  const firstStop = mine.find((s) => !s.ok) ?? null;
  const firstSat = firstStop && !firstStop.underdriven ? firstStop : null;
  const passed = mine.filter((s) => s.ok && (!firstStop || s.n < firstStop.n));
  const best = passed.at(-1) ?? null;
  const capacity = best?.n ?? 0;
  const activeAgents = best ? Math.min(capacity, best.achieved ?? capacity) : null;
  const usdPerHour = hourlyPriceUsd(machineType, diskGb);
  const spotPerHour = spotHourlyOrNull(machineType, diskGb);
  let coresPerAgent: number | null = null;
  let sliceAnonMbPerAgent: number | null = null;
  if (best && activeAgents && atCapacity.capture && atCapacity.capture.samples.length > 1) {
    const s = summarize(atCapacity.capture);
    coresPerAgent = s.totalCpuPct.mean / 100 / activeAgents;
    const t0 = (atCapacity.capture.samples[0].cg.anon ?? 0) / 2 ** 20;
    sliceAnonMbPerAgent = Math.max(0, s.cgroupAnonMb.p95 - t0) / activeAgents;
  }
  const peaks = atCapacity.sessions.map((r) => r.memPeakBytes).filter((b): b is number => b !== null).map((b) => b / 2 ** 20);
  const diverged = atCapacity.sessions.filter((r) => r.toolDiverged === true).length;
  return {
    machineType,
    label,
    capacity,
    censored: firstSat === null && best !== null,
    saturatedAt: firstSat ? { n: firstSat.n, reason: firstSat.reason ?? '' } : null,
    underdrivenAt: firstStop?.underdriven ? { n: firstStop.n, reason: firstStop.reason ?? '' } : null,
    wallSlowdown: best?.wallSlowdown ?? null,
    activeAgents,
    coresPerAgent,
    sliceAnonMbPerAgent,
    sessionPeakMiB: best && peaks.length ? { p50: pct(peaks, 50), p95: pct(peaks, 95) } : null,
    toolDivergedShare: best && atCapacity.sessions.length ? diverged / atCapacity.sessions.length : null,
    usdPerHour,
    usdPerAgentMonth: activeAgents ? (usdPerHour * 730) / activeAgents : null,
    usdPerAgentMonthSpot: activeAgents && spotPerHour !== null ? (spotPerHour * 730) / activeAgents : null,
  };
}

const f = (x: number | null, d = 2) => (x === null ? '—' : x.toFixed(d));

export function renderMarkdown(rows: readonly CapacityRow[]): string {
  const head =
    '| machine | workload | capacity N | saturated at | slowdown at N | tool-diverged % | cores/agent | anon MB/agent | session peak MiB p50/p95 | active agents at N | $/h | $/agent-month | spot $/agent-month |';
  const out = [head, '|' + ' --- |'.repeat(13)];
  for (const r of rows) {
    out.push(
      `| ${r.machineType} | ${r.label} | ${r.censored ? '≥' : ''}${r.capacity} | ${r.saturatedAt ? `${r.saturatedAt.n} (${r.saturatedAt.reason})` : r.underdrivenAt ? `not measured past ${r.capacity} (underdriven at ${r.underdrivenAt.n}, ${r.underdrivenAt.reason})` : 'never'} | ${f(r.wallSlowdown)} | ${r.toolDivergedShare === null ? '—' : f(r.toolDivergedShare * 100, 0)} | ${f(r.coresPerAgent, 3)} | ${f(r.sliceAnonMbPerAgent, 0)} | ${r.sessionPeakMiB ? `${f(r.sessionPeakMiB.p50, 0)}/${f(r.sessionPeakMiB.p95, 0)}` : '—'} | ${f(r.activeAgents, 1)} | ${f(r.usdPerHour, 3)} | ${r.usdPerAgentMonth === null ? '—' : `${r.censored ? '≤' : ''}${f(r.usdPerAgentMonth)}`} | ${r.usdPerAgentMonthSpot === null ? '—' : `${r.censored ? '≤' : ''}${f(r.usdPerAgentMonthSpot)}`} |`,
    );
  }
  return out.join('\n');
}

/** Every (machine, workload) row under `root`, sorted by workload then price. */
export function buildTable(root: string, diskGb: number): CapacityRow[] {
  const rows: CapacityRow[] = [];
  for (const mt of readdirSync(root).sort()) {
    const dir = path.join(root, mt);
    if (!existsSync(dir) || !/^(e2|n2|n2d)-/.test(mt)) continue;
    for (const log of readdirSync(dir).filter((n) => /^ramp-.+\.log$/.test(n))) {
      const label = log.slice('ramp-'.length, -'.log'.length);
      const steps = parseRampLog(readFileSync(path.join(dir, log), 'utf8'));
      const probe = capacityRow(mt, label, steps, { capture: null, sessions: [] }, diskGb);
      const run = `p005-${label}-n${probe.capacity}`;
      const fp = path.join(dir, 'fp', `${run}.jsonl`);
      const agents = path.join(dir, 'runs', run, 'agents.jsonl');
      const capture = probe.capacity > 0 && existsSync(fp) ? parseCapture(readFileSync(fp, 'utf8')) : null;
      const sessions =
        probe.capacity > 0 && existsSync(agents)
          ? readFileSync(agents, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as SessionRow)
          : [];
      rows.push(capacityRow(mt, label, steps, { capture, sessions }, diskGb));
    }
  }
  return rows.sort((a, b) => a.label.localeCompare(b.label) || a.usdPerHour - b.usdPerHour);
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (process.argv[1] && /capacity-table\.ts$/.test(process.argv[1])) {
  const root = process.argv[2];
  if (!root || root.startsWith('--')) {
    console.error('usage: capacity-table.ts <root> [--disk-gb 120] [--json]');
    process.exit(2);
  }
  const rows = buildTable(root, Number(arg('disk-gb') ?? 120));
  console.log(process.argv.includes('--json') ? JSON.stringify(rows, null, 2) : renderMarkdown(rows));
}
