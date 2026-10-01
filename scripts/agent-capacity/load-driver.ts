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
 *     [--corpus ~/.cache/agent-capacity/corpus] [--out ~/.cache/agent-capacity/runs/<runId>] \
 *     [--tasks-file <tasks.json the recordings were made from; default corpus/tasks.json>]
 *
 * Each agent SLOT runs sessions round-robin from the selection; with `--duration-sec` a slot
 * keeps starting its next session until the deadline, so N stays N for the whole window (the
 * capacity question is "N concurrent agents", not "N sessions"). `--sweep` instead runs every
 * selected session exactly once, N at a time (the replay-fidelity pass over the whole corpus).
 *
 * Per-agent accounting (`--isolation systemd`, the default): every session runs as its own
 * transient user service in `capdrv.slice`, wrapped so that — while still inside its cgroup —
 * it records `memory.peak` and `cpu.stat usage_usec` for the CLI and every tool it spawned.
 * (systemd-run's own "Memory peak" summary line is read after the cgroup empties and was
 * measured wrong by >100x on systemd 255, so it is not used.) Sample the whole slice with
 * `vm/sample-footprint.py` for the time series.
 *
 * Output: <out>/agents.jsonl (one line per session run), <out>/served.jsonl (every replayed
 * request and its match tier), <out>/summary.json. A run whose replay DIVERGED is flagged,
 * because its tool work no longer follows the recording: a request that found nothing at its
 * path or only a path-tier match, OR a tool-outcome mismatch (a different number of tool results
 * or of failed tool calls than the recording's own CLI log). Request matching alone cannot see
 * the second kind: a replayed tool call that fails still sends the next request `exact`.
 *
 * Each replay runs in its own checkout, so the server rewrites the recorded checkout path in the
 * served responses to the replay's (`replay-server.ts` `rewritePaths`).
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync, createWriteStream } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { assertHostAdmission } from './host-admission';
import { startReplayServer, type ReplayServer, type ReplayState } from './replay-server';
import { finished } from 'node:stream/promises';
import { claudeEnv, cleanEnv, cliArgs, codexConfigToml, corpusFileFromArgv, loadCorpus, promptFor, recordedWorkDir, summarizeToolOutcomes, type Corpus, type SessionMeta } from './record-session';
// Checkouts are copied/removed with SPAWNED native cp/rm (see session-process.ts): the replay
// server shares this event loop with every running agent's model replies.
import { parseCgroupStats, prepareWorkdir, removeTree as rm, sessionSpawn, type Isolation, type WorkdirMode } from './session-process';

const CACHE = path.join(homedir(), '.cache', 'agent-capacity');

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
  /** Time to give the session its checkout, before `startedAt`; not part of `wallMs`. */
  setupMs: number;
  wallMs: number;
  recordedWallMs: number;
  exitCode: number | null;
  timedOut: boolean;
  memPeakBytes: number | null;
  cpuUsec: number | null;
  recordedExchanges: number;
  served: ReplayState['counts'];
  /** Tool results and failed tool calls: the recording's (null without its cli.jsonl) vs this replay's. */
  toolOutcomes: { recorded: ToolOutcomes | null; replayed: ToolOutcomes };
  /** The replay's tool outcomes differ from the recording's. */
  toolDiverged: boolean;
  diverged: boolean;
}

export type ToolOutcomes = ReturnType<typeof summarizeToolOutcomes>;

/**
 * A replay is killed (and counted failed, which the ramp reads as saturation) once it has taken 3x
 * its recorded wall time, never less than 60s. The limit is relative to the recording, so it
 * means the same slowdown for every session. The corpus's per-profile timeouts are the RECORDER's
 * limits; used here, they gave each recording a different tolerance (WI-10004672, measured
 * 2026-10-01): claude-exc-light-4, recorded at 286s against the 300s light limit, timed out under
 * any slowdown at all, and it and claude-mea-typical-3 (598s against 900s) produced every P-005
 * `failed=N` verdict.
 */
export function replayTimeoutMs(recordedWallMs: number): number {
  return Math.max(60_000, 3 * recordedWallMs);
}

