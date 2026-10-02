/**
 * WI-10005261: runSyncWithAsyncExec must reproduce a sync exec-injected probe's result
 * exactly while never running a child process synchronously.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { currentCheckpointCandidate } from './release-checkpoint-launch';
import {
  createGitReadMemo,
  execFileResult,
  execFileResultShared,
  GIT_READ_MEMO_TTL_MS,
  gitReadMemoStats,
  gitSubcommand,
  runSyncWithAsyncExec,
  SyncExecReplayExhaustedError,
  type ExecResult,
  type ReplayExecSync,
} from './sync-exec-replay';

const HERE = dirname(fileURLToPath(import.meta.url));

/** A probe that branches on exec output, the shape of checkActiveCheckpointRun. */
function branchingProbe(exec: ReplayExecSync): string {
  const head = exec('git', ['rev-parse', 'HEAD']);
  if (head.status !== 0) return 'no-head';
  const unit = exec('systemctl', ['--user', 'is-active', 'x']);
  if (unit.stdout.trim() === 'active') return `active@${head.stdout.trim()}`;
  const log = exec('git', ['log', '-1', '--format=%ct', head.stdout.trim()]);
  return `idle@${head.stdout.trim()}:${log.stdout.trim()}`;
}

function scripted(table: Record<string, ExecResult>) {
  const calls: string[] = [];
  const asyncExec = async (cmd: string, args: string[]) => {
    const key = [cmd, ...args].join(' ');
    calls.push(key);
    await new Promise((r) => setTimeout(r, 5));
    return table[key] ?? { status: 1, stdout: '', stderr: 'unscripted' };
  };
  const syncExec: ReplayExecSync = (cmd, args) => table[[cmd, ...args].join(' ')] ?? { status: 1, stdout: '', stderr: 'unscripted' };
  return { calls, asyncExec, syncExec };
}

const ok = (stdout: string): ExecResult => ({ status: 0, stdout, stderr: '' });

describe('runSyncWithAsyncExec (WI-10005261)', () => {
  it('returns exactly what a synchronous run returns, fetching each distinct call once in real order', async () => {
    const s = scripted({
      'git rev-parse HEAD': ok('abc123\n'),
      'systemctl --user is-active x': { status: 3, stdout: 'inactive\n', stderr: '' },
      'git log -1 --format=%ct abc123': ok('1790000000\n'),
    });
    const r = await runSyncWithAsyncExec(branchingProbe, s.asyncExec);
    expect(r.value).toBe(branchingProbe(s.syncExec));
    expect(r.value).toBe('idle@abc123:1790000000');
    expect(s.calls).toEqual(['git rev-parse HEAD', 'systemctl --user is-active x', 'git log -1 --format=%ct abc123']);
    expect(r.execCalls).toBe(3);
    expect(r.passes).toBe(4);
  });

  it('never fetches a call that only a placeholder branch would issue', async () => {
    const s = scripted({ 'git rev-parse HEAD': { status: 128, stdout: '', stderr: 'not a repo' } });
    const r = await runSyncWithAsyncExec(branchingProbe, s.asyncExec);
    expect(r.value).toBe('no-head');
    expect(s.calls).toEqual(['git rev-parse HEAD']);
  });

  it('keeps the event loop turning while the probe resolves', async () => {
    const s = scripted({
      'git rev-parse HEAD': ok('abc123\n'),
      'systemctl --user is-active x': ok('active\n'),
    });
    let ticks = 0;
    const timer = setInterval(() => ticks++, 1);
    try {
      const r = await runSyncWithAsyncExec(branchingProbe, s.asyncExec);
      expect(r.value).toBe('active@abc123');
    } finally {
      clearInterval(timer);
    }
    expect(ticks).toBeGreaterThan(0);
  });

  it('retries a throw caused by a placeholder result, but surfaces a throw on a complete pass', async () => {
    const parse = (exec: ReplayExecSync) => JSON.parse(exec('cat', ['state.json']).stdout) as { n: number };
    const good = scripted({ 'cat state.json': ok('{"n":7}') });
    expect((await runSyncWithAsyncExec(parse, good.asyncExec)).value).toEqual({ n: 7 });
    const bad = scripted({ 'cat state.json': ok('not json') });
    await expect(runSyncWithAsyncExec(parse, bad.asyncExec)).rejects.toThrow(SyntaxError);
  });

  it('refuses a probe that never converges instead of looping forever', async () => {
    let n = 0;
    const runaway = (exec: ReplayExecSync) => exec('echo', [String(n++)]);
    await expect(runSyncWithAsyncExec(runaway, async () => ok(''), { maxPasses: 5 })).rejects.toBeInstanceOf(
      SyncExecReplayExhaustedError,
    );
  });
});

