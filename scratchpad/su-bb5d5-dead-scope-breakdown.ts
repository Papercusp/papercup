/**
 * Ad-hoc diagnostic (su-bb5d5, 2026-08-03): what actually lives inside the
 * WINDOW-DEAD terminal scopes the residue census reports?
 *
 * Uses the SHIPPED census predicate rather than a hand-rolled wmctrl check — a
 * naive `wmctrl -lp` pid match reports ~110/112 scopes dead, because gnome-terminal
 * is client-server and wmctrl names the gnome-terminal-server pid for every window.
 */
import {
  censusTerminalResidue,
  resolveTerminalSliceAbs,
} from '../packages/operator-core/lib/task-manager/terminal-residue-census';
import { nodeCgroupFs as fs } from '../packages/operator-core/lib/task-manager/cgroup-read';
import { readFileSync } from 'node:fs';

// resolveTerminalSliceAbs(null) returns null — it needs the user-manager root the
// reconcile tick gets from its scan. Fall back to the literal path (verified present).
const slice =
  process.env.SLICE ??
  `/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/app.slice/app-org.gnome.Terminal.slice`;
void resolveTerminalSliceAbs;

const c = censusTerminalResidue(slice, fs);
console.log(
  `scopesTotal=${c.scopesTotal} scopesDead=${c.scopesDead} deadPids=${c.deadPids} unprobeable=${c.unprobeable}`,
);

const cmdline = (p: string): string | null => {
  try {
    return readFileSync(`/proc/${p}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
  } catch {
    return null;
  }
};
const rssKb = (p: string): number => {
  try {
    const m = readFileSync(`/proc/${p}/status`, 'utf8').match(/VmRSS:\s+(\d+)/);
    return m ? Number(m[1]) : 0;
  } catch {
    return 0;
  }
};
const ageSec = (p: string): number => {
  try {
    const st = readFileSync(`/proc/${p}/stat`, 'utf8').split(' ');
    const startTicks = Number(st[21]);
    const btime = Number(
      readFileSync('/proc/stat', 'utf8').match(/btime (\d+)/)?.[1] ?? 0,
    );
    return Math.round(Date.now() / 1000 - (btime + startTicks / 100));
  } catch {
    return 0;
  }
};

const tally = new Map<string, { n: number; rssKb: number; oldest: number }>();
let totalRss = 0;

for (const d of c.dead) {
  let procs: string[] = [];
  try {
    procs = readFileSync(`${slice}/${d.scope}/cgroup.procs`, 'utf8').split('\n').filter(Boolean);
  } catch {
    continue;
  }
  for (const p of procs) {
    const cl = cmdline(p);
    if (!cl) continue;
    const key = cl.includes('psu-launcher.mjs')
      ? 'psu-launcher.mjs'
      : (cl.split(/\s+/)[0].split('/').pop() ?? 'other');
    const r = rssKb(p);
    totalRss += r;
    const t = tally.get(key) ?? { n: 0, rssKb: 0, oldest: 0 };
    t.n += 1;
    t.rssKb += r;
    t.oldest = Math.max(t.oldest, ageSec(p));
    tally.set(key, t);
  }
}

console.log(`\n--- processes inside WINDOW-DEAD scopes (total ${(totalRss / 1024 / 1024).toFixed(2)} GB RSS) ---`);
console.log('   n     RSS_MB   oldest_days  binary');
for (const [k, v] of [...tally.entries()].sort((a, b) => b[1].rssKb - a[1].rssKb).slice(0, 15)) {
  console.log(
    `${String(v.n).padStart(4)}  ${(v.rssKb / 1024).toFixed(0).padStart(8)}  ${(v.oldest / 86400).toFixed(1).padStart(11)}  ${k}`,
  );
}