/**
 * How many sessions were actually running (CLI started, not yet exited) through a duration run,
 * sampled every second once every slot should have started (after the stagger) until the
 * deadline. A step that asks for N but holds fewer measures the driver, not the machine
 * (WI-10004672: P-005 asked for 64 and held about 13), so the ramp checks `fraction`.
 */
export function achievedConcurrency(
  runs: Pick<AgentRun, 'startedAt' | 'wallMs'>[],
  w: { startMs: number; agents: number; staggerMs: number; durationSec: number },
): { target: number; mean: number; max: number; fraction: number; windowSec: number } | null {
  const from = w.startMs + (w.agents - 1) * w.staggerMs;
  const to = w.startMs + w.durationSec * 1000;
  if (!(to > from)) return null;
  const spans = runs.map((r) => {
    const s = Date.parse(r.startedAt);
    return [s, s + r.wallMs] as const;
  });
  let total = 0;
  let max = 0;
  let samples = 0;
  for (let t = from; t < to; t += 1000) {
    const n = spans.filter(([s, e]) => s <= t && t < e).length;
    total += n;
    max = Math.max(max, n);
    samples++;
  }
  const mean = total / samples;
  return { target: w.agents, mean: Math.round(mean * 10) / 10, max, fraction: Math.round((mean / w.agents) * 100) / 100, windowSec: Math.round((to - from) / 1000) };
}

/** A replay ran different tool work than its recording when the outcome counts differ. */
export function toolOutcomesDiverge(recorded: ToolOutcomes | null, replayed: ToolOutcomes): boolean {
  return recorded !== null && (recorded.results !== replayed.results || recorded.errors !== replayed.errors);
}

/** The checkout path the recording's tool calls name (see `SessionMeta.workDir`). */
export function recordedWorkDirOf(meta: SessionMeta): string {
  return meta.workDir ?? recordedWorkDir(meta.sessionId);
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
  return interleaveSessions(
    metas
      .filter((m) => m.exitCode === 0 && !m.timedOut)
      .filter((m) => Object.entries(want).every(([k, vs]) => vs.includes(field(m, k)))),
  );
}

/**
 * Order sessions round-robin across their (cli, repo, profile) groups, each group sorted by id.
 * `sessionFor` walks a contiguous window of this list (slot s plays s, s+1, ...), so a sorted
 * list made a step's workload depend on N: with claude-* sorted before codex-*, no slot below
 * n16 ever reached a codex session (WI-10004579). Interleaved, any window of G consecutive
 * entries (G = number of groups) holds one session from every group.
 */
