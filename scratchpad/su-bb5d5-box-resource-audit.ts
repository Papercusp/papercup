/**
 * WI-7441 — where the memory and CPU on this box ACTUALLY go.
 *
 * v2. v1 read `/proc/PID/smaps_rollup` unprivileged and silently failed on 2239 of 3426
 * processes, then printed a PSS table sorted by a column that was blank for 65% of the
 * box — postgres landed near the BOTTOM at 0.98 GB while holding 474 GB of RSS. That is
 * the same defect WI-7371 was about: an authoritative-looking figure answering a narrower
 * question than its label. So: one privileged batch read for PSS, and per-family COVERAGE
 * printed next to every number so an incomplete row cannot masquerade as a small one.
 *
 * Method:
 *  - PSS is the real footprint (a shared page is split across its mappers). RSS is shown
 *    only as a labelled upper bound — Σ RSS over this box is ~4x what the kernel reports.
 *  - CPU is sampled TWICE over wall-clock; /proc/PID/stat utime+stime is cumulative, so a
 *    single read answers "lifetime CPU-seconds", a different question from "busy now".
 *  - Σ PSS is cross-checked against MemTotal - MemAvailable.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';

const HZ = 100;
const SAMPLE_MS = 5000;
const PAGE = 4096;

type Proc = { pid: number; cmd: string; rssBytes: number; cpuTicks: number; user: string };

const uidCache = new Map<number, string>();
function userOf(pid: number): string {
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    const uid = Number(/^Uid:\s+(\d+)/m.exec(status)?.[1] ?? -1);
    if (!uidCache.has(uid)) {
      const line = readFileSync('/etc/passwd', 'utf8').split('\n').find((l) => l.split(':')[2] === String(uid));
      uidCache.set(uid, line ? line.split(':')[0] : String(uid));
    }
    return uidCache.get(uid)!;
  } catch { return '?'; }
}

function readProcs(withUser: boolean): Map<number, Proc> {
  const out = new Map<number, Proc>();
  for (const e of readdirSync('/proc')) {
    if (!/^\d+$/.test(e)) continue;
    const pid = Number(e);
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const close = stat.lastIndexOf(')');
      const rest = stat.slice(close + 2).split(' ');
      let cmd = '';
      try { cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim(); } catch { /* gone */ }
      if (!cmd) cmd = `[${stat.slice(stat.indexOf('(') + 1, close)}]`;
      out.set(pid, {
        pid,
        cmd,
        rssBytes: Number(rest[21]) * PAGE,
        cpuTicks: Number(rest[11]) + Number(rest[12]),
        user: withUser ? userOf(pid) : '',
      });
    } catch { /* raced with exit */ }
  }
  return out;
}

