/**
 * Green-checkpoint orchestration — the advance-only-when-green + FF-only rules
 * are what keep `ready` a trustworthy deployable pin. Real temp repo for the ref
 * logic; stub deps for the (heavy) suite run.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runGreenCheckpoint,
  extractFailingTests,
  buildGreenCheckpointEnv,
  sanitizeForkNodeOptions,
  GREEN_CHECKPOINT_FORK_HEAP_MB,
  checkpointFailureSignature,
  summarizeSuiteOutput,
  parseFailingFilesByWorkspace,
  decideFlakeAbsorption,
  attemptFlakeAbsorption,
  ISOLATION_MAX_FILES,
  acquireCheckpointRunLock,
  isWorkerPoolCrash,
  parseCrashedWorkspaces,
  attemptWorkerCrashAbsorption,
  WORKER_CRASH_MAX_WORKSPACES,
  GREEN_CHECKPOINT_MAX_FORKS,
  type CheckpointDeps,
  type FailingFile,
  type IsolationResult,
  type WorkspaceRerunResult,
} from './green-checkpoint';
import { git, revParse, advanceReady } from './git-ops';
import { releaseConfig } from './release-config';

let repo: string;
async function commit(file: string, content: string, msg: string): Promise<string> {
  const full = join(repo, file);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '--no-verify', '-q', '-m', msg]);
  return revParse(repo, 'HEAD');
}

function stubDeps(
  green: boolean,
  failingTests?: string[],
  flakeSuspects?: string[],
): { deps: CheckpointDeps; calls: string[] } {
  const calls: string[] = [];
  const deps: CheckpointDeps = {
    setupTree: async (ref) => {
      calls.push(`setup:${ref.slice(0, 7)}`);
    },
    runGreen: async () => {
      calls.push('runGreen');
      return { green, summary: green ? 'all pass' : '3 failed', failingTests, flakeSuspects };
    },
    advance: (candidate) => {
      calls.push('advance');
      return advanceReady(repo, candidate, 'ready');
    },
    push: async () => {
      calls.push('push');
    },
    broadcast: async () => {
      calls.push('broadcast');
    },
    escalate: async () => {
      calls.push('escalate');
    },
    clearEscalation: async () => {
      calls.push('clearEscalation');
    },
    log: () => {},
  };
  return { deps, calls };
}

// EI-1762: pin the checkpoint log dir INSIDE the per-test temp repo (auto-cleaned by
// afterEach) so the suite never writes fixture logs into the REAL ~/.papercusp/checkpoint-logs/
// — those fixtures ('FAIL lib/foo.test.ts', 'SPA BUILD FAILED') masquerade as real
// checkpoint failures and mislead anyone diagnosing a deploy freeze.
const cfg = () => releaseConfig({ integrationRoot: repo, releaseRoot: repo, checkpointRoot: repo, releaseRef: 'ready', integrationBranch: 'main', checkpointLogDir: join(repo, '.checkpoint-logs') });

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), 'green-'));
  await git(repo, ['init', '-q', '-b', 'main']);
  await git(repo, ['config', 'user.email', 't@e.com']);
  await git(repo, ['config', 'user.name', 'T']);
  await git(repo, ['config', 'commit.gpgsign', 'false']);
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('acquireCheckpointRunLock', () => {
  it('blocks a second live checkpoint process from mutating the same checkpoint tree', () => {
    const lockDir = join(repo, '.checkpoint-logs', '.green-checkpoint-run.lock');
    const first = acquireCheckpointRunLock(lockDir, {
      pid: 123,
      isPidAlive: (pid) => pid === 123,
    });
    const second = acquireCheckpointRunLock(lockDir, {
      pid: 456,
      isPidAlive: (pid) => pid === 123,
    });
    expect(first.acquired).toBe(true);
    expect(second).toMatchObject({ acquired: false, owner: { pid: 123 } });
    first.release();
    const third = acquireCheckpointRunLock(lockDir, {
      pid: 456,
      isPidAlive: () => false,
    });
    expect(third.acquired).toBe(true);
    third.release();
  });

  it('clears a stale checkpoint lock whose owner pid is no longer alive', () => {
    const lockDir = join(repo, '.checkpoint-logs', '.green-checkpoint-run.lock');
    const stale = acquireCheckpointRunLock(lockDir, {
      pid: 123,
      isPidAlive: () => true,
    });
    expect(stale.acquired).toBe(true);
    const next = acquireCheckpointRunLock(lockDir, {
      pid: 456,
      isPidAlive: () => false,
    });
    expect(next.acquired).toBe(true);
    stale.release();
    next.release();
  });
});

describe('runGreenCheckpoint', () => {
  it('advances ready when the candidate is green', async () => {
    const c1 = await commit('a', '1', 'c1');
    await git(repo, ['branch', 'ready', c1]);
    const c2 = await commit('a', '2', 'c2');
    const { deps, calls } = stubDeps(true);
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(r).toMatchObject({ advanced: true, candidate: c2, green: true, reason: 'advanced' });
    expect(await revParse(repo, 'ready')).toBe(c2);
    // P-002: a green advance clears any open release-not-green escalation.
    expect(calls).toEqual(['setup:' + c2.slice(0, 7), 'runGreen', 'advance', 'broadcast', 'clearEscalation']);
  });

  it('holds ready when the candidate is NOT green', async () => {
    const c1 = await commit('a', '1', 'c1');
    await git(repo, ['branch', 'ready', c1]);
    const c2 = await commit('a', '2', 'c2');
    const { deps, calls } = stubDeps(false);
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(r).toMatchObject({ advanced: false, green: false, reason: 'not-green' });
    expect(await revParse(repo, 'ready')).toBe(c1); // unchanged
    expect(calls).not.toContain('advance');
    // P-002: a held gate opens a durable human-facing escalation.
    expect(calls).toContain('escalate');
  });

  it('docs-audit #2: re-broadcasts a rising-urgency alert when the gate has been held >2h', async () => {
    const c1 = await commit('a', '1', 'c1');
    await git(repo, ['branch', 'ready', c1]);
    await commit('a', '2', 'c2');
    const { deps } = stubDeps(false);
    const messages: string[] = [];
    deps.broadcast = async (s: string) => { messages.push(s); };
    deps.heldGateMs = async () => 4 * 60 * 60 * 1000; // held 4h (the 2026-06-23 incident)
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(r.reason).toBe('not-green');
    // The standard red broadcast PLUS a louder URGENT alert naming the held duration.
    expect(messages.some((m) => m.includes('URGENT') && m.includes('held 4h'))).toBe(true);
  });

  it('docs-audit #2: no louder alert within the first 2h (fresh hold ⇒ heldGateMs null/small)', async () => {
    const c1 = await commit('a', '1', 'c1');
    await git(repo, ['branch', 'ready', c1]);
    await commit('a', '2', 'c2');
    const { deps } = stubDeps(false);
    const messages: string[] = [];
    deps.broadcast = async (s: string) => { messages.push(s); };
    deps.heldGateMs = async () => null; // first red — escalation just opened, no age yet
    await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(messages.some((m) => /HELD|URGENT|CRITICAL/.test(m))).toBe(false);
  });

  it('is a no-op when ready already at integration HEAD', async () => {
    const c1 = await commit('a', '1', 'c1');
    await git(repo, ['branch', 'ready', c1]);
    const { deps, calls } = stubDeps(true);
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(r.reason).toBe('up-to-date');
    expect(calls).toEqual([]); // didn't even build the tree
  });

  it('refuses a non-fast-forward candidate', async () => {
    const c1 = await commit('a', '1', 'c1');
    const cFeat = await commit('a', 'feat', 'feat');
    await git(repo, ['branch', 'ready', cFeat]); // ready ahead on a feature line
    await git(repo, ['reset', '--hard', c1]);
    const cDiv = await commit('b', 'div', 'div'); // main diverged
    const { deps } = stubDeps(true);
    const r = await runGreenCheckpoint(cfg(), deps, { candidate: cDiv, noPush: true });
    expect(r.reason).toBe('not-fast-forward');
    expect(await revParse(repo, 'ready')).toBe(cFeat); // unchanged
  });

  it('P-012: threads the failure signature (failingTests) into the not-green result', async () => {
    const c1 = await commit('a', '1', 'c1');
    await git(repo, ['branch', 'ready', c1]);
    await commit('a', '2', 'c2');
    const { deps } = stubDeps(false, ['@papercusp/operator-core', 'lib/fleet/operator-spawn.test.ts']);
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(r.reason).toBe('not-green');
    // the signature flows out so the release-fixer can dedup by FAILURE, not candidate sha
    expect(r.failingTests).toEqual(['@papercusp/operator-core', 'lib/fleet/operator-spawn.test.ts']);
  });

  // load-flake-isolation-2026-06-23: when runGreen reports green=true with flakeSuspects
  // (the suite went red under load but every file passed in isolation), the gate ADVANCES
  // and surfaces the absorbed files in the green broadcast — the whole fleet's gate isn't
  // held by box-weather, but the flake is on record (drives the P-009 quarantine nudge).
  it('load-flake: a flake-absorbed green advances and surfaces flakeSuspects', async () => {
    const c1 = await commit('a', '1', 'c1');
    await git(repo, ['branch', 'ready', c1]);
    const c2 = await commit('a', '2', 'c2');
    const suspects = ['@papercusp/operator-core::lib/llm-testing/__tests__/runner-aggregate.test.ts'];
    const { deps, calls } = stubDeps(true, undefined, suspects);
    const bodies: string[] = [];
    deps.broadcast = async (_s: string, body?: string) => {
      calls.push('broadcast');
      if (body) bodies.push(body);
    };
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(r).toMatchObject({ advanced: true, green: true, reason: 'advanced' });
    expect(r.flakeSuspects).toEqual(suspects);
    expect(await revParse(repo, 'ready')).toBe(c2); // advanced despite the initial (absorbed) red
    expect(calls).toContain('advance');
    // the green broadcast names the absorbed flake so the advance is auditable
    expect(bodies.some((b) => b.includes('Load-flake absorbed') && b.includes('runner-aggregate.test.ts'))).toBe(true);
  });

  // F2 (round-4 P-031): the perf-regression gate runs post-runGreen / pre-advance.
  it('F2: a perf BLOCK holds the green pin even when the candidate is green', async () => {
    const c1 = await commit('a', '1', 'c1');
    await git(repo, ['branch', 'ready', c1]);
    await commit('a', '2', 'c2');
    const { deps, calls } = stubDeps(true);
    deps.perfGate = async (candidate) => {
      calls.push('perfGate');
      return { action: 'block', summary: `perf BLOCK ${candidate.slice(0, 7)}` };
    };
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(r).toMatchObject({ advanced: false, green: true, reason: 'perf-held' });
    expect(await revParse(repo, 'ready')).toBe(c1); // pin NOT advanced
    expect(calls).toContain('perfGate');
    expect(calls).not.toContain('advance'); // blocked before advance
    expect(calls).toContain('escalate'); // a perf block opens a durable escalation
  });

  it('F2: a perf WARN surfaces (broadcast) but still advances — default-warn', async () => {
    const c1 = await commit('a', '1', 'c1');
    await git(repo, ['branch', 'ready', c1]);
    const c2 = await commit('a', '2', 'c2');
    const { deps, calls } = stubDeps(true);
    deps.perfGate = async () => ({ action: 'warn', summary: 'perf WARN — hot but advancing' });
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(r).toMatchObject({ advanced: true, green: true, reason: 'advanced' });
    expect(await revParse(repo, 'ready')).toBe(c2); // advanced despite the warn
    expect(calls).toContain('advance');
  });

  it('F2: a perf PASS (and the no-gate default) advances normally — back-compat', async () => {
    const c1 = await commit('a', '1', 'c1');
    await git(repo, ['branch', 'ready', c1]);
    const c2 = await commit('a', '2', 'c2');
    const { deps } = stubDeps(true);
    deps.perfGate = async () => ({ action: 'pass', summary: 'perf ok' });
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(r).toMatchObject({ advanced: true, reason: 'advanced' });
    expect(await revParse(repo, 'ready')).toBe(c2);
  });
});

describe('extractFailingTests (P-012 failure signature)', () => {
  it('pulls vitest FAIL files and affected-runner workspace markers, sorted + unique', () => {
    const out = [
      'some passing noise',
      ' FAIL  lib/fleet/operator-spawn.test.ts > mints NO session id',
      '>>> @papercusp/operator-core FAILED — retrying once (AFFECTED_RETRY_FAILED)',
      ' FAIL  lib/fleet/operator-spawn.test.ts > another case', // dup file
      '1 non-quarantined task(s) failed.',
    ].join('\n');
    expect(extractFailingTests(out)).toEqual([
      '@papercusp/operator-core',
      'lib/fleet/operator-spawn.test.ts',
    ]);
  });

  it('returns [] when nothing failed', () => {
    expect(extractFailingTests('All affected tests passed.\nTests 1200 passed')).toEqual([]);
  });
});

// HE-02 gap #10 (hive-run-evaluation-2026-06-13, D-017): the realCheckpointDeps
// "real path" — the inline env-strip + output processing in runGreen — twice held
// `main` red for hours via leaked host env (2026-06-06/07). The orchestration is
// already tested above with stub deps; these cover the pure pieces of the heavy
// path that don't need a real suite-run.
describe('buildGreenCheckpointEnv (the gate measures COMMITTED defaults)', () => {
  it('strips ALL PAPERCUSP_* and HOST_ENV_STRIP keys, preserves unrelated env', () => {
    const src = {
      PATH: '/usr/bin',
      HOME: '/home/t',
      PAPERCUSP_FLAG_DEMO: '1', // the 2026-06-06 leaked-flag class
      PAPERCUSP_OPERATOR_URL: 'http://host', // the 2026-06-07 non-flag class
      SPAWN_SU_BEARER: 'tok', // NOT PAPERCUSP_-prefixed and not in HOST_ENV_STRIP — survives
      AGENT_MODELS: '{"worker":"opus"}', // the 2026-06-09 invoke.test class
    };
    const env = buildGreenCheckpointEnv('base123', src);
    expect(env.PAPERCUSP_FLAG_DEMO).toBeUndefined();
    expect(env.PAPERCUSP_OPERATOR_URL).toBeUndefined();
    expect(env.AGENT_MODELS).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/t');
    expect(env.SPAWN_SU_BEARER).toBe('tok');
    // pure — never mutates the caller's env object
    expect(src.PAPERCUSP_FLAG_DEMO).toBe('1');
  });

  it('sets GREEN_CHECKPOINT=1 and AFFECTED_BASE only when a base is given', () => {
    const withBase = buildGreenCheckpointEnv('abc', {});
    expect(withBase.GREEN_CHECKPOINT).toBe('1');
    expect(withBase.AFFECTED_BASE).toBe('abc');
    const noBase = buildGreenCheckpointEnv(null, {});
    expect(noBase.GREEN_CHECKPOINT).toBe('1');
    expect(noBase.AFFECTED_BASE).toBeUndefined();
  });

  it('defaults the vitest cap + retry but never clobbers a pre-set value', () => {
    const defaulted = buildGreenCheckpointEnv('b', {});
    // WI-806: the fork cap was lowered 8→4 (GREEN_CHECKPOINT_MAX_FORKS) so the forks
    // can't collectively OOM-kill a worker under fleet load (the worker-pool crash);
    // 2026-06-25 lowered again 4→2 after 4 STILL OOM-/timeout-flaked the gate red for
    // 1h+ on the chronically-swapping box (forced a manual force-deploy).
    expect(defaulted.VITEST_MAX_FORKS).toBe(String(GREEN_CHECKPOINT_MAX_FORKS));
    expect(defaulted.VITEST_MAX_THREADS).toBe(String(GREEN_CHECKPOINT_MAX_FORKS));
    expect(GREEN_CHECKPOINT_MAX_FORKS).toBe(2);
    expect(defaulted.AFFECTED_RETRY_FAILED).toBe('1');
    // 2026-06-22: heavy `await import()` unit tests take 74-97s under the gate's
    // 8-fork transform contention; the gate raises the unit timeout to 180s (dev
    // keeps the 60s libs/test-config default) — see buildGreenCheckpointEnv.
    expect(defaulted.VITEST_UNIT_TIMEOUT_MS).toBe('180000');
    const preset = buildGreenCheckpointEnv('b', { VITEST_MAX_FORKS: '6', AFFECTED_RETRY_FAILED: '0' });
    expect(preset.VITEST_MAX_FORKS).toBe('6'); // honored (distinct from the default to prove precedence)
    expect(preset.VITEST_MAX_THREADS).toBe(String(GREEN_CHECKPOINT_MAX_FORKS)); // still defaulted
    expect(preset.AFFECTED_RETRY_FAILED).toBe('0'); // '0' is a value, not absent — honored
  });

  it('strips the host 128 GiB --max-old-space-size from NODE_OPTIONS, pins a sane per-fork heap', () => {
    // The exact bg-host/staging env that held `main` red ~16h: a 128 GiB heap +
    // --expose-gc inherited straight into the 8 vitest forks.
    const env = buildGreenCheckpointEnv('b', {
      NODE_OPTIONS: '--max-old-space-size=131072 --expose-gc',
    });
    expect(env.NODE_OPTIONS).toBe(`--expose-gc --max-old-space-size=${GREEN_CHECKPOINT_FORK_HEAP_MB}`);
    expect(env.NODE_OPTIONS).not.toContain('131072');
  });
});

describe('sanitizeForkNodeOptions (the gate must not inherit the host 128 GiB heap)', () => {
  const HEAP = `--max-old-space-size=${GREEN_CHECKPOINT_FORK_HEAP_MB}`;

  it('replaces an inherited =value heap flag, preserving other tokens', () => {
    expect(sanitizeForkNodeOptions('--max-old-space-size=131072 --expose-gc')).toBe(`--expose-gc ${HEAP}`);
  });

  it('drops the space-separated `--flag value` form (both tokens)', () => {
    expect(sanitizeForkNodeOptions('--max-old-space-size 131072 --enable-source-maps')).toBe(
      `--enable-source-maps ${HEAP}`,
    );
  });

  it('handles the underscore spelling too', () => {
    expect(sanitizeForkNodeOptions('--max_old_space_size=99999')).toBe(HEAP);
  });

  it('pins the heap deterministically even with empty/undefined input', () => {
    expect(sanitizeForkNodeOptions(undefined)).toBe(HEAP);
    expect(sanitizeForkNodeOptions('')).toBe(HEAP);
  });

  it('honors a caller-chosen cap', () => {
    expect(sanitizeForkNodeOptions('--max-old-space-size=131072', 8192)).toBe('--max-old-space-size=8192');
  });
});

describe('checkpointFailureSignature (P-012 dedup, SPA-build folded in)', () => {
  it('is empty on a green run even if the output contains FAIL-looking text', () => {
    expect(checkpointFailureSignature(' FAIL  lib/x.test.ts > c', true, true)).toEqual([]);
  });

  it('is the suite signature (no vite sentinel) when the suite failed but the build is ok', () => {
    expect(checkpointFailureSignature(' FAIL  lib/x.test.ts > c', false, true)).toEqual(['lib/x.test.ts']);
  });

  it('appends @papercusp/operator-vite when the build (not the suite) is what failed', () => {
    // suite passed (no FAIL markers) but build broke → only the build sentinel
    expect(
      checkpointFailureSignature('\n=== SPA BUILD FAILED (@papercusp/operator-vite) ===\nerror', false, false),
    ).toEqual(['@papercusp/operator-vite']);
  });

  it('does not duplicate the build sentinel when it is already in the extracted set', () => {
    const sig = checkpointFailureSignature('>>> @papercusp/operator-vite FAILED — retry', false, false);
    expect(sig).toEqual(['@papercusp/operator-vite']);
  });
});

describe('summarizeSuiteOutput (de-noised held-gate tail)', () => {
  it('drops npm error boilerplate, keeps FAIL + assertion signal', () => {
    const out = [
      'npm error code 1',
      ' FAIL  lib/x.test.ts > case',
      'npm error A complete log of this run can be found in:',
      'AssertionError: expected 1 to be 2',
    ].join('\n');
    const s = summarizeSuiteOutput(out);
    expect(s).not.toMatch(/npm error/);
    expect(s).toContain('FAIL  lib/x.test.ts');
    expect(s).toContain('AssertionError: expected 1 to be 2');
  });

  it('keeps only the last 2000 chars', () => {
    expect(summarizeSuiteOutput('x'.repeat(3000))).toHaveLength(2000);
  });
});

// load-flake-isolation-2026-06-23: the SAFE load-flake absorber. The 2026-06-23 incident:
// runner-aggregate.test.ts + scheduler-workspace-scope.test.ts (both @papercusp/operator-core)
// failed the gate under the 8-fork checkpoint load but PASS in isolation, and the
// AFFECTED_RETRY_FAILED=1 workspace retry didn't absorb them — holding the whole fleet's
// gate for 4h. These cover the pure parse + decision + orchestration without real vitest.

// A realistic affected-runner output for the actual incident: two files fail under
// @papercusp/operator-core's section (the `>>>` header), shown via both a `FAIL` suite row
// and a `❯ … failed` summary row, the two formats parseFailingFilesByWorkspace handles.
const INCIDENT_OUTPUT = [
  'Affected workspaces (2): @papercusp/operator-core, @papercusp/agent-mcp',
  '',
  '>>> @papercusp/operator-core :: npm run test',
  ' FAIL  lib/llm-testing/__tests__/runner-aggregate.test.ts > aggregates runs',
  ' ❯ lib/scout/scheduler-workspace-scope.test.ts (12 tests | 1 failed) 21034ms',
  '   Test timed out in 20000ms',
  '>>> @papercusp/operator-core FAILED — retrying once (AFFECTED_RETRY_FAILED, flake absorption)',
  '',
  '>>> @papercusp/agent-mcp :: npm run test',
  ' Tests  340 passed (340)',
  '',
  '2 non-quarantined task(s) failed.',
].join('\n');

describe('parseFailingFilesByWorkspace (load-flake isolation)', () => {
  it('groups failing FILES under the workspace section they ran in (both FAIL + ❯ formats)', () => {
    expect(parseFailingFilesByWorkspace(INCIDENT_OUTPUT)).toEqual([
      { workspace: '@papercusp/operator-core', file: 'lib/llm-testing/__tests__/runner-aggregate.test.ts' },
      { workspace: '@papercusp/operator-core', file: 'lib/scout/scheduler-workspace-scope.test.ts' },
    ]);
  });

  it('does NOT return bare workspace markers (only real .test/.spec files)', () => {
    const files = parseFailingFilesByWorkspace(INCIDENT_OUTPUT).map((f) => f.file);
    expect(files.every((f) => /\.(test|spec)\./.test(f))).toBe(true);
    expect(files).not.toContain('@papercusp/operator-core');
  });

  it('skips a FAIL line with no preceding workspace header (no cwd to run it in)', () => {
    const out = ' FAIL  lib/orphan.test.ts > case\nno header above';
    expect(parseFailingFilesByWorkspace(out)).toEqual([]);
  });

  it('dedupes a file that appears in multiple rows of the same workspace', () => {
    const out = [
      '>>> @papercusp/x :: npm run test',
      ' FAIL  lib/a.test.ts > one',
      ' ❯ lib/a.test.ts (3 tests | 2 failed) 5ms',
    ].join('\n');
    expect(parseFailingFilesByWorkspace(out)).toEqual([{ workspace: '@papercusp/x', file: 'lib/a.test.ts' }]);
  });

  it('returns [] on empty / non-vitest output (build break)', () => {
    expect(parseFailingFilesByWorkspace('')).toEqual([]);
    expect(parseFailingFilesByWorkspace('=== SPA BUILD FAILED (@papercusp/operator-vite) ===\nerror TS2304')).toEqual([]);
  });
});

describe('decideFlakeAbsorption (pure flake-vs-real decision — NEVER hides a real bug)', () => {
  const ff = (workspace: string, file: string): FailingFile => ({ workspace, file });
  const ir = (workspace: string, file: string, passed: boolean, errored = false): IsolationResult => ({
    workspace,
    file,
    passed,
    errored,
  });

  it('all-flakes: every originally-failing file PASSES in isolation', () => {
    const originalFailing = [ff('@p/core', 'a.test.ts'), ff('@p/core', 'b.test.ts')];
    const isolationResults = [ir('@p/core', 'a.test.ts', true), ir('@p/core', 'b.test.ts', true)];
    const d = decideFlakeAbsorption({ originalFailing, isolationResults });
    expect(d.verdict).toBe('all-flakes');
    expect(d.flakeAbsorbed).toEqual(['@p/core::a.test.ts', '@p/core::b.test.ts']);
    expect(d.stillFailing).toEqual([]);
  });

  it('real-break: ONE file still fails in isolation ⇒ gate stays red (no hiding)', () => {
    const originalFailing = [ff('@p/core', 'a.test.ts'), ff('@p/core', 'b.test.ts')];
    const isolationResults = [ir('@p/core', 'a.test.ts', true), ir('@p/core', 'b.test.ts', false)];
    const d = decideFlakeAbsorption({ originalFailing, isolationResults });
    expect(d.verdict).toBe('real-break');
    expect(d.stillFailing).toEqual(['@p/core::b.test.ts']);
  });

  it('real-break: an ERRORED isolation re-run counts as still-failing (fail-safe)', () => {
    const originalFailing = [ff('@p/core', 'a.test.ts')];
    const isolationResults = [ir('@p/core', 'a.test.ts', false, true)];
    expect(decideFlakeAbsorption({ originalFailing, isolationResults }).verdict).toBe('real-break');
  });

  it('real-break: a MISSING isolation result counts as still-failing (never assume a flake)', () => {
    const originalFailing = [ff('@p/core', 'a.test.ts'), ff('@p/core', 'b.test.ts')];
    const isolationResults = [ir('@p/core', 'a.test.ts', true)]; // no result for b
    const d = decideFlakeAbsorption({ originalFailing, isolationResults });
    expect(d.verdict).toBe('real-break');
    expect(d.stillFailing).toEqual(['@p/core::b.test.ts']);
  });

  it('inconclusive: no originally-failing files (caller keeps the original red verdict)', () => {
    expect(decideFlakeAbsorption({ originalFailing: [], isolationResults: [] }).verdict).toBe('inconclusive');
  });
});

describe('attemptFlakeAbsorption (orchestration — injected isolation runner)', () => {
  it('absorbs the 2026-06-23 incident: both files pass in isolation ⇒ green', async () => {
    const ran: string[] = [];
    const isolationRun = async ({ workspace, file }: { workspace: string; file: string }): Promise<IsolationResult> => {
      ran.push(`${workspace}::${file}`);
      return { workspace, file, passed: true }; // both pass at single concurrency
    };
    const out = await attemptFlakeAbsorption(INCIDENT_OUTPUT, isolationRun);
    expect(out.absorbedToGreen).toBe(true);
    expect(out.flakeSuspects).toEqual([
      '@papercusp/operator-core::lib/llm-testing/__tests__/runner-aggregate.test.ts',
      '@papercusp/operator-core::lib/scout/scheduler-workspace-scope.test.ts',
    ]);
    // it actually re-ran each originally-failing file
    expect(ran).toHaveLength(2);
  });

  it('does NOT absorb when a file still fails in isolation (real break stays red)', async () => {
    const isolationRun = async ({ workspace, file }: { workspace: string; file: string }): Promise<IsolationResult> => ({
      workspace,
      file,
      passed: file.includes('runner-aggregate'), // scheduler-workspace-scope STILL fails
    });
    const out = await attemptFlakeAbsorption(INCIDENT_OUTPUT, isolationRun);
    expect(out.absorbedToGreen).toBe(false);
    expect(out.flakeSuspects).toEqual([]);
  });

  it('a THROWING isolation runner defaults to red (uncertainty never flips to green)', async () => {
    const isolationRun = async (): Promise<IsolationResult> => {
      throw new Error('vitest spawn failed');
    };
    const out = await attemptFlakeAbsorption(INCIDENT_OUTPUT, isolationRun);
    expect(out.absorbedToGreen).toBe(false);
  });

  it('a build break / non-vitest red (no parseable files) stays red — never re-runs', async () => {
    let called = false;
    const isolationRun = async ({ workspace, file }: { workspace: string; file: string }): Promise<IsolationResult> => {
      called = true;
      return { workspace, file, passed: true };
    };
    const out = await attemptFlakeAbsorption('=== SPA BUILD FAILED (@papercusp/operator-vite) ===', isolationRun);
    expect(out.absorbedToGreen).toBe(false);
    expect(called).toBe(false); // nothing to re-run
  });

  it('a BROAD red (> ISOLATION_MAX_FILES files) is a real regression — never absorbed', async () => {
    const lines = ['>>> @papercusp/operator-core :: npm run test'];
    for (let i = 0; i <= ISOLATION_MAX_FILES; i++) lines.push(` FAIL  lib/f${i}.test.ts > case`);
    let called = false;
    const isolationRun = async ({ workspace, file }: { workspace: string; file: string }): Promise<IsolationResult> => {
      called = true;
      return { workspace, file, passed: true };
    };
    const out = await attemptFlakeAbsorption(lines.join('\n'), isolationRun);
    expect(out.absorbedToGreen).toBe(false);
    expect(called).toBe(false); // a broad red is never load-flake absorption
  });
});

// worker-pool-crash-absorption-2026-06-25 (WI-806): the SAFE worker-pool-crash absorber.
// The incident: @papercusp/operator-core's `vitest run --passWithNoTests` CRASHED a worker
// fork (ENOMEM/OOM-kill under the shared box's fleet load) — `[vitest-pool]: Worker forks
// emitted error` / `Worker exited unexpectedly` — with NO per-file `FAIL` rows. The
// existing per-file isolation absorber parsed ZERO files and fell through to a hard RED
// that wedged the release pipeline 5× in a row. These cover the pure classify + parse +
// orchestration without real vitest. The exact crash signature from the real checkpoint log:
const WORKER_CRASH_OUTPUT = [
  '>>> @papercusp/operator-core :: npm run test',
  'Error: [vitest-pool]: Worker forks emitted error.',
  '    ❯ EventEmitter.<anonymous> ../../node_modules/vitest/dist/chunks/cli-api.js:3446:22',
  'Caused by: Error: Worker exited unexpectedly',
  '    ❯ ChildProcess.emitUnexpectedExit ../../node_modules/vitest/dist/chunks/cli-api.js:3012:33',
  '',
  'npm error Lifecycle script `test` failed with error:',
  'npm error code 1',
  'npm error workspace @papercusp/operator-core@0.1.0',
  'npm error location /home/x/papercup-checkpoint/packages/operator-core',
  'npm error command sh -c vitest run --passWithNoTests',
  '',
  '1 non-quarantined task(s) failed.',
].join('\n');

describe('isWorkerPoolCrash + parseCrashedWorkspaces (WI-806)', () => {
  it('classifies the real worker-pool crash output as a pool crash', () => {
    expect(isWorkerPoolCrash(WORKER_CRASH_OUTPUT)).toBe(true);
    expect(isWorkerPoolCrash('Worker terminated')).toBe(true);
  });

  it('is NOT a pool crash for an ordinary test failure', () => {
    expect(isWorkerPoolCrash(' FAIL  lib/x.test.ts > case\nAssertionError: expected 1 to be 2')).toBe(false);
  });

  it('harvests the crashed workspace from the `npm error workspace` footer (strips @version)', () => {
    expect(parseCrashedWorkspaces(WORKER_CRASH_OUTPUT)).toEqual(['@papercusp/operator-core']);
  });

  it('falls back to the `>>>` section header when no npm-error-workspace footer is present', () => {
    const out = '>>> @papercusp/agent-mcp :: npm run test\nError: [vitest-pool]: Worker forks emitted error.';
    expect(parseCrashedWorkspaces(out)).toEqual(['@papercusp/agent-mcp']);
  });

  it('returns [] when no workspace is localizable', () => {
    expect(parseCrashedWorkspaces('Worker exited unexpectedly')).toEqual([]);
  });
});

describe('attemptWorkerCrashAbsorption (WI-806 — absorb-or-retry the no-signature crash)', () => {
  it('(a) crash + zero parseable files + passing re-run ⇒ green + flakeSuspect', async () => {
    const ran: string[] = [];
    const workspaceRerun = async ({ workspace }: { workspace: string }): Promise<WorkspaceRerunResult> => {
      ran.push(workspace);
      return { workspace, passed: true }; // passes cleanly at reduced concurrency
    };
    const out = await attemptWorkerCrashAbsorption(WORKER_CRASH_OUTPUT, workspaceRerun);
    expect(out.absorbedToGreen).toBe(true);
    expect(out.flakeSuspects).toEqual(['@papercusp/operator-core (worker-pool crash)']);
    expect(ran).toEqual(['@papercusp/operator-core']); // it actually re-ran the crashed ws
  });

  it('(b) crash + re-run STILL crashes ⇒ red (never blanket-green a crash)', async () => {
    const workspaceRerun = async ({ workspace }: { workspace: string }): Promise<WorkspaceRerunResult> => ({
      workspace,
      passed: false,
      crashedAgain: true,
    });
    const out = await attemptWorkerCrashAbsorption(WORKER_CRASH_OUTPUT, workspaceRerun);
    expect(out.absorbedToGreen).toBe(false);
    expect(out.flakeSuspects).toEqual([]);
  });

  it('(b2) crash + re-run reveals a REAL per-file failure ⇒ red', async () => {
    const workspaceRerun = async ({ workspace }: { workspace: string }): Promise<WorkspaceRerunResult> => ({
      workspace,
      passed: false,
      realFailure: true,
    });
    expect((await attemptWorkerCrashAbsorption(WORKER_CRASH_OUTPUT, workspaceRerun)).absorbedToGreen).toBe(false);
  });

  it('(b3) a THROWING re-run defaults to red (uncertainty never flips to green)', async () => {
    const workspaceRerun = async (): Promise<WorkspaceRerunResult> => {
      throw new Error('vitest spawn failed');
    };
    expect((await attemptWorkerCrashAbsorption(WORKER_CRASH_OUTPUT, workspaceRerun)).absorbedToGreen).toBe(false);
  });

  it('(c) a REAL per-file failure is NEVER mistaken for a worker-crash flake (no re-run)', async () => {
    // Ordinary red WITH parseable per-file failures — not a pool crash. Even if it also
    // contained a pool marker, the parseable per-file failures route it to the isolation
    // absorber, never this workspace re-run.
    let called = false;
    const workspaceRerun = async ({ workspace }: { workspace: string }): Promise<WorkspaceRerunResult> => {
      called = true;
      return { workspace, passed: true };
    };
    const out = await attemptWorkerCrashAbsorption(INCIDENT_OUTPUT, workspaceRerun);
    expect(out.absorbedToGreen).toBe(false);
    expect(called).toBe(false); // a genuine test failure is never re-run as a crash flake
  });

  it('(c2) a pool crash that STILL named per-file failures defers to the isolation absorber (no workspace re-run)', async () => {
    const withFiles = WORKER_CRASH_OUTPUT + '\n FAIL  lib/real.test.ts > a case';
    let called = false;
    const workspaceRerun = async ({ workspace }: { workspace: string }): Promise<WorkspaceRerunResult> => {
      called = true;
      return { workspace, passed: true };
    };
    expect((await attemptWorkerCrashAbsorption(withFiles, workspaceRerun)).absorbedToGreen).toBe(false);
    expect(called).toBe(false);
  });

  it('a BROAD multi-workspace crash (> WORKER_CRASH_MAX_WORKSPACES) is a real regression — never absorbed', async () => {
    const lines = ['Error: [vitest-pool]: Worker forks emitted error.'];
    for (let i = 0; i <= WORKER_CRASH_MAX_WORKSPACES; i++) lines.push(`npm error workspace @p/ws${i}@1.0.0`);
    let called = false;
    const workspaceRerun = async ({ workspace }: { workspace: string }): Promise<WorkspaceRerunResult> => {
      called = true;
      return { workspace, passed: true };
    };
    const out = await attemptWorkerCrashAbsorption(lines.join('\n'), workspaceRerun);
    expect(out.absorbedToGreen).toBe(false);
    expect(called).toBe(false);
  });

  it('one of two crashed workspaces still failing ⇒ red (all must pass to absorb)', async () => {
    const out2 = WORKER_CRASH_OUTPUT.replace(
      'npm error workspace @papercusp/operator-core@0.1.0',
      'npm error workspace @papercusp/operator-core@0.1.0\nnpm error workspace @papercusp/agent-mcp@0.1.0',
    );
    const workspaceRerun = async ({ workspace }: { workspace: string }): Promise<WorkspaceRerunResult> => ({
      workspace,
      passed: workspace === '@papercusp/operator-core', // agent-mcp still fails
    });
    expect((await attemptWorkerCrashAbsorption(out2, workspaceRerun)).absorbedToGreen).toBe(false);
  });
});

// P-016 (release-pipeline-resilience-2026-06-09 D-010): longest-green-PREFIX FF — a red
// batch TIP no longer holds the clean prefix hostage. The invariant under test: `main`
// only ever FFs to a commit that ITSELF ran green (the confirm-run), so a wrong prefix
// guess just holds (today's behavior), never deploys untested code. Env-armed (default-OFF).
describe('runGreenCheckpoint — longest-green-prefix (P-016)', () => {
  // Build a real commit chain c1(ready) → c2 → c3 → c4(candidate) so advanceReady /
  // isAncestor work; stub the NEW deps (commitsInRange / affectedWorkspacesForRange) and
  // the two runGreen calls (1 = candidate red, 2 = confirm on the chosen prefix).
  function partialDeps(opts: {
    candidateFailingTests?: string[];
    affected: Record<string, string[]>; // sha → affected workspace names for that prefix's range
    commits: string[]; // lastReady..candidate, OLDEST-FIRST full shas
    confirmGreen: boolean;
  }): { deps: CheckpointDeps; calls: string[] } {
    const calls: string[] = [];
    let runGreenN = 0;
    const deps: CheckpointDeps = {
      setupTree: async (ref) => { calls.push(`setup:${ref.slice(0, 7)}`); },
      runGreen: async () => {
        runGreenN++;
        if (runGreenN === 1) {
          calls.push('runGreen:candidate');
          return { green: false, summary: 'red', failingTests: opts.candidateFailingTests };
        }
        calls.push('runGreen:confirm');
        return { green: opts.confirmGreen, summary: opts.confirmGreen ? 'all pass' : 'still red' };
      },
      advance: (c) => { calls.push(`advance:${c.slice(0, 7)}`); return advanceReady(repo, c, 'ready'); },
      push: async () => { calls.push('push'); },
      broadcast: async () => { calls.push('broadcast'); },
      escalate: async () => { calls.push('escalate'); },
      clearEscalation: async () => { calls.push('clearEscalation'); },
      commitsInRange: async () => { calls.push('commitsInRange'); return opts.commits; },
      affectedWorkspacesForRange: async (_from, to) => { calls.push(`affected:${to.slice(0, 7)}`); return opts.affected[to] ?? []; },
      log: () => {},
    };
    return { deps, calls };
  }

  beforeEach(() => { process.env.PAPERCUSP_PARTIAL_GREEN_GATE = '1'; });
  afterEach(() => { delete process.env.PAPERCUSP_PARTIAL_GREEN_GATE; });

  async function chain() {
    const c1 = await commit('a', '1', 'c1');
    await git(repo, ['branch', 'ready', c1]);
    const c2 = await commit('b', '2', 'c2'); // touches ws "other"
    const c3 = await commit('b', '3', 'c3'); // touches ws "other"
    const c4 = await commit('c', '4', 'c4'); // touches ws "failing" (the red tip)
    return { c1, c2, c3, c4 };
  }

  it('advances `main` to the longest GREEN prefix and holds the red tip', async () => {
    const { c2, c3, c4 } = await chain();
    const { deps, calls } = partialDeps({
      candidateFailingTests: ['@ws/failing'],
      affected: { [c2]: ['@ws/other'], [c3]: ['@ws/other'], [c4]: ['@ws/failing', '@ws/other'] },
      commits: [c2, c3, c4],
      confirmGreen: true,
    });
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(r).toMatchObject({ advanced: true, reason: 'advanced-prefix', candidate: c4, advancedTo: c3, green: false });
    expect(r.failingTests).toEqual(['@ws/failing']); // red tip's signature preserved for the fixer
    expect(await revParse(repo, 'ready')).toBe(c3); // FF'd to the longest clean prefix, NOT the red tip
    expect(calls).toContain('runGreen:confirm');
    expect(calls).toContain('advance:' + c3.slice(0, 7));
  });

  it('holds (no advance) when the confirm-run on the prefix is RED — never FFs to unconfirmed', async () => {
    const { c1, c3, c4 } = await chain();
    const { deps } = partialDeps({
      candidateFailingTests: ['@ws/failing'],
      affected: { [c4]: ['@ws/failing'] }, // c3 not listed ⇒ clean ⇒ chosen as the prefix to confirm
      commits: [c3, c4],
      confirmGreen: false, // the chosen prefix did NOT confirm green ⇒ must hold
    });
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(r.reason).toBe('not-green');
    expect(r.advanced).toBe(false);
    expect(await revParse(repo, 'ready')).toBe(c1); // unchanged — no FF to an unconfirmed commit
  });

  it('holds when the FIRST new commit already implicates a failing workspace (no clean prefix)', async () => {
    const { c1, c2, c3, c4 } = await chain();
    const { deps, calls } = partialDeps({
      candidateFailingTests: ['@ws/failing'],
      affected: { [c2]: ['@ws/failing'], [c3]: ['@ws/failing'], [c4]: ['@ws/failing'] },
      commits: [c2, c3, c4],
      confirmGreen: true,
    });
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(r.reason).toBe('not-green');
    expect(await revParse(repo, 'ready')).toBe(c1); // unchanged
    expect(calls).not.toContain('runGreen:confirm'); // no clean prefix ⇒ never even confirms
  });

  it('holds when the failure is not workspace-localizable (only file-path / build failures)', async () => {
    const { c1, c2, c3, c4 } = await chain();
    const { deps } = partialDeps({
      candidateFailingTests: ['lib/foo.test.ts', '@papercusp/operator-vite'], // file path + build sentinel, no ws-name match
      affected: { [c4]: ['@ws/failing', '@ws/other'] },
      commits: [c2, c3, c4],
      confirmGreen: true,
    });
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(r.reason).toBe('not-green'); // failingWs ∩ affected = ∅ ⇒ decline, don't guess
    expect(await revParse(repo, 'ready')).toBe(c1);
  });

  it('holds when there is only ONE new commit (the red tip itself — nothing behind it)', async () => {
    const c1 = await commit('a', '1', 'c1');
    await git(repo, ['branch', 'ready', c1]);
    const c2 = await commit('c', '2', 'c2'); // the single red commit
    const { deps, calls } = partialDeps({
      candidateFailingTests: ['@ws/failing'],
      affected: { [c2]: ['@ws/failing'] },
      commits: [c2],
      confirmGreen: true,
    });
    const r = await runGreenCheckpoint(cfg(), deps, { candidate: c2, noPush: true });
    expect(r.reason).toBe('not-green');
    expect(calls).not.toContain('runGreen:confirm');
  });

  it('is OFF by default — without PAPERCUSP_PARTIAL_GREEN_GATE a red candidate holds exactly as before', async () => {
    delete process.env.PAPERCUSP_PARTIAL_GREEN_GATE; // override the beforeEach arm
    const { c1, c2, c3, c4 } = await chain();
    const { deps, calls } = partialDeps({
      candidateFailingTests: ['@ws/failing'],
      affected: { [c2]: ['@ws/other'], [c3]: ['@ws/other'], [c4]: ['@ws/failing'] },
      commits: [c2, c3, c4],
      confirmGreen: true,
    });
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(r.reason).toBe('not-green'); // gate OFF ⇒ no salvage attempt
    expect(await revParse(repo, 'ready')).toBe(c1);
    expect(calls).not.toContain('commitsInRange'); // the salvage path never ran
  });
});