export function interleaveSessions(sessions: SessionMeta[]): SessionMeta[] {
  const groups = new Map<string, SessionMeta[]>();
  for (const m of [...sessions].sort((a, b) => a.sessionId.localeCompare(b.sessionId))) {
    const key = `${m.cli}|${m.repo.name}|${m.task.profile}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = []));
    g.push(m);
  }
  const ordered = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, g]) => g);
  const out: SessionMeta[] = [];
  for (let i = 0; out.length < sessions.length; i++) for (const g of ordered) if (i < g.length) out.push(g[i]);
  return out;
}

/** Which session slot `slot` runs on its `iteration`-th pass: round-robin, offset per slot. */
export function sessionFor(sessions: SessionMeta[], slot: number, iteration: number): SessionMeta {
  return sessions[(slot + iteration) % sessions.length];
}


export function loadMetas(corpusDir: string): SessionMeta[] {
  const out: SessionMeta[] = [];
  for (const d of readdirSync(corpusDir)) {
    const f = path.join(corpusDir, d, 'meta.json');
    if (existsSync(f)) out.push(JSON.parse(readFileSync(f, 'utf8')) as SessionMeta);
  }
  return out;
}

/** Each CLI whose installed `--version` is not one the selected sessions were recorded with. */
export function versionMismatches(
  sessions: Pick<SessionMeta, 'cli' | 'cliVersion'>[],
  installed: (cli: string) => string,
): { cli: string; have: string; want: string[] }[] {
  const out: { cli: string; have: string; want: string[] }[] = [];
  for (const cli of new Set(sessions.map((s) => s.cli))) {
    const want = [...new Set(sessions.filter((s) => s.cli === cli).map((s) => s.cliVersion))];
    const have = installed(cli);
    if (!want.includes(have)) out.push({ cli, have, want });
  }
  return out;
}

/** `<cli> --version` resolved on `PATH` (the driver's own when undefined). */
function installedVersion(cli: string, PATH?: string): string {
  try {
    const env = PATH === undefined ? process.env : { ...process.env, PATH };
    return execFileSync(cli, ['--version'], { encoding: 'utf8', timeout: 20_000, env }).trim();
  } catch {
    return 'missing';
  }
}

/** How a replayed session's PATH is chosen (`--path`). */
export type PathMode = 'inherit' | 'recorded';

/**
 * The PATH a replayed session runs under. `inherit` keeps the driver's own: right on a ramp
 * VM, whose bootstrap PATH holds the pinned tools, because the corpus was recorded on another
 * machine whose paths need not exist there. `recorded` reuses the PATH the recording resolved
 * tools on, for a replay on the recording host, where a different PATH (a systemd user
 * manager's, say) can expose tools the recording never saw and send a `which`/`npx` call down
 * another branch. `prepend` puts a pinned build first in either mode.
 */
export function replayPath(
  mode: PathMode,
  inherited: string | undefined,
  meta: Pick<SessionMeta, 'sessionId' | 'env'>,
  prepend?: string,
): string | undefined {
  let base = inherited;
  if (mode === 'recorded') {
    base = meta.env?.path ?? undefined;
    if (!base) throw new Error(`${meta.sessionId} has no recorded PATH (recorded before env capture); use --path inherit`);
  }
  if (!prepend) return base;
  return base ? `${prepend}${path.delimiter}${base}` : prepend;
}

async function runOne(o: {
  cacheDir: string;
  runId: string;
  outDir: string;
  corpus: Corpus;
  corpusDir: string;
  meta: SessionMeta;
  slot: number;
  iteration: number;
  server: ReplayServer;
  isolation: Isolation;
  keepWork: boolean;
  workdir: WorkdirMode;
  pathMode: PathMode;
  pathPrepend?: string;
}): Promise<AgentRun> {
  const { meta, slot, iteration, runId } = o;
  const instance = `${runId}-s${slot}-i${iteration}`;
  const workDir = path.join(o.cacheDir, 'replay-work', runId, `s${slot}-i${iteration}`);
  const home = path.join(o.cacheDir, 'replay-home', runId, `s${slot}-i${iteration}`);
  const prepared = path.join(o.cacheDir, 'prepared', meta.repo.name);
  if (!existsSync(prepared)) throw new Error(`prepared checkout missing: ${prepared}`);
  const setupT0 = Date.now();
  const checkout = await prepareWorkdir(o.workdir, prepared, workDir);
  const setupMs = Date.now() - setupT0;
  mkdirSync(home, { recursive: true });
  const base = o.server.baseUrl(meta.sessionId, instance);
  o.server.rewritePaths(meta.sessionId, instance, { from: recordedWorkDirOf(meta), to: workDir });
  let env: Record<string, string>;
  if (meta.cli === 'claude') {
    env = claudeEnv(process.env, base, home);
  } else {
    writeFileSync(path.join(home, 'config.toml'), codexConfigToml(base));
    env = { ...cleanEnv(process.env), CODEX_HOME: home };
  }
  const PATH = replayPath(o.pathMode, env.PATH, meta, o.pathPrepend);
  if (PATH !== undefined) env.PATH = PATH;
  const argv = [meta.cli, ...cliArgs(meta.cli, promptFor(o.corpus, meta.task), workDir, meta.claudeModel ?? 'sonnet')];
  const logBase = path.join(o.outDir, 'sessions', instance);
  mkdirSync(path.dirname(logBase), { recursive: true });
  const statsFile = `${logBase}.cgroup`;
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  let timedOut = false;
  const cliLog = createWriteStream(`${logBase}.cli.jsonl`);
  const errLog = createWriteStream(`${logBase}.stderr.log`);
  const exitCode = await new Promise<number | null>((resolve) => {
    const s = sessionSpawn(o.isolation, `capdrv-${instance}`, workDir, env, statsFile, argv, process.env);
    const child = spawn(s.cmd, s.args, { cwd: workDir, env: s.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(cliLog);
    child.stderr.pipe(errLog);
    const limitMs = replayTimeoutMs(meta.wallMs);
    const timer = setTimeout(() => {
      timedOut = true;
      if (s.killArgs) spawn('systemctl', s.killArgs, { stdio: 'ignore' });
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
  // The child's exit does not mean its log has reached disk; the outcome check reads it.
  await Promise.all([finished(cliLog), finished(errLog)]);
  const state = o.server.states().find((s) => s.instance === instance);
  const served = state?.counts ?? { exact: 0, shape: 0, path: 0, exhausted: 0 };
  const recordedLog = path.join(o.corpusDir, meta.sessionId, 'cli.jsonl');
  const toolOutcomes = {
    recorded: existsSync(recordedLog) ? summarizeToolOutcomes(meta.cli, readFileSync(recordedLog, 'utf8')) : null,
    replayed: summarizeToolOutcomes(meta.cli, readFileSync(`${logBase}.cli.jsonl`, 'utf8')),
  };
  const toolDiverged = toolOutcomesDiverge(toolOutcomes.recorded, toolOutcomes.replayed);
  const stats = existsSync(statsFile) ? parseCgroupStats(readFileSync(statsFile, 'utf8')) : { memPeakBytes: null, cpuUsec: null };
  await checkout.teardown(o.keepWork);
  if (!o.keepWork) await rm(home);
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
    setupMs,
    wallMs,
    recordedWallMs: meta.wallMs,
    exitCode,
    timedOut,
    ...stats,
    recordedExchanges: meta.exchanges,
    served,
    toolOutcomes,
    toolDiverged,
    diverged: served.exhausted > 0 || served.path > 0 || toolDiverged,
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
  /** Default `copy`; see WorkdirMode. The capacity ramps use `overlay`. */
  workdir?: WorkdirMode;
  /** Run every selected session exactly once across the slots (ignores durationSec). */
  sweep?: boolean;
  /** Default `inherit`; see replayPath. */
  pathMode?: PathMode;
  /** A directory put first on every session's PATH (a pinned CLI build). */
  pathPrepend?: string;
  onRun?: (r: AgentRun) => void;
}

export async function drive(o: DriverOptions): Promise<AgentRun[]> {
  if (!o.sessions.length) throw new Error('no sessions selected');
  mkdirSync(o.outDir, { recursive: true });
  const server = await startReplayServer({ corpusDir: o.corpusDir, speed: o.speed, logFile: path.join(o.outDir, 'served.jsonl') });
  const runs: AgentRun[] = [];
  const deadline = Date.now() + o.durationSec * 1000;
  // Sweep mode: slots share one queue and every selected session runs exactly once.
  let next = 0;
  const pick = (s: number, it: number): SessionMeta | undefined => {
    if (o.sweep) return next < o.sessions.length ? o.sessions[next++] : undefined;
    return it === 0 || Date.now() < deadline ? sessionFor(o.sessions, s, it) : undefined;
  };
  const slot = async (s: number) => {
    await new Promise((r) => setTimeout(r, s * o.staggerMs));
    for (let it = 0; ; it++) {
      const meta = pick(s, it);
      if (!meta) break;
      const r = await runOne({ cacheDir: o.cacheDir, runId: o.runId, outDir: o.outDir, corpus: o.corpus, corpusDir: o.corpusDir, meta, slot: s, iteration: it, server, isolation: o.isolation, keepWork: o.keepWork, workdir: o.workdir ?? 'copy', pathMode: o.pathMode ?? 'inherit', pathPrepend: o.pathPrepend });
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

export function summarize(runs: AgentRun[], window?: Parameters<typeof achievedConcurrency>[1]) {
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
    toolDiverged: runs.filter((r) => r.toolDiverged).length,
    wallSlowdown: ok.length ? sum(ok.map((r) => r.wallMs)) / sum(ok.map((r) => r.recordedWallMs)) : null,
    memPeakMiB: { p50: pct(peaks, 50), p95: pct(peaks, 95), max: pct(peaks, 100) },
    cpuSecPerSession: { p50: (pct(cpu, 50) ?? 0) / 1e6, p95: (pct(cpu, 95) ?? 0) / 1e6, total: sum(cpu) / 1e6 },
    served: runs.reduce((a, r) => ({ exact: a.exact + r.served.exact, shape: a.shape + r.served.shape, path: a.path + r.served.path, exhausted: a.exhausted + r.served.exhausted }), { exact: 0, shape: 0, path: 0, exhausted: 0 }),
    setupMs: { p50: pct(runs.map((r) => r.setupMs), 50), max: pct(runs.map((r) => r.setupMs), 100) },
    achievedConcurrency: window ? achievedConcurrency(runs, window) : null,
  };
}

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

async function main(): Promise<void> {
  assertHostAdmission(__dirname);
  const corpus = loadCorpus(corpusFileFromArgv(process.argv));
  const corpusDir = arg('corpus', path.join(CACHE, 'corpus'))!;
  const metas = loadMetas(corpusDir);
  const sessions = selectSessions(metas, arg('select'), arg('sessions')?.split(',').filter(Boolean));
  for (const m of sessions) if (m.corpusVersion !== corpus.version) throw new Error(`${m.sessionId} recorded with corpus v${m.corpusVersion}, tasks.json is v${corpus.version}`);
  const pathMode = arg('path', 'inherit');
  if (pathMode !== 'inherit' && pathMode !== 'recorded') throw new Error('--path inherit|recorded');
  const pathPrepend = arg('path-prepend');
  // Check versions on the PATH each session will actually run under, not the driver's own.
  const byPath = new Map<string, SessionMeta[]>();
  for (const m of sessions) {
    const p = replayPath(pathMode, process.env.PATH, m, pathPrepend) ?? '';
    byPath.set(p, [...(byPath.get(p) ?? []), m]);
  }
  const mismatch = [...byPath].flatMap(([p, group]) => versionMismatches(group, (cli) => installedVersion(cli, p || undefined)));
  if (mismatch.length) {
    // A different CLI build sends different requests, so the replay would diverge and read as a
    // fidelity failure. Refuse unless explicitly allowed (measured 2026-10-01: the systemd user
    // manager's PATH resolved an older codex than the interactive shell's).
    const msg = mismatch.map((m) => `${m.cli} installed ${m.have}; recorded with ${m.want.join(' | ')}`).join('; ');
    if (!process.argv.includes('--allow-version-mismatch')) throw new Error(`CLI version mismatch: ${msg}. Put the recorded build first on PATH, or pass --allow-version-mismatch.`);
    console.log(`WARN ${msg} — requests may not match`);
  }
  const runId = arg('run-id', new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, ''))!;
  const outDir = arg('out', path.join(CACHE, 'runs', runId))!;
  mkdirSync(outDir, { recursive: true });
  const isolation = arg('isolation', 'systemd');
  if (isolation !== 'systemd' && isolation !== 'none') throw new Error('--isolation systemd|none');
  const workdir = arg('workdir', 'copy');
  if (workdir !== 'copy' && workdir !== 'overlay') throw new Error('--workdir copy|overlay');
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
    workdir,
    sweep: process.argv.includes('--sweep'),
    pathMode,
    pathPrepend,
    onRun: (r) =>
      console.log(
        `RUN ${r.instance} ${r.sessionId} exit=${r.exitCode} timedOut=${r.timedOut} wallMs=${r.wallMs}/${r.recordedWallMs} peakMiB=${r.memPeakBytes === null ? '?' : (r.memPeakBytes / 2 ** 20).toFixed(0)} cpuS=${r.cpuUsec === null ? '?' : (r.cpuUsec / 1e6).toFixed(1)} served=${JSON.stringify(r.served)} tools=${r.toolOutcomes.replayed.results}/${r.toolOutcomes.recorded?.results ?? '?'} toolErrors=${r.toolOutcomes.replayed.errors}/${r.toolOutcomes.recorded?.errors ?? '?'}${r.diverged ? ' DIVERGED' : ''}${r.toolDiverged ? ' TOOL_DIVERGED' : ''}`,
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
  const startMs = Date.now();
  const runs = await drive(opts);
  const summary = summarize(runs, opts.sweep || !opts.durationSec ? undefined : { startMs, agents: opts.agents, staggerMs: opts.staggerMs, durationSec: opts.durationSec });
  writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(`SUMMARY ${JSON.stringify(summary)}`);
}

if (process.argv[1] && /load-driver\.ts$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
