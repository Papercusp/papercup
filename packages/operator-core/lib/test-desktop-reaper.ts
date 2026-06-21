/**
 * Runaway / leaked TEST-desktop + zombie detector
 * (infra-perf-reliability-audit-round4-2026-06-19 P-006, carries round-3 P-012/F12).
 *
 * E2E / dev test runs spawn throwaway webviews — Playwright headless Chromium and
 * (less commonly) `tauri dev` WebKitGTK shells. When a test run is SIGKILLed or
 * wedges, those can leak and peg a CPU core for hours. That is a dominant host-CPU
 * drain feeding the per-core saturation this round targets (root cause: the
 * operator's single Node event loop starves under host contention).
 *
 * This is the missing GUARD: a periodic READ-ONLY scan that SURFACES leaked test
 * desktops (and a zombie/defunct-child pile) as a `notifications:recent` toast, so
 * a human/operator can reap them — at minutes, not hours.
 *
 * ── SAFETY: fail-safe identification ───────────────────────────────────────────
 * A browser/webview process is flagged ONLY when its own cmdline carries a
 * POSITIVE, unambiguous test-automation marker (a Playwright browser cache path, a
 * `--headless` switch, or a remote-debugging pipe/port — none of which a real user
 * desktop ever has). Anything that merely *looks* like a desktop without such a
 * marker classifies as a LIVE desktop and is NEVER flagged. The asymmetry is
 * deliberate: missing a leak is cheap; pointing at the user's real desktop is not.
 * `tauri dev` repo webviews are intentionally OUT of scope — distinguishing them
 * from a user who simply runs `tauri dev` needs parent/cwd context, not the
 * webview's own cmdline, so they fail-safe to LIVE.
 *
 * ── DETECTION-ONLY by design ───────────────────────────────────────────────────
 * This ships the ALARM, not an auto-kill. The existing `processes:kill` path is
 * deliberately scoped to agent kinds (run.sh | omp | claude) and STRUCTURALLY
 * cannot signal a chromium/webview (`listProcesses` filters it out as `other`).
 * Auto-reaping a non-agent host process is therefore a NEW privileged surface that
 * needs its own audited kill path + owner sign-off — not an agent default. That is
 * the same posture su-61e7e took for P-017 (ship the alarm; defer the destructive
 * action to owner policy). Surfaced as the gated follow-up.
 *
 * Read-only + never-throws (mirrors the other periodic monitors), so it can never
 * affect the system it watches.
 */
import { generated, getOrgPg } from '@papercusp/db-org';
import { desc, inArray } from 'drizzle-orm';
import { notifySyncInvalidate } from './sync-sse';

const TOAST_RING_BUFFER = 2000;
/** Linux USER_HZ — clock ticks/sec for /proc utime+stime. 100 on every mainstream
 *  build (CONFIG_HZ_100 default); a wrong value only scales cpuPercent, never the
 *  fail-safe identification, so a hardcode is safe here. */
const USER_HZ = 100;
const CPU_SAMPLE_MS = 250;

