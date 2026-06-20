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
  checkpointFailureSignature,
  summarizeSuiteOutput,
  type CheckpointDeps,
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

function stubDeps(green: boolean, failingTests?: string[]): { deps: CheckpointDeps; calls: string[] } {
  const calls: string[] = [];
  const deps: CheckpointDeps = {
    setupTree: async (ref) => {
      calls.push(`setup:${ref.slice(0, 7)}`);
    },
    runGreen: async () => {
      calls.push('runGreen');
      return { green, summary: green ? 'all pass' : '3 failed', failingTests };
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
    expect(defaulted.VITEST_MAX_FORKS).toBe('8');
    expect(defaulted.VITEST_MAX_THREADS).toBe('8');
    expect(defaulted.AFFECTED_RETRY_FAILED).toBe('1');
    const preset = buildGreenCheckpointEnv('b', { VITEST_MAX_FORKS: '2', AFFECTED_RETRY_FAILED: '0' });
    expect(preset.VITEST_MAX_FORKS).toBe('2'); // honored
    expect(preset.VITEST_MAX_THREADS).toBe('8'); // still defaulted
    expect(preset.AFFECTED_RETRY_FAILED).toBe('0'); // '0' is a value, not absent — honored
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