describe('execFileResult', () => {
  it('maps exit codes, a missing binary and success like spawnSync', async () => {
    expect(await execFileResult(process.execPath, ['-e', 'process.stdout.write("hi")'])).toEqual({ status: 0, stdout: 'hi', stderr: '' });
    expect((await execFileResult(process.execPath, ['-e', 'process.exit(3)'])).status).toBe(3);
    expect((await execFileResult('/nonexistent/wi10005261-binary', [])).status).toBeNull();
  });
});

describe('real probe equivalence (currentCheckpointCandidate on a real repo)', () => {
  const repo = mkdtempSync(join(tmpdir(), 'wi10005261-'));
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it('replay over async execFile equals the default spawnSync execution', async () => {
    const git = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { stdio: 'pipe' });
    git('init', '-q');
    git('config', 'user.email', 't@example.invalid');
    git('config', 'user.name', 't');
    writeFileSync(join(repo, 'f.txt'), 'x');
    git('add', 'f.txt');
    git('commit', '-q', '-m', 'c1');
    const sync = currentCheckpointCandidate(repo);
    const replay = await runSyncWithAsyncExec((exec) => currentCheckpointCandidate(repo, exec), (cmd, args) => execFileResult(cmd, args));
    expect(sync.current_head).toMatch(/^[0-9a-f]{40}$/);
    expect(replay.value).toEqual(sync);
  });
});

describe('createGitReadMemo (EI-24852529885337741)', () => {
  /** A controllable exec: each call returns a promise the test settles, and is counted. */
  function deferredExec() {
    const calls: Array<{ key: string; resolve: (r: ExecResult) => void }> = [];
    const exec = (cmd: string, args: string[]) =>
      new Promise<ExecResult>((resolve) => {
        calls.push({ key: [cmd, ...args].join(' '), resolve });
      });
    return { calls, exec };
  }

  it('gives concurrent identical read-only git calls ONE child, and every caller its result', async () => {
    const { calls, exec } = deferredExec();
    const memo = createGitReadMemo(exec, { now: () => 1_000 });
    const args = ['-C', '/r', 'rev-parse', 'HEAD'];
    const a = memo.exec('git', args);
    const b = memo.exec('git', args);
    const c = memo.exec('git', args);
    expect(calls).toHaveLength(1);
    calls[0].resolve(ok('abc\n'));
    expect(await Promise.all([a, b, c])).toEqual([ok('abc\n'), ok('abc\n'), ok('abc\n')]);
    expect(memo.stats()).toMatchObject({ hits: 2, misses: 1 });
  });

  it('reuses a settled result inside the window and forks again once it has passed', async () => {
    let t = 1_000;
    const { calls, exec } = deferredExec();
    const memo = createGitReadMemo(exec, { now: () => t });
    const args = ['-C', '/r', 'show', '-s', '--format=%ct', 'HEAD'];
    const first = memo.exec('git', args);
    calls[0].resolve(ok('1\n'));
    await first;
    t += GIT_READ_MEMO_TTL_MS - 1;
    expect(await memo.exec('git', args)).toEqual(ok('1\n'));
    expect(calls).toHaveLength(1);
    t += 1;
    const later = memo.exec('git', args);
    expect(calls).toHaveLength(2);
    calls[1].resolve(ok('2\n'));
    expect(await later).toEqual(ok('2\n'));
  });

  it('never shares a different argv, a writing git subcommand, or a non-git command', async () => {
    const { calls, exec } = deferredExec();
    const memo = createGitReadMemo(exec, { now: () => 1_000 });
    void memo.exec('git', ['-C', '/r', 'rev-parse', 'HEAD']);
    void memo.exec('git', ['-C', '/other', 'rev-parse', 'HEAD']);
    void memo.exec('git', ['-C', '/r', 'commit', '-m', 'x']);
    void memo.exec('git', ['-C', '/r', 'commit', '-m', 'x']);
    void memo.exec('git', ['-C', '/r', 'fetch']);
    void memo.exec('git', ['-C', '/r', 'fetch']);
    void memo.exec('systemctl', ['--user', 'show', 'u']);
    void memo.exec('systemctl', ['--user', 'show', 'u']);
    expect(calls.map((c) => c.key)).toEqual([
      'git -C /r rev-parse HEAD',
      'git -C /other rev-parse HEAD',
      'git -C /r commit -m x',
      'git -C /r commit -m x',
      'git -C /r fetch',
      'git -C /r fetch',
      'systemctl --user show u',
      'systemctl --user show u',
    ]);
  });

  it('shares a result with no exit status only while in flight, never afterwards', async () => {
    const { calls, exec } = deferredExec();
    const memo = createGitReadMemo(exec, { now: () => 1_000 });
    const args = ['-C', '/r', 'rev-parse', 'HEAD'];
    const a = memo.exec('git', args);
    const b = memo.exec('git', args);
    const killed: ExecResult = { status: null, stdout: '', stderr: 'timeout' };
    calls[0].resolve(killed);
    expect(await Promise.all([a, b])).toEqual([killed, killed]);
    void memo.exec('git', args);
    expect(calls).toHaveLength(2);
  });

  it('keeps a non-zero exit (a real answer, e.g. a missing ref) for the window', async () => {
    const { calls, exec } = deferredExec();
    const memo = createGitReadMemo(exec, { now: () => 1_000 });
    const args = ['-C', '/r', 'rev-parse', '--verify', 'ready'];
    const a = memo.exec('git', args);
    calls[0].resolve({ status: 128, stdout: '', stderr: 'fatal' });
    await a;
    expect((await memo.exec('git', args)).status).toBe(128);
    expect(calls).toHaveLength(1);
  });

  it('drops expired entries once the map grows, so time-keyed argv cannot accumulate', async () => {
    let t = 1_000;
    const { calls, exec } = deferredExec();
    const memo = createGitReadMemo(exec, { now: () => t });
    for (let i = 0; i < 80; i++) {
      const p = memo.exec('git', ['-C', '/r', 'rev-list', '-1', `--before=@${i}`, 'HEAD']);
      calls[calls.length - 1].resolve(ok(`${i}\n`));
      await p;
      t += GIT_READ_MEMO_TTL_MS;
    }
    expect(memo.stats().entries).toBeLessThanOrEqual(65);
  });

  it('parses the subcommand past -C / -c / --no-pager', () => {
    expect(gitSubcommand(['-C', '/r', 'rev-parse', 'HEAD'])).toBe('rev-parse');
    expect(gitSubcommand(['-c', 'core.x=1', '--no-pager', 'log', '-1'])).toBe('log');
    expect(gitSubcommand(['--version'])).toBeNull();
    expect(gitSubcommand([])).toBeNull();
  });
});

