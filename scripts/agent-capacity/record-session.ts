/**
 * Record workload-corpus sessions (plan agent-capacity-and-cost-gcp-2026-09-30, P-002).
 *
 *   npx tsx scripts/agent-capacity/record-session.ts --cli claude|codex --tasks all|<id,id> \
 *     [--parallel 3] [--out ~/.cache/agent-capacity/corpus] [--upstream http://127.0.0.1:8788] \
 *     [--claude-model sonnet] [--keep-work]
 *
 * For each task: copy the prepared (dependencies-installed) checkout of its pinned repo,
 * start a recording proxy in front of the local inference gateway, run the real CLI
 * headless against it with a fresh config dir (no user hooks/MCP — a customer-shaped
 * agent), and write <out>/<sessionId>/{meta.json, exchanges.jsonl, cli.jsonl, stderr.log,
 * diff.patch}. Prepared checkouts live at ~/.cache/agent-capacity/prepared/<repo> (see the
 * repo `setup` commands in corpus/tasks.json).
 */
import { spawn, execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, createWriteStream } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { startRecordProxy } from './record-proxy';

export type Cli = 'claude' | 'codex';
export type Profile = 'light' | 'typical' | 'heavy';
export interface CorpusTask { id: string; repo: string; profile: Profile; prompt: string }
export interface Corpus {
  version: number;
  suffix: string;
  timeoutSec: Record<Profile, number>;
  repos: Record<string, { url: string; sha: string; kind: string; setup: string[] }>;
  tasks: CorpusTask[];
}

export const CORPUS_FILE = path.join(__dirname, 'corpus', 'tasks.json');
export const OWNER_HEADER_VALUE = 'agent-capacity-corpus';
const CACHE = path.join(homedir(), '.cache', 'agent-capacity');

export function loadCorpus(file = CORPUS_FILE): Corpus {
  return JSON.parse(readFileSync(file, 'utf8')) as Corpus;
}

/** The caller's env minus every agent/session variable, so the recorded CLI is customer-shaped. */
export function cleanEnv(base: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (/^(PAPERCUSP_|CLAUDE|ANTHROPIC_|CODEX_|OPENAI_|MCP_|PSU_)/.test(k)) continue;
    env[k] = v;
  }
  return env;
}

export function claudeEnv(base: NodeJS.ProcessEnv, proxyUrl: string, configDir: string): Record<string, string> {
  return {
    ...cleanEnv(base),
    CLAUDE_CONFIG_DIR: configDir,
    ANTHROPIC_BASE_URL: proxyUrl,
    ANTHROPIC_AUTH_TOKEN: 'papercusp-gateway',
    ANTHROPIC_CUSTOM_HEADERS: `x-papercusp-owner: ${OWNER_HEADER_VALUE}`,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
  };
}

/** config.toml for a fresh CODEX_HOME whose only model provider is the recording proxy. */
export function codexConfigToml(proxyUrl: string): string {
  return [
    'model_provider = "capture"',
    'check_for_update_on_startup = false',
    '',
    '[model_providers.capture]',
    'name = "capture"',
    `base_url = "${proxyUrl}/v1"`,
    'wire_api = "responses"',
    `http_headers = { originator = "codex_cli_rs", "x-papercusp-owner" = "${OWNER_HEADER_VALUE}" }`,
    '',
  ].join('\n');
}

/** The exact prompt a task is run with — replay must send the identical text. */
export function promptFor(corpus: Corpus, task: CorpusTask): string {
  return `${task.prompt}\n\n${corpus.suffix}`;
}

export function cliArgs(cli: Cli, prompt: string, workDir: string, claudeModel: string): string[] {
  if (cli === 'claude') {
    return ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions', '--model', claudeModel];
  }
  // codex-cli 0.159 removed --full-auto; exec never prompts, and workspace-write is the sandbox it implied.
  return ['exec', '--json', '--sandbox', 'workspace-write', '--skip-git-repo-check', '-C', workDir, prompt];
}

/** Count tool calls by name from the CLI's own JSON event stream (claude stream-json / codex exec --json). */
export function summarizeToolCalls(cli: Cli, jsonl: string): Record<string, number> {
  const counts: Record<string, number> = {};
  const bump = (k: string) => (counts[k] = (counts[k] ?? 0) + 1);
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let ev: Record<string, any>;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (cli === 'claude') {
      if (ev.type !== 'assistant' || !Array.isArray(ev.message?.content)) continue;
      for (const block of ev.message.content) if (block?.type === 'tool_use') bump(String(block.name));
    } else if (ev.type === 'item.completed' && ev.item && ev.item.type !== 'agent_message' && ev.item.type !== 'reasoning') {
      bump(String(ev.item.type));
    }
  }
  return counts;
}

function cliVersion(cli: Cli): string {
  try {
    return execFileSync(cli, ['--version'], { encoding: 'utf8', timeout: 20_000 }).trim();
  } catch {
    return 'unknown';
  }
}