function envNum(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

// ── Pure classification (the safety-critical core) ─────────────────────────────

export type DesktopClass = 'test-desktop' | 'live-desktop' | 'not-desktop';

/** Browser/webview families a desktop could be. */
const BROWSER_RE = /chrome|chromium|webkitwebprocess|webkit2webprocess|wry|tauri|msedge/;
/** POSITIVE, unambiguous test-automation markers. A real user desktop never runs
 *  headless or exposes a remote-debugging endpoint, and never lives under a
 *  Playwright browser cache / temp profile. */
const TEST_MARKERS: readonly string[] = [
  'ms-playwright', // playwright's browser download cache path
  'playwright-core',
  '/playwright/', // a playwright-managed dir
  '--headless', // headless automation (covers --headless and --headless=new)
  '--remote-debugging-pipe',
  '--remote-debugging-port',
  '--user-data-dir=/tmp', // throwaway temp profile (CI / playwright default)
];

/**
 * Pure cmdline classifier. FAIL-SAFE: returns 'live-desktop' for any browser that
 * lacks a positive test marker, so the reaper can never target the user's real
 * desktop; 'not-desktop' for non-browser processes.
 */
export function classifyDesktop(cmdline: string): DesktopClass {
  const c = (cmdline || '').toLowerCase();
  if (!BROWSER_RE.test(c)) return 'not-desktop';
  if (TEST_MARKERS.some((m) => c.includes(m))) return 'test-desktop';
  return 'live-desktop';
}

// ── Pure candidate detection ───────────────────────────────────────────────────

export interface ProcSample {
  pid: number;
  /** Full (truncated) cmdline; empty for a zombie. */
  cmdline: string;
  /** /proc stat state char: R, S, D, Z (zombie), T, … */
  state: string;
  /** CPU% sampled over the window (0 for zombies / unsampled). */
  cpuPercent: number;
  /** Approx seconds since the process appeared (proc-dir mtime, as dev:processes). */
  ageSeconds: number;
}

export interface ReaperPolicy {
  /** A test desktop must be at/above this CPU% to count as runaway. */
  cpuPercentThreshold: number;
  /** …and have been alive at least this long (ignore brief spikes / startup). */
  minAgeSeconds: number;
  /** Only alarm on zombies once the pile reaches this size (a few transient
   *  defunct children are normal; a pile means a parent is not reaping). */
  zombieAlarmThreshold: number;
}

export const DEFAULT_POLICY: ReaperPolicy = {
  cpuPercentThreshold: 50,
  minAgeSeconds: 300,
  zombieAlarmThreshold: 25,
};

/** Read the policy from env knobs (tunable without a deploy). */
export function policyFromEnv(): ReaperPolicy {
  return {
    cpuPercentThreshold: envNum('PAPERCUSP_TEST_DESKTOP_REAPER_CPU_PCT', DEFAULT_POLICY.cpuPercentThreshold),
    minAgeSeconds: envNum('PAPERCUSP_TEST_DESKTOP_REAPER_MIN_AGE_SEC', DEFAULT_POLICY.minAgeSeconds),
    zombieAlarmThreshold: envNum('PAPERCUSP_TEST_DESKTOP_REAPER_ZOMBIE_COUNT', DEFAULT_POLICY.zombieAlarmThreshold),
  };
}

export type ReapReason = 'runaway-test-desktop' | 'zombie';

export interface ReapCandidate {
  pid: number;
  reason: ReapReason;
  cpuPercent: number;
  ageSeconds: number;
  cmdline: string;
}

/**
 * Pure candidate detection — unit-testable without /proc. A process is a
 * candidate iff it is a defunct (zombie) process, OR a positively-identified test
 * desktop pegging CPU past the threshold for past the min age. Live desktops are
 * never returned (see classifyDesktop).
 */
export function findReapCandidates(samples: ProcSample[], policy: ReaperPolicy = DEFAULT_POLICY): ReapCandidate[] {
  const out: ReapCandidate[] = [];
  for (const s of samples) {
    if (s.state === 'Z') {
      out.push({ pid: s.pid, reason: 'zombie', cpuPercent: 0, ageSeconds: s.ageSeconds, cmdline: s.cmdline.slice(0, 160) });
      continue;
    }
    if (classifyDesktop(s.cmdline) !== 'test-desktop') continue;
    if (s.cpuPercent >= policy.cpuPercentThreshold && s.ageSeconds >= policy.minAgeSeconds) {
      out.push({
        pid: s.pid,
        reason: 'runaway-test-desktop',
        cpuPercent: s.cpuPercent,
        ageSeconds: s.ageSeconds,
        cmdline: s.cmdline.slice(0, 160),
      });
    }
  }
  return out;
}

/** Whether a candidate set warrants an alarm: any runaway desktop, or a zombie
 *  pile at/over the threshold. Pure. */
export function shouldAlarm(candidates: ReapCandidate[], policy: ReaperPolicy = DEFAULT_POLICY): boolean {
  const runaway = candidates.filter((c) => c.reason === 'runaway-test-desktop').length;
  const zombies = candidates.filter((c) => c.reason === 'zombie').length;
  return runaway > 0 || zombies >= policy.zombieAlarmThreshold;
}

/** Build the alarm toast body. Pure — unit-testable. */
export function formatReaperToast(candidates: ReapCandidate[]): { level: string; message: string; description: string } {
  const runaway = candidates.filter((c) => c.reason === 'runaway-test-desktop');
  const zombies = candidates.filter((c) => c.reason === 'zombie');
  const parts: string[] = [];
  if (runaway.length > 0) {
    const lines = runaway
      .map((c) => `• pid ${c.pid}: ${c.cpuPercent.toFixed(0)}% CPU, up ${Math.round(c.ageSeconds / 60)}m — ${c.cmdline}`)
      .join('\n');
    parts.push(`Runaway leaked TEST desktop(s) pegging CPU (Playwright/headless — NOT the live desktop):\n${lines}`);
  }
  if (zombies.length > 0) {
    parts.push(`${zombies.length} zombie/defunct process(es) — a parent is not reaping its children.`);
  }
  const n = runaway.length + (zombies.length > 0 ? 1 : 0);
  return {
    level: 'warning',
    message: `Test-desktop reaper — ${runaway.length} runaway desktop(s)${zombies.length ? ` + ${zombies.length} zombie(s)` : ''}`,
    description:
      `${parts.join('\n\n')}\n\n` +
      `These leak from killed/wedged E2E runs and drain host CPU (round-4 P-006). ` +
      `Reap them from the host (e.g. \`kill <pid>\`); auto-reap is intentionally NOT armed — ` +
      `killing a non-agent host process needs an owner-approved kill path. ` +
      `Tune via PAPERCUSP_TEST_DESKTOP_REAPER_CPU_PCT / _MIN_AGE_SEC / _ZOMBIE_COUNT; disable with PAPERCUSP_TEST_DESKTOP_REAPER=0.` +
      (n === 0 ? '' : ''),
  };
}

// ── Impure sampling + emit (injectable; never throws) ──────────────────────────

export interface ReaperDeps {
  /** Injectable for tests — defaults to a /proc CPU sample. */
  sample?: () => Promise<ProcSample[]>;
  /** Injectable for tests — defaults to a toast_log row + sync invalidate. */
  emitToast?: (t: { level: string; message: string; description: string }) => Promise<void>;
}

function parseStat(raw: string): { state: string; ticks: number } | null {
  // /proc/<pid>/stat: `pid (comm) state ppid …`. comm may contain spaces/parens,
  // so split AFTER the last ')'. Post-')' tokens: [0]=state … [11]=utime [12]=stime.
  const close = raw.lastIndexOf(')');
  if (close < 0) return null;
  const rest = raw.slice(close + 1).trim().split(/\s+/);
  if (rest.length < 13) return null;
  const state = rest[0];
  const utime = Number(rest[11]);
  const stime = Number(rest[12]);
  if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null;
  return { state, ticks: utime + stime };
}

async function defaultSample(): Promise<ProcSample[]> {
  const fs = await import('node:fs');
  let pids: string[];
  try {
    pids = fs.readdirSync('/proc');
  } catch {
    return [];
  }

  // Pass 1 (cheap): one stat + cmdline read per pid. Keep only zombies and
  // positively browser-looking processes — only those need a CPU sample.
  interface Pre {
    pid: number;
    cmdline: string;
    state: string;
    ticks0: number;
    ageSeconds: number;
  }
  const now = Date.now();
  const pre: Pre[] = [];
  for (const pid of pids) {
    if (!/^\d+$/.test(pid)) continue;
    let stat: { state: string; ticks: number } | null = null;
    try {
      stat = parseStat(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'));
    } catch {
      continue;
    }
    if (!stat) continue;
    let cmdline = '';
    try {
      cmdline = fs.readFileSync(`/proc/${pid}/cmdline`).toString('utf8').replace(/\0/g, ' ').trim();
    } catch {
      /* zombies have an empty cmdline; keep going on state */
    }
    const isZombie = stat.state === 'Z';
    const isBrowser = classifyDesktop(cmdline) !== 'not-desktop';
    if (!isZombie && !isBrowser) continue;
    let ageSeconds = 0;
    try {
      const m = fs.statSync(`/proc/${pid}`).mtimeMs;
      if (m > 0) ageSeconds = Math.floor((now - m) / 1000);
    } catch {
      /* no stat */
    }
    pre.push({ pid: Number(pid), cmdline: cmdline.slice(0, 240), state: stat.state, ticks0: stat.ticks, ageSeconds });
  }

  // Pass 2: CPU sample only the non-zombie candidates.
  const needsCpu = pre.filter((p) => p.state !== 'Z');
  if (needsCpu.length > 0) {
    await new Promise((r) => setTimeout(r, CPU_SAMPLE_MS));
  }
  const out: ProcSample[] = [];
  for (const p of pre) {
    let cpuPercent = 0;
    if (p.state !== 'Z') {
      try {
        const s = parseStat(fs.readFileSync(`/proc/${p.pid}/stat`, 'utf8'));
        if (s) {
          const dTicks = s.ticks - p.ticks0;
          cpuPercent = (dTicks / USER_HZ / (CPU_SAMPLE_MS / 1000)) * 100;
          if (!Number.isFinite(cpuPercent) || cpuPercent < 0) cpuPercent = 0;
        }
      } catch {
        /* process exited between samples — treat as 0, it's gone */
      }
    }
    out.push({ pid: p.pid, cmdline: p.cmdline, state: p.state, cpuPercent, ageSeconds: p.ageSeconds });
  }
  return out;
}

async function defaultEmitToast(t: { level: string; message: string; description: string }): Promise<void> {
  const tl = generated.toastLogInHarnessShared;
  const { db } = getOrgPg();
  await db.insert(tl).values({
    level: t.level,
    message: t.message,
    description: t.description,
    harnessSlug: null,
    createdAt: Date.now(),
    actionLabel: null,
    actionHref: null,
  });
  // Bound the ring buffer (mirrors storage-growth-alarm / agent-governor-observer).
  void (async () => {
    const stale = await db.select({ id: tl.id }).from(tl).orderBy(desc(tl.createdAt)).offset(TOAST_RING_BUFFER);
    if (stale.length > 0) await db.delete(tl).where(inArray(tl.id, stale.map((r) => r.id)));
  })().catch(() => {});
  void notifySyncInvalidate('toastLog.recent', undefined).catch(() => {});
}

/**
 * One read-only pass: sample processes, detect leaked test desktops + a zombie
 * pile, toast on an alarm. Never throws — observability is best-effort, mirroring
 * the other periodic monitors.
 */
export async function runTestDesktopReaperOnce(
  deps: ReaperDeps = {},
  policy: ReaperPolicy = policyFromEnv(),
): Promise<{ sampled: number; candidates: ReapCandidate[]; alarmed: boolean }> {
  const sample = deps.sample ?? defaultSample;
  const emitToast = deps.emitToast ?? defaultEmitToast;

  let samples: ProcSample[] = [];
  try {
    samples = await sample();
  } catch (err) {
    console.warn(`[test-desktop-reaper] sample skipped (non-fatal): ${(err as Error)?.message ?? String(err)}`);
    return { sampled: 0, candidates: [], alarmed: false };
  }

  const candidates = findReapCandidates(samples, policy);
  const alarmed = shouldAlarm(candidates, policy);
  if (alarmed) {
    try {
      await emitToast(formatReaperToast(candidates));
    } catch (err) {
      console.warn(`[test-desktop-reaper] toast emit failed (non-fatal): ${(err as Error)?.message ?? String(err)}`);
    }
  }
  return { sampled: samples.length, candidates, alarmed };
}
