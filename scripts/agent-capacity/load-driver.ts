/**
 * Load driver for the agent-capacity test (plan agent-capacity-and-cost-gcp-2026-09-30, P-003).
 *
 * Runs N real claude / codex CLIs at once, each in its own copy of the pinned repo, against the
 * in-process replay server (`replay-server.ts`), which plays back recorded model replies with
 * their recorded delays. Real tool commands (reads, greps, typechecks, test runs) execute for
 * real, so the CPU and memory the VM spends are the agents' own.
 *
 *   npx tsx scripts/agent-capacity/load-driver.ts --agents 8 \
 *     [--select cli=claude,repo=excalidraw,profile=light | --sessions <id,id>] \
 *     [--duration-sec 1800] [--speed 1] [--stagger-ms 2000] [--isolation systemd|none] \
 *     [--corpus ~/.cache/agent-capacity/corpus] [--out ~/.cache/agent-capacity/runs/<runId>]
 *
 * Each agent SLOT runs sessions round-robin from the selection; with `--duration-sec` a slot
 * keeps starting its next session until the deadline, so N stays N for the whole window (the
 * capacity question is "N concurrent agents", not "N sessions").
 *
 * Per-agent accounting (`--isolation systemd`, the default): every session runs as its own
 * transient user service in `capdrv.slice`, wrapped so that — while still inside its cgroup —
 * it records `memory.peak` and `cpu.stat usage_usec` for the CLI and every tool it spawned.
 * (systemd-run's own "Memory peak" summary line is read after the cgroup empties and was
 * measured wrong by >100x on systemd 255, so it is not used.) Sample the whole slice with
 * `vm/sample-footprint.py` for the time series.
 *
 * Output: <out>/agents.jsonl (one line per session run), <out>/served.jsonl (every replayed
 * request and its match tier), <out>/summary.json. A run whose replay DIVERGED (a request that
 * found nothing at its path, or only a path-tier match) is flagged, because its tool work no
 * longer follows the recording.
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync, createWriteStream } from 'node:fs';
// Copy/remove checkouts with a SPAWNED native cp/rm: the replay server shares this event loop,
// so a synchronous copy of a 1.2 GB checkout starves every running agent's model replies
// (first smoke run: zero requests served while a second slot copied), and fs.promises.cp
// walks the ~300k-file node_modules in JS at ~1.5 MB/s under load (second smoke run).
function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d: Buffer) => (err += d.toString()));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} exited ${code}: ${err.slice(0, 500)}`))));
  });
}
const cp = async (src: string, dst: string) => {
  mkdirSync(path.dirname(dst), { recursive: true });
  await run('cp', ['-a', '--reflink=auto', src, dst]);
};
const rm = (p: string) => run('rm', ['-rf', '--', p]);
import { homedir } from 'node:os';
import path from 'node:path';
import { startReplayServer, type ReplayServer, type ReplayState } from './replay-server';
import { claudeEnv, cleanEnv, cliArgs, codexConfigToml, loadCorpus, promptFor, type Corpus, type SessionMeta } from './record-session';

const CACHE = path.join(homedir(), '.cache', 'agent-capacity');
export const STATS_MARKER = 'CAPDRV_CGROUP';

export type Isolation = 'systemd' | 'none';

export interface AgentRun {
  runId: string;
  slot: number;
  iteration: number;
  sessionId: string;
  instance: string;
  cli: string;
  repo: string;
  profile: string;
  startedAt: string;
  wallMs: number;
  recordedWallMs: number;
  exitCode: number | null;
  timedOut: boolean;
  memPeakBytes: number | null;
  cpuUsec: number | null;
  recordedExchanges: number;
  served: ReplayState['counts'];
  diverged: boolean;
}

/** `cli=claude,profile=light` → predicate over session metas. Unknown keys are an error. */
export function selectSessions(metas: SessionMeta[], select: string | undefined, ids: string[] | undefined): SessionMeta[] {
  if (ids?.length) {
    const byId = new Map(metas.map((m) => [m.sessionId, m]));
    return ids.map((id) => {
      const m = byId.get(id);
      if (!m) throw new Error(`no recorded session ${id}`);
      return m;
    });
  }
  const want: Record<string, string[]> = {};
  for (const kv of (select ?? '').split(',').filter(Boolean)) {
    const [k, v] = kv.split('=');
    if (!['cli', 'repo', 'profile', 'task'].includes(k) || !v) throw new Error(`bad --select term ${kv}`);
    (want[k] ??= []).push(v);
  }
  const field = (m: SessionMeta, k: string) => (k === 'cli' ? m.cli : k === 'repo' ? m.repo.name : k === 'profile' ? m.task.profile : m.task.id);
  return metas
    .filter((m) => m.exitCode === 0 && !m.timedOut)
    .filter((m) => Object.entries(want).every(([k, vs]) => vs.includes(field(m, k))))
    .sort((a, b) => a.sessionId.localeCompare(b.sessionId));
}