export interface SessionMeta {
  sessionId: string;
  corpusVersion: number;
  task: CorpusTask;
  repo: { name: string; sha: string; kind: string };
  cli: Cli;
  cliVersion: string;
  claudeModel: string | null;
  startedAt: string;
  wallMs: number;
  exitCode: number | null;
  timedOut: boolean;
  exchanges: number;
  toolCalls: Record<string, number>;
  diffBytes: number;
}

export async function recordSession(opts: {
  corpus: Corpus;
  task: CorpusTask;
  cli: Cli;
  outDir: string;
  upstream: string;
  claudeModel: string;
  keepWork: boolean;
}): Promise<SessionMeta> {
  const { corpus, task, cli } = opts;
  const repo = corpus.repos[task.repo];
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
  const sessionId = `${cli}-${task.id}-${stamp}`;
  const sessionDir = path.join(opts.outDir, sessionId);
  const workDir = path.join(CACHE, 'work', sessionId);
  const prepared = path.join(CACHE, 'prepared', task.repo);
  if (!existsSync(prepared)) throw new Error(`prepared checkout missing: ${prepared}`);
  const head = execFileSync('git', ['-C', prepared, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (head !== repo.sha) throw new Error(`prepared ${task.repo} is at ${head}, corpus pins ${repo.sha}`);
  mkdirSync(sessionDir, { recursive: true });
  cpSync(prepared, workDir, { recursive: true, verbatimSymlinks: true });

  const proxy = await startRecordProxy({ upstream: opts.upstream, outFile: path.join(sessionDir, 'exchanges.jsonl'), sessionId });
  const home = path.join(CACHE, 'cli-home', sessionId);
  mkdirSync(home, { recursive: true });
  let env: Record<string, string>;
  if (cli === 'claude') {
    env = claudeEnv(process.env, proxy.url, home);
  } else {
    writeFileSync(path.join(home, 'config.toml'), codexConfigToml(proxy.url));
    env = { ...cleanEnv(process.env), CODEX_HOME: home };
  }
  const prompt = promptFor(corpus, task);
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const cliOut = createWriteStream(path.join(sessionDir, 'cli.jsonl'));
  const cliErr = createWriteStream(path.join(sessionDir, 'stderr.log'));
  let timedOut = false;
  const exitCode = await new Promise<number | null>((resolve) => {
    const child = spawn(cli, cliArgs(cli, prompt, workDir, opts.claudeModel), { cwd: workDir, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(cliOut);
    child.stderr.pipe(cliErr);
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid!, 'SIGTERM');
      } catch {}
      setTimeout(() => {
        try {
          process.kill(-child.pid!, 'SIGKILL');
        } catch {}
      }, 10_000).unref();
    }, corpus.timeoutSec[task.profile] * 1000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  const wallMs = Date.now() - t0;
  await proxy.close();
  await new Promise<void>((r) => cliOut.end(r));
  await new Promise<void>((r) => cliErr.end(r));

  let diff = '';
  try {
    diff = execFileSync('git', ['-C', workDir, 'diff'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch {}
  writeFileSync(path.join(sessionDir, 'diff.patch'), diff);
  const meta: SessionMeta = {
    sessionId,
    corpusVersion: corpus.version,
    task,
    repo: { name: task.repo, sha: repo.sha, kind: repo.kind },
    cli,
    cliVersion: cliVersion(cli),
    claudeModel: cli === 'claude' ? opts.claudeModel : null,
    startedAt,
    wallMs,
    exitCode,
    timedOut,
    exchanges: proxy.count(),
    toolCalls: summarizeToolCalls(cli, readFileSync(path.join(sessionDir, 'cli.jsonl'), 'utf8')),
    diffBytes: Buffer.byteLength(diff),
  };
  writeFileSync(path.join(sessionDir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
  if (!opts.keepWork) rmSync(workDir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  return meta;
}

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

async function main(): Promise<void> {
  const corpus = loadCorpus();
  const cli = arg('cli') as Cli;
  if (cli !== 'claude' && cli !== 'codex') throw new Error('--cli claude|codex required');
  const sel = arg('tasks', 'all')!;
  const tasks = sel === 'all' ? corpus.tasks : corpus.tasks.filter((t) => sel.split(',').includes(t.id));
  if (!tasks.length) throw new Error(`no tasks match ${sel}`);
  const outDir = arg('out', path.join(CACHE, 'corpus'))!;
  const parallel = Math.max(1, Number(arg('parallel', '1')));
  const queue = [...tasks];
  const worker = async () => {
    for (let task = queue.shift(); task; task = queue.shift()) {
      try {
        const m = await recordSession({
          corpus,
          task,
          cli,
          outDir,
          upstream: arg('upstream', 'http://127.0.0.1:8788')!,
          claudeModel: arg('claude-model', 'sonnet')!,
          keepWork: process.argv.includes('--keep-work'),
        });
        console.log(`SESSION ${m.sessionId} exit=${m.exitCode} timedOut=${m.timedOut} wallMs=${m.wallMs} exchanges=${m.exchanges} tools=${JSON.stringify(m.toolCalls)}`);
      } catch (e) {
        console.log(`SESSION_FAILED ${cli} ${task.id}: ${(e as Error).message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: parallel }, worker));
}

if (process.argv[1] && /record-session\.ts$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