describe('execFileResultShared on a real repo (EI-24852529885337741)', () => {
  const repo = mkdtempSync(join(tmpdir(), 'ei24852529885337741-'));
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it('answers like execFileResult, and a concurrent duplicate is served by the same child', async () => {
    const git = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { stdio: 'pipe' });
    git('init', '-q');
    git('config', 'user.email', 't@example.invalid');
    git('config', 'user.name', 't');
    writeFileSync(join(repo, 'f.txt'), 'x');
    git('add', 'f.txt');
    git('commit', '-q', '-m', 'c1');
    const args = ['-C', repo, 'rev-parse', 'HEAD'];
    const before = gitReadMemoStats();
    const [a, b] = await Promise.all([execFileResultShared('git', args), execFileResultShared('git', args)]);
    const after = gitReadMemoStats();
    expect(a).toEqual(await execFileResult('git', args));
    expect(b).toEqual(a);
    expect(after.misses - before.misses).toBe(1);
    expect(after.hits - before.hits).toBe(1);
  });
});

describe('checkpoint probes route through the shared git-read memo (EI-24852529885337741 guard)', () => {
  it.each(['release-checkpoint-launch.ts', 'git-pipeline-position.ts'])('%s uses execFileResultShared, not a bare execFileResult', (file) => {
    const code = readFileSync(join(HERE, file), 'utf8')
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');
    expect(code).toMatch(/\bexecFileResultShared\b/);
    expect(code.match(/\bexecFileResult\b/g) ?? []).toEqual([]);
  });
});

describe('git-pipeline-position no longer spawns synchronously (WI-10005261 guard)', () => {
  it('has no synchronous child-process call outside comments', () => {
    const src = readFileSync(join(HERE, 'git-pipeline-position.ts'), 'utf8');
    const code = src
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');
    expect(code).toMatch(/runSyncWithAsyncExec/);
    expect(code.match(/\b(?:spawnSync|execFileSync|execSync)\b/g) ?? []).toEqual([]);
  });
});