/** Which session slot `slot` runs on its `iteration`-th pass: round-robin, offset per slot. */
export function sessionFor(sessions: SessionMeta[], slot: number, iteration: number): SessionMeta {
  return sessions[(slot + iteration) % sessions.length];
}

/** Parse the epilogue line the wrapper appends: `CAPDRV_CGROUP peak=<bytes> usage_usec=<n>`. */
export function parseCgroupStats(text: string): { memPeakBytes: number | null; cpuUsec: number | null } {
  const line = text.split('\n').reverse().find((l) => l.startsWith(STATS_MARKER));
  if (!line) return { memPeakBytes: null, cpuUsec: null };
  const num = (k: string) => {
    const m = new RegExp(`\\b${k}=(\\d+)`).exec(line);
    return m ? Number(m[1]) : null;
  };
  return { memPeakBytes: num('peak'), cpuUsec: num('usage_usec') };
}

/**
 * Wrap the CLI so the unit reports its own cgroup's peak memory and CPU before exiting, then
 * exits with the CLI's status. Runs inside `systemd-run`, so `/proc/self/cgroup` is the unit's.
 */
export function wrapperScript(statsFile: string): string {
  return [
    '"$@"',
    'rc=$?',
    'cg=/sys/fs/cgroup$(cut -d: -f3 /proc/self/cgroup)',
    `printf '${STATS_MARKER} peak=%s usage_usec=%s\\n' "$(cat "$cg/memory.peak" 2>/dev/null)" "$(awk '/^usage_usec/{print $2}' "$cg/cpu.stat" 2>/dev/null)" >> "${statsFile}"`,
    'exit $rc',
  ].join('\n');
}

export function systemdRunArgs(unit: string, workDir: string, env: Record<string, string>, statsFile: string, argv: string[]): string[] {
  const out = ['--user', '--wait', '--pipe', '--collect', '--quiet', `--unit=${unit}`, '--slice=capdrv.slice', `--working-directory=${workDir}`];
  // A multi-line value (an exported shell function, a pasted key) cannot pass through --setenv.
  for (const [k, v] of Object.entries(env)) if (!/[\n\r]/.test(v) && /^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) out.push(`--setenv=${k}=${v}`);
  out.push('bash', '-c', wrapperScript(statsFile), 'capdrv', ...argv);
  return out;
}

export function loadMetas(corpusDir: string): SessionMeta[] {
  const out: SessionMeta[] = [];
  for (const d of readdirSync(corpusDir)) {
    const f = path.join(corpusDir, d, 'meta.json');
    if (existsSync(f)) out.push(JSON.parse(readFileSync(f, 'utf8')) as SessionMeta);
  }
  return out;
}

function installedVersion(cli: string): string {
  try {
    return execFileSync(cli, ['--version'], { encoding: 'utf8', timeout: 20_000 }).trim();
  } catch {
    return 'missing';
  }
}