/** ONE privileged batch read — 3400 individual sudo calls would take minutes. */
function readAllPss(): Map<number, number> {
  const m = new Map<number, number>();
  let out = '';
  try {
    // A GLOB, never `grep -r /proc/`: recursive descends into /proc/PID/task/TID/ and
    // never finishes. The glob form reads 3173 rollups in ~33s (all of it kernel time
    // walking page tables), which is the price of a real PSS number.
    out = execFileSync('sudo', ['-n', 'bash', '-c', "grep -H '^Pss:' /proc/[0-9]*/smaps_rollup 2>/dev/null"], {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (e: unknown) {
    const err = e as { stdout?: string };
    out = err.stdout ?? ''; // grep exits nonzero on unreadable files; partial stdout is still good
  }
  for (const line of out.split('\n')) {
    const mm = /^\/proc\/(\d+)\/smaps_rollup:Pss:\s+(\d+) kB$/.exec(line);
    if (mm) m.set(Number(mm[1]), Number(mm[2]) * 1024);
  }
  return m;
}

function family(cmd: string): string {
  const c = cmd.toLowerCase();
  if (c.includes('psu-launcher')) return 'psu-launcher.mjs';
  if (/\bclaude\b/.test(c)) return 'claude (CLI agent)';
  if (c.includes('qemu')) return 'qemu (VMs)';
  if (c.includes('postgres')) return 'postgres';
  if (c.includes('chrome') || c.includes('chromium') || c.includes('msedge')) return 'browsers';
  if (c.includes('cargo') || c.includes('rustc') || c.includes('/target/')) return 'rust build';
  if (c.includes('vitest') || c.includes('esbuild') || c.includes('vite')) return 'vite/vitest/esbuild';
  if (c.includes('tsc ')) return 'tsc (typecheck)';
  if (c.includes('papercusp gui') || c.includes('tauri') || c.includes('webkit')) return 'papercusp desktop';
  if (c.includes('hono-host') || c.includes('embed-sidecar') || c.includes('serve.mjs')) return 'papercusp services';
  if (c.includes('kopia')) return 'kopia backup';
  if (c.includes('node') || c.includes('tsx ') || c.includes('npm ')) return 'node (other)';
  if (c.includes('xvfb') || c.includes('xterm') || c.includes('terminal')) return 'terminal/X';
  if (c.startsWith('[')) return 'kernel thread';
  return 'other';
}

const gb = (n: number) => `${(n / 1024 ** 3).toFixed(2)} GB`;

async function main() {
  const t0 = Date.now();
  const a = readProcs(false);
  await new Promise((r) => setTimeout(r, SAMPLE_MS));
  const b = readProcs(true);
  const elapsedSec = (Date.now() - t0) / 1000;
  const pssMap = readAllPss();

  const cores = readFileSync('/proc/cpuinfo', 'utf8').split('\n').filter((l) => l.startsWith('processor')).length;
  const meminfo = readFileSync('/proc/meminfo', 'utf8');
  const mi = (k: string) => Number(/(\d+) kB/.exec(meminfo.split('\n').find((l) => l.startsWith(k + ':')) ?? '')?.[1] ?? 0) * 1024;
  const memTotal = mi('MemTotal'), memAvail = mi('MemAvailable');

  type Agg = { procs: number; measured: number; rss: number; pss: number; cpuPct: number; lifeSec: number };
  const byFamily = new Map<string, Agg>();
  const byUser = new Map<string, Agg>();
  const rows: Array<{ pid: number; cmd: string; rss: number; pss: number; cpuPct: number; user: string; fam: string }> = [];
  let totalRss = 0, totalPss = 0, unmeasured = 0, totalCpu = 0;

  const bump = (m: Map<string, Agg>, k: string, rss: number, ps: number | undefined, cpu: number, life: number) => {
    const g = m.get(k) ?? { procs: 0, measured: 0, rss: 0, pss: 0, cpuPct: 0, lifeSec: 0 };
    g.procs += 1; g.rss += rss; g.cpuPct += cpu; g.lifeSec += life;
    if (ps !== undefined) { g.pss += ps; g.measured += 1; }
    m.set(k, g);
  };

  for (const [pid, p] of b) {
    if (p.cmd.startsWith('[')) continue;
    const prev = a.get(pid);
    const cpuPct = prev ? ((p.cpuTicks - prev.cpuTicks) / HZ / elapsedSec) * 100 : 0;
    const ps = pssMap.get(pid);
    const fam = family(p.cmd);
    bump(byFamily, fam, p.rssBytes, ps, cpuPct, p.cpuTicks / HZ);
    bump(byUser, p.user, p.rssBytes, ps, cpuPct, p.cpuTicks / HZ);
    totalRss += p.rssBytes; totalCpu += cpuPct;
    if (ps === undefined) unmeasured += 1; else totalPss += ps;
    rows.push({ pid, cmd: p.cmd, rss: p.rssBytes, pss: ps ?? 0, cpuPct, user: p.user, fam });
  }

  const cov = (g: Agg) => `${g.measured}/${g.procs}`;
  console.log(`# Box audit — ${new Date().toISOString()}`);
  console.log(`cores=${cores}  MemTotal=${gb(memTotal)}  MemAvailable=${gb(memAvail)}`);
  console.log(`userland processes=${rows.length}  PSS measured on ${rows.length - unmeasured} (${(((rows.length - unmeasured) / rows.length) * 100).toFixed(0)}%)  sample=${elapsedSec.toFixed(1)}s\n`);
  console.log(`Σ PSS (real footprint, what to trust) = ${gb(totalPss)}`);
  console.log(`kernel: MemTotal - MemAvailable       = ${gb(memTotal - memAvail)}   <- cross-check`);
  console.log(`Σ RSS  (upper bound, do NOT sum)      = ${gb(totalRss)}   (${(totalRss / (memTotal - memAvail)).toFixed(1)}x the real figure)`);
  console.log(`CPU busy now = ${totalCpu.toFixed(0)}% of ${cores * 100}%  (${(totalCpu / (cores * 100) * 100).toFixed(0)}% of the box)`);

  console.log(`\n## By family — PSS, with measurement coverage`);
  console.log('family'.padEnd(22), 'procs'.padStart(6), 'measured'.padStart(9), 'PSS'.padStart(10), 'RSS'.padStart(10), 'CPU%'.padStart(6), 'lifetimeCPU'.padStart(12));
  for (const [f, g] of [...byFamily.entries()].sort((x, y) => y[1].pss - x[1].pss)) {
    console.log(f.padEnd(22), String(g.procs).padStart(6), cov(g).padStart(9), gb(g.pss).padStart(10), gb(g.rss).padStart(10), `${g.cpuPct.toFixed(0)}%`.padStart(6), `${(g.lifeSec / 3600).toFixed(0)}h`.padStart(12));
  }

  console.log(`\n## By user`);
  for (const [u, g] of [...byUser.entries()].sort((x, y) => y[1].pss - x[1].pss).slice(0, 8)) {
    console.log(u.padEnd(16), String(g.procs).padStart(6), cov(g).padStart(9), gb(g.pss).padStart(10), `${g.cpuPct.toFixed(0)}%`.padStart(6));
  }

  console.log(`\n## Top 18 single processes by PSS`);
  rows.sort((x, y) => y.pss - x.pss);
  for (const r of rows.slice(0, 18)) {
    console.log(`${gb(r.pss).padStart(9)} cpu=${r.cpuPct.toFixed(0).padStart(4)}% ${r.user.padEnd(12)} pid=${String(r.pid).padStart(7)} ${r.cmd.slice(0, 76)}`);
  }

  console.log(`\n## Top 12 by CPU right now`);
  rows.sort((x, y) => y.cpuPct - x.cpuPct);
  for (const r of rows.slice(0, 12)) {
    if (r.cpuPct < 1) break;
    console.log(`${r.cpuPct.toFixed(0).padStart(5)}% pss=${gb(r.pss).padStart(9)} ${r.user.padEnd(12)} pid=${String(r.pid).padStart(7)} ${r.cmd.slice(0, 76)}`);
  }
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