async function runOne(o: {
  cacheDir: string;
  runId: string;
  outDir: string;
  corpus: Corpus;
  meta: SessionMeta;
  slot: number;
  iteration: number;
  server: ReplayServer;
  isolation: Isolation;
  keepWork: boolean;
}): Promise<AgentRun> {
  const { meta, slot, iteration, runId } = o;
  const instance = `${runId}-s${slot}-i${iteration}`;
  const workDir = path.join(o.cacheDir, 'replay-work', runId, `s${slot}-i${iteration}`);
  const home = path.join(o.cacheDir, 'replay-home', runId, `s${slot}-i${iteration}`);
  const prepared = path.join(o.cacheDir, 'prepared', meta.repo.name);
  if (!existsSync(prepared)) throw new Error(`prepared checkout missing: ${prepared}`);
  await cp(prepared, workDir);
  mkdirSync(home, { recursive: true });
  const base = o.server.baseUrl(meta.sessionId, instance);
  let env: Record<string, string>;
  if (meta.cli === 'claude') {
    env = claudeEnv(process.env, base, home);
  } else {
    writeFileSync(path.join(home, 'config.toml'), codexConfigToml(base));
    env = { ...cleanEnv(process.env), CODEX_HOME: home };
  }
  const argv = [meta.cli, ...cliArgs(meta.cli, promptFor(o.corpus, meta.task), workDir, meta.claudeModel ?? 'sonnet')];
  const logBase = path.join(o.outDir, 'sessions', instance);
  mkdirSync(path.dirname(logBase), { recursive: true });
  const statsFile = `${logBase}.cgroup`;
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  let timedOut = false;
  const exitCode = await new Promise<number | null>((resolve) => {
    const [cmd, args] =
      o.isolation === 'systemd' ? ['systemd-run', systemdRunArgs(`capdrv-${instance}`, workDir, env, statsFile, argv)] : [argv[0], argv.slice(1)];
    const child = spawn(cmd, args, { cwd: workDir, env: o.isolation === 'systemd' ? process.env : env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(createWriteStream(`${logBase}.cli.jsonl`));
    child.stderr.pipe(createWriteStream(`${logBase}.stderr.log`));
    const limitMs = o.corpus.timeoutSec[meta.task.profile] * 1000;
    const timer = setTimeout(() => {
      timedOut = true;
      if (o.isolation === 'systemd') spawn('systemctl', ['--user', 'kill', '--signal=SIGTERM', `capdrv-${instance}.service`], { stdio: 'ignore' });
      try {
        process.kill(-child.pid!, 'SIGTERM');
      } catch {}
    }, limitMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  const wallMs = Date.now() - t0;
  const state = o.server.states().find((s) => s.instance === instance);
  const served = state?.counts ?? { exact: 0, shape: 0, path: 0, exhausted: 0 };
  const stats = existsSync(statsFile) ? parseCgroupStats(readFileSync(statsFile, 'utf8')) : { memPeakBytes: null, cpuUsec: null };
  if (!o.keepWork) {
    await rm(workDir);
    await rm(home);
  }
  return {
    runId,
    slot,
    iteration,
    sessionId: meta.sessionId,
    instance,
    cli: meta.cli,
    repo: meta.repo.name,
    profile: meta.task.profile,
    startedAt,
    wallMs,
    recordedWallMs: meta.wallMs,
    exitCode,
    timedOut,
    ...stats,
    recordedExchanges: meta.exchanges,
    served,
    diverged: served.exhausted > 0 || served.path > 0,
  };
}

export interface DriverOptions {
  /** Holds prepared/<repo> checkouts; per-session work and CLI homes are created under it. */
  cacheDir: string;
  agents: number;
  sessions: SessionMeta[];
  corpus: Corpus;
  corpusDir: string;
  outDir: string;
  runId: string;
  speed: number;
  staggerMs: number;
  durationSec: number;
  isolation: Isolation;
  keepWork: boolean;
  onRun?: (r: AgentRun) => void;
}

export async function drive(o: DriverOptions): Promise<AgentRun[]> {
  if (!o.sessions.length) throw new Error('no sessions selected');
  mkdirSync(o.outDir, { recursive: true });
  const server = await startReplayServer({ corpusDir: o.corpusDir, speed: o.speed, logFile: path.join(o.outDir, 'served.jsonl') });
  const runs: AgentRun[] = [];
  const deadline = Date.now() + o.durationSec * 1000;
  const slot = async (s: number) => {
    await new Promise((r) => setTimeout(r, s * o.staggerMs));
    for (let it = 0; it === 0 || Date.now() < deadline; it++) {
      const r = await runOne({ cacheDir: o.cacheDir, runId: o.runId, outDir: o.outDir, corpus: o.corpus, meta: sessionFor(o.sessions, s, it), slot: s, iteration: it, server, isolation: o.isolation, keepWork: o.keepWork });
      runs.push(r);
      appendFileSync(path.join(o.outDir, 'agents.jsonl'), JSON.stringify(r) + '\n');
      o.onRun?.(r);
    }
  };
  try {
    await Promise.all(Array.from({ length: o.agents }, (_, s) => slot(s)));
  } finally {
    await server.close();
  }
  return runs;
}

export function summarize(runs: AgentRun[]) {
  const ok = runs.filter((r) => r.exitCode === 0 && !r.timedOut && !r.diverged);
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const pct = (xs: number[], p: number) => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
  };
  const peaks = ok.map((r) => r.memPeakBytes).filter((x): x is number => x !== null).map((b) => Math.round(b / 2 ** 20));
  const cpu = ok.map((r) => r.cpuUsec).filter((x): x is number => x !== null);
  return {
    runs: runs.length,
    clean: ok.length,
    failed: runs.filter((r) => r.exitCode !== 0 || r.timedOut).length,
    diverged: runs.filter((r) => r.diverged).length,
    wallSlowdown: ok.length ? sum(ok.map((r) => r.wallMs)) / sum(ok.map((r) => r.recordedWallMs)) : null,
    memPeakMiB: { p50: pct(peaks, 50), p95: pct(peaks, 95), max: pct(peaks, 100) },
    cpuSecPerSession: { p50: (pct(cpu, 50) ?? 0) / 1e6, p95: (pct(cpu, 95) ?? 0) / 1e6, total: sum(cpu) / 1e6 },
    served: runs.reduce((a, r) => ({ exact: a.exact + r.served.exact, shape: a.shape + r.served.shape, path: a.path + r.served.path, exhausted: a.exhausted + r.served.exhausted }), { exact: 0, shape: 0, path: 0, exhausted: 0 }),
  };
}

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

async function main(): Promise<void> {
  const corpus = loadCorpus();
  const corpusDir = arg('corpus', path.join(CACHE, 'corpus'))!;
  const metas = loadMetas(corpusDir);
  const sessions = selectSessions(metas, arg('select'), arg('sessions')?.split(',').filter(Boolean));
  for (const m of sessions) if (m.corpusVersion !== corpus.version) throw new Error(`${m.sessionId} recorded with corpus v${m.corpusVersion}, tasks.json is v${corpus.version}`);
  for (const cli of new Set(sessions.map((s) => s.cli))) {
    const want = new Set(sessions.filter((s) => s.cli === cli).map((s) => s.cliVersion));
    const have = installedVersion(cli);
    if (!want.has(have)) console.log(`WARN ${cli} installed ${have}; recorded with ${[...want].join(' | ')} — requests may not match`);
  }
  const runId = arg('run-id', new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, ''))!;
  const outDir = arg('out', path.join(CACHE, 'runs', runId))!;
  mkdirSync(outDir, { recursive: true });
  const isolation = arg('isolation', 'systemd');
  if (isolation !== 'systemd' && isolation !== 'none') throw new Error('--isolation systemd|none');
  const opts: DriverOptions = {
    cacheDir: arg('cache', CACHE)!,
    agents: Math.max(1, Number(arg('agents', '1'))),
    sessions,
    corpus,
    corpusDir,
    outDir,
    runId,
    speed: Number(arg('speed', '1')),
    staggerMs: Number(arg('stagger-ms', '2000')),
    durationSec: Number(arg('duration-sec', '0')),
    isolation,
    keepWork: process.argv.includes('--keep-work'),
    onRun: (r) =>
      console.log(
        `RUN ${r.instance} ${r.sessionId} exit=${r.exitCode} timedOut=${r.timedOut} wallMs=${r.wallMs}/${r.recordedWallMs} peakMiB=${r.memPeakBytes === null ? '?' : (r.memPeakBytes / 2 ** 20).toFixed(0)} cpuS=${r.cpuUsec === null ? '?' : (r.cpuUsec / 1e6).toFixed(1)} served=${JSON.stringify(r.served)}${r.diverged ? ' DIVERGED' : ''}`,
      ),
  };
  // Agent units live in the user manager, outside this process's own cgroup: killing the driver
  // does not kill them, so stop them explicitly on the way out.
  const stopUnits = () => {
    if (isolation === 'systemd') spawn('systemctl', ['--user', 'stop', `capdrv-${runId}-*`], { stdio: 'ignore' }).on('close', () => process.exit(130));
    else process.exit(130);
  };
  process.once('SIGTERM', stopUnits);
  process.once('SIGINT', stopUnits);
  writeFileSync(path.join(outDir, 'run.json'), JSON.stringify({ ...opts, sessions: sessions.map((s) => s.sessionId), corpus: undefined, onRun: undefined, startedAt: new Date().toISOString() }, null, 2) + '\n', { flag: 'w' });
  const runs = await drive(opts);
  const summary = summarize(runs);
  writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(`SUMMARY ${JSON.stringify(summary)}`);
}

if (process.argv[1] && /load-driver\.ts$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
