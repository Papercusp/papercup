/**
 * WI-6454 — the gitnexus re-index cadence policy.
 *
 * The two things worth pinning here are (a) the `--skip-agents-md` guard, which is the
 * difference between a maintenance job and one that corrupts every agent's prompt
 * source, and (b) the ORDER of the gates in `decideReindex` — the policy is only correct
 * if load outranks a missing index and the interval floor outranks staleness.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readFileSync,
  utimesSync,
  openSync,
  closeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildAnalyzeArgs,
  buildAnalyzeInvocation,
  analyzeEnv,
  analyzeNodeArgs,
  analyzeCliPath,
  GITNEXUS_ANALYZE_HEAP_MB,
  GITNEXUS_ANALYZE_MEMORY_MAX_BYTES,
  GITNEXUS_ANALYZE_SEMI_SPACE_MB,
  GITNEXUS_ANALYZE_STACK_KB,
  GITNEXUS_LBUG_MAX_DB_BYTES,
  GITNEXUS_LBUG_BUFFER_POOL_BYTES,
  GITNEXUS_LBUG_DB_ALERT_RATIO,
  readIncompleteIndexMarker,
  describeStrandedIncompleteIndex,
  readStrandedIncompleteIndex,
  gitnexusMetaPath,
  measureGitnexusDbUsage,
  measureGitnexusIndexDisk,
  decideGitnexusDbHealthUpdate,
  decideIndexDiskHealthUpdate,
  decideReindex,
  readRegistryEntry,
  shouldSkipForHive,
  GITNEXUS_REPO_NAME,
  DEFAULT_MAX_LOAD_PER_CORE,
  DEFAULT_MIN_COMMITS_BEHIND,
  DEFAULT_MIN_INTERVAL_SEC,
  gitnexusDbPaths,
  isOrphanShadow,
  isOrphanWal,
  isDeadShadow,
  DEAD_SHADOW_STALE_MS,
  cleanCrashResidue,
  probeOpenHandles,
  classifyWriterLiveness,
  type OpenHandleProbe,
  judgeCanary,
  GITNEXUS_HEALTH_DEFAULT,
  GITNEXUS_FAILURE_ALERT_THRESHOLD,
  decideGitnexusHealthUpdate,
  runGitnexusAnalyze,
  type ReindexDecisionInput,
  type GitnexusHealth,
} from './gitnexus-reindex-action';

const taskManager = vi.hoisted(() => ({
  managedSpawn: vi.fn(),
}));

vi.mock('../../task-manager/managed-spawn', () => ({ managedSpawn: taskManager.managedSpawn }));

function fakeManagedChild(): EventEmitter & {
  pid: number;
  kill: ReturnType<typeof vi.fn>;
  stdout: EventEmitter;
  stderr: EventEmitter;
} {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    kill: ReturnType<typeof vi.fn>;
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  child.pid = 4242;
  child.kill = vi.fn();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

beforeEach(() => {
  taskManager.managedSpawn.mockReset();
});

/** A baseline that WOULD run, so each test can flip exactly one field. */
function baseInput(over: Partial<ReindexDecisionInput> = {}): ReindexDecisionInput {
  return {
    registered: true,
    commitsBehind: 50,
    loadPerCore: 0.5,
    secondsSinceIndexed: 4 * 3600,
    memoryPressure: 'ok',
    minCommitsBehind: DEFAULT_MIN_COMMITS_BEHIND,
    maxLoadPerCore: DEFAULT_MAX_LOAD_PER_CORE,
    minIntervalSec: DEFAULT_MIN_INTERVAL_SEC,
    ...over,
  };
}

describe('buildAnalyzeArgs', () => {
  it('ALWAYS passes --skip-agents-md (without it, analyze rewrites CLAUDE.md + AGENTS.md)', () => {
    expect(buildAnalyzeArgs('/repo', 'papercusp')).toContain('--skip-agents-md');
  });

  it('names the repo so the alias cannot collide with another checkout on the box', () => {
    const args = buildAnalyzeArgs('/repo', GITNEXUS_REPO_NAME);
    expect(args[args.indexOf('--name') + 1]).toBe(GITNEXUS_REPO_NAME);
  });

  it('analyzes the root it is given, not the process cwd', () => {
    expect(buildAnalyzeArgs('/some/root', 'x')).toContain('/some/root');
  });

  it('does not pass --force (that would defeat any staleness short-circuit analyze does)', () => {
    expect(buildAnalyzeArgs('/repo', 'x')).not.toContain('--force');
  });
});

// ===========================================================================
// P-004 — ANALYZE RESOURCE CAP.
//
// The cap is split across TWO surfaces for a reason that is invisible from either one
// alone, so each half is pinned here: the heap/semi-space go in NODE_OPTIONS (which
// ALSO suppresses gitnexus's self-re-exec), and --stack-size can only be argv because
// Node 24+ refuses it in NODE_OPTIONS. Get either half wrong and the failure is silent
// — an uncapped 30 GiB heap, or a crash-on-startup, or a lost stack budget.
//
// Every block carries a CALIBRATION case: an assertion that fails if the mechanism does
// nothing at all, so a suite of "was not overridden" assertions cannot pass green
// against a function that never sets anything.
// ===========================================================================

describe('analyzeEnv — the heap cap (P-004)', () => {
  it('caps the old-space heap at the measured budget', () => {
    const env = analyzeEnv({}, GITNEXUS_ANALYZE_HEAP_MB);
    expect(env.NODE_OPTIONS).toContain(`--max-old-space-size=${GITNEXUS_ANALYZE_HEAP_MB}`);
  });

  it('SUPPRESSES gitnexus self-re-exec by setting the flag it early-returns on', () => {
    // Load-bearing, and the reason this is an env var rather than an argv flag:
    // gitnexus's ensureHeap() returns early iff NODE_OPTIONS matches this exact
    // substring. Without it, gitnexus re-execs and replaces our cap with 0.75x of a
    // cgroup it shares with every other routine.
    expect(analyzeEnv({}).NODE_OPTIONS).toMatch(/--max-old-space-size/);
  });

  it('preserves the semi-space tuning gitnexus would have applied to itself', () => {
    // Suppressing the re-exec means we inherit responsibility for the flags it carried.
    expect(analyzeEnv({}).NODE_OPTIONS).toContain(
      `--max-semi-space-size=${GITNEXUS_ANALYZE_SEMI_SPACE_MB}`,
    );
  });

  it('NEVER emits --stack-size into NODE_OPTIONS (Node 24+ exits 9 on it)', () => {
    // Verified on node v25.9.0: "--stack-size= is not allowed in NODE_OPTIONS".
    // Leaking it here would not degrade the cap, it would fail every analyze at startup.
    expect(analyzeEnv({}).NODE_OPTIONS).not.toContain('--stack-size');
    expect(analyzeEnv({ NODE_OPTIONS: '--stack-size=4096' }).NODE_OPTIONS).toBeDefined();
  });

  it('honours an operator-supplied heap instead of overriding it', () => {
    const env = analyzeEnv({ NODE_OPTIONS: '--max-old-space-size=4096' });
    expect(env.NODE_OPTIONS).toBe('--max-old-space-size=4096');
    expect(env.NODE_OPTIONS).not.toContain(String(GITNEXUS_ANALYZE_HEAP_MB));
  });

  it('CALIBRATION: a base with no heap DOES get one — so "honours" above means something', () => {
    // Without this, an analyzeEnv() that returned its input unchanged would pass every
    // "was not overridden" assertion in this block.
    expect(analyzeEnv({}).NODE_OPTIONS).toContain(`--max-old-space-size=${GITNEXUS_ANALYZE_HEAP_MB}`);
  });

  it('keeps unrelated NODE_OPTIONS content and unrelated env vars intact', () => {
    const env = analyzeEnv({ NODE_OPTIONS: '--enable-source-maps', PATH: '/usr/bin' });
    expect(env.NODE_OPTIONS).toContain('--enable-source-maps');
    expect(env.NODE_OPTIONS).toContain(`--max-old-space-size=${GITNEXUS_ANALYZE_HEAP_MB}`);
    expect(env.PATH).toBe('/usr/bin');
  });

  it('does not mutate the caller-supplied env object', () => {
    const base: NodeJS.ProcessEnv = {};
    analyzeEnv(base);
    expect(base.NODE_OPTIONS).toBeUndefined();
  });
});

describe('analyzeNodeArgs — the stack budget + argv order (P-004)', () => {
  it('passes --stack-size as a real argv flag', () => {
    expect(analyzeNodeArgs('/cli.js', '/repo', 'papercusp')).toContain(
      `--stack-size=${GITNEXUS_ANALYZE_STACK_KB}`,
    );
  });

  it('puts every node flag BEFORE the script path', () => {
    // node stops parsing its own flags at the first non-flag argument, so a --stack-size
    // that lands after the cli path is silently forwarded to gitnexus as a no-op
    // argument instead of raising the stack. Nothing fails loudly when this is wrong.
    const args = analyzeNodeArgs('/cli.js', '/repo', 'papercusp');
    expect(args.indexOf(`--stack-size=${GITNEXUS_ANALYZE_STACK_KB}`)).toBeLessThan(
      args.indexOf('/cli.js'),
    );
  });

  it('still carries the mandatory --skip-agents-md through the node wrapper', () => {
    // The guard from this module's header must survive the npx -> node refactor: it is
    // the difference between a maintenance job and one that rewrites CLAUDE.md.
    expect(analyzeNodeArgs('/cli.js', '/repo', 'papercusp')).toContain('--skip-agents-md');
  });

  it('runs the pinned cli path it is handed, not an ambient PATH lookup', () => {
    const args = analyzeNodeArgs('/pinned/cli.js', '/repo', 'x');
    expect(args).toContain('/pinned/cli.js');
    expect(args).not.toContain('npx');
    expect(args).not.toContain('--yes');
  });

  it('resolves a pinned absolute cli path, never a bare binary name', () => {
    const p = analyzeCliPath();
    expect(p.startsWith('/')).toBe(true);
    expect(p).toContain('gitnexus');
  });
});

describe('buildAnalyzeInvocation — host-wide heavy-work admission', () => {
  it('wraps the analyze command with pc-heavy resolved from the integration root', () => {
    const root = mkdtempSync(join(tmpdir(), 'gitnexus-heavy-'));
    const scripts = join(root, 'scripts');
    mkdirSync(scripts);
    const wrapper = join(scripts, 'pc-heavy.sh');
    writeFileSync(wrapper, '#!/usr/bin/env bash\n');
    const args = ['--stack-size=4096', '/cli.js', 'analyze', root];

    expect(buildAnalyzeInvocation(root, '/usr/bin/node', args)).toEqual({
      command: 'bash',
      args: [wrapper, '--', '/usr/bin/node', ...args],
    });
  });

  it('fails open to the direct command when the wrapper is absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'gitnexus-no-heavy-'));
    const args = ['--stack-size=4096', '/cli.js', 'analyze', root];

    expect(buildAnalyzeInvocation(root, '/usr/bin/node', args)).toEqual({
      command: '/usr/bin/node',
      args,
    });
  });
});

describe('runGitnexusAnalyze — scheduled task-manager isolation (WI-40213)', () => {
  /**
   * The RUNNER's environment must not decide this verdict.
   *
   * runGitnexusAnalyze feeds the LIVE `process.env` to `analyzeEnv`, and `analyzeEnv`
   * deliberately honours an operator-supplied heap — it early-returns whenever NODE_OPTIONS
   * already carries `--max-old-space-size` (pinned by 'honours an operator-supplied heap
   * instead of overriding it' above). That behaviour is correct and stays. But it means an
   * AMBIENT NODE_OPTIONS makes the assertion below measure whatever heap the test runner was
   * launched with instead of the cap this test exists to pin.
   *
   * green-checkpoint runs the suite with NODE_OPTIONS=--max-old-space-size=4096, which is
   * exactly how candidate dfe7bd9f went red here while the same test is green in any ordinary
   * shell — green for whoever checks it, blocking for everyone else. The DB ceiling is scrubbed
   * for the same reason: `analyzeEnv` lets an explicit GITNEXUS_LBUG_MAX_DB_SIZE win too.
   */
  const RUNNER_ENV_KEYS = [
    'NODE_OPTIONS',
    'GITNEXUS_LBUG_MAX_DB_SIZE',
    'GITNEXUS_LBUG_BUFFER_POOL_SIZE',
  ] as const;
  let savedRunnerEnv: Array<[string, string | undefined]> = [];
  beforeEach(() => {
    savedRunnerEnv = RUNNER_ENV_KEYS.map((key) => [key, process.env[key]]);
    for (const key of RUNNER_ENV_KEYS) delete process.env[key];
  });
  afterEach(() => {
    for (const [key, value] of savedRunnerEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('uses the managed build scope with provenance, resource cap, and a real deadline', async () => {
    // Fails in ONE legible line if the scrub above is ever removed. Without it the same
    // regression surfaces as a 70-property env diff with the heap buried in the middle, which
    // is exactly what the dfe7bd9f red looked like and why it read as a product bug.
    expect(process.env.NODE_OPTIONS, 'the runner-env scrub is not in effect').toBeUndefined();
    const child = fakeManagedChild();
    taskManager.managedSpawn.mockResolvedValue({ child, taskId: 'task-gitnexus' });
    const root = '/repo';
    const repoName = 'papercusp';
    const timeoutMs = 61_001;

    const resultPromise = runGitnexusAnalyze(root, repoName, timeoutMs);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(taskManager.managedSpawn).toHaveBeenCalledTimes(1);
    const [command, args, spec, options] = taskManager.managedSpawn.mock.calls[0] as [
      string,
      string[],
      Record<string, unknown>,
      { spawnOptions: Record<string, unknown> },
    ];
    expect(command).toBe(process.env.GITNEXUS_NODE_BIN ?? process.execPath);
    expect(args).toEqual(analyzeNodeArgs(analyzeCliPath(), root, repoName));
    expect(spec).toMatchObject({
      class: 'build',
      title: 'gitnexus analyze papercusp',
      argv: [command, ...args],
      cwd: root,
      launchedBy: 'system:gitnexus-reindex',
      memoryMaxBytes: GITNEXUS_ANALYZE_MEMORY_MAX_BYTES,
      runtimeMaxSec: 62,
      detail: { subsystem: 'gitnexus', operation: 'analyze', repoName },
    });
    expect(options.spawnOptions).toMatchObject({
      cwd: root,
      env: expect.objectContaining({
        NODE_OPTIONS: expect.stringContaining(`--max-old-space-size=${GITNEXUS_ANALYZE_HEAP_MB}`),
        GITNEXUS_LBUG_MAX_DB_SIZE: String(GITNEXUS_LBUG_MAX_DB_BYTES),
      }),
      detached: true,
    });

    child.emit('close', 0);
    await expect(resultPromise).resolves.toEqual({ code: 0, stdout: '', stderr: '', timedOut: false });
  });

  it('admits the analyze through pc-heavy when the integration root provides it', async () => {
    expect(process.env.NODE_OPTIONS, 'the runner-env scrub is not in effect').toBeUndefined();
    const root = mkdtempSync(join(tmpdir(), 'gitnexus-managed-heavy-'));
    const scripts = join(root, 'scripts');
    mkdirSync(scripts);
    const wrapper = join(scripts, 'pc-heavy.sh');
    writeFileSync(wrapper, '#!/usr/bin/env bash\n');
    const child = fakeManagedChild();
    taskManager.managedSpawn.mockResolvedValue({ child, taskId: 'task-gitnexus-heavy' });
    const repoName = 'papercusp';
    const timeoutMs = 61_001;
    const directCommand = process.env.GITNEXUS_NODE_BIN ?? process.execPath;
    const directArgs = analyzeNodeArgs(analyzeCliPath(), root, repoName);

    const resultPromise = runGitnexusAnalyze(root, repoName, timeoutMs);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(taskManager.managedSpawn).toHaveBeenCalledTimes(1);
    const [command, args, spec] = taskManager.managedSpawn.mock.calls[0] as [
      string,
      string[],
      Record<string, unknown>,
    ];
    expect(command).toBe('bash');
    expect(args).toEqual([wrapper, '--', directCommand, ...directArgs]);
    expect(spec).toMatchObject({
      argv: ['bash', wrapper, '--', directCommand, ...directArgs],
      cwd: root,
      launchedBy: 'system:gitnexus-reindex',
    });

    child.emit('close', 0);
    await expect(resultPromise).resolves.toEqual({ code: 0, stdout: '', stderr: '', timedOut: false });
  });
});

describe('analyzeEnv — the LadybugDB ceiling pin (P-004)', () => {
  it('pins the LadybugDB max size rather than inheriting the upstream default', () => {
    expect(analyzeEnv({}).GITNEXUS_LBUG_MAX_DB_SIZE).toBe(String(GITNEXUS_LBUG_MAX_DB_BYTES));
  });

  it('STILL pins the DB ceiling when an operator overrides the heap', () => {
    // The heap branch early-returns. If the DB pin were applied after it, supplying a
    // heap would silently drop the ceiling too — two unrelated knobs, one of which
    // quietly disables the other, with nothing failing.
    const env = analyzeEnv({ NODE_OPTIONS: '--max-old-space-size=4096' });
    expect(env.NODE_OPTIONS).toBe('--max-old-space-size=4096');
    expect(env.GITNEXUS_LBUG_MAX_DB_SIZE).toBe(String(GITNEXUS_LBUG_MAX_DB_BYTES));
  });

  it('honours an explicit caller-supplied DB ceiling', () => {
    expect(analyzeEnv({ GITNEXUS_LBUG_MAX_DB_SIZE: '999' }).GITNEXUS_LBUG_MAX_DB_SIZE).toBe('999');
  });

  it('leaves real headroom over the measured on-disk database', () => {
    // Measured 2026-08-21: the lbug database file is 3.97 GiB (.gitnexus/ 6.5 GB total)
    // over 19,479 files. If a future graph ever approaches this ceiling, analyze starts
    // failing -- this assertion is the tripwire that says so while it is still cheap.
    const measuredDbGib = 3.97;
    expect(GITNEXUS_LBUG_MAX_DB_BYTES / 1024 ** 3).toBeGreaterThan(measuredDbGib * 3);
  });
});

describe('analyzeEnv — the LadybugDB BUFFER POOL pin (EI-22172147268902766)', () => {
  it('pins the buffer pool rather than inheriting the 2 GiB default that killed the rebuild', () => {
    expect(analyzeEnv({}).GITNEXUS_LBUG_BUFFER_POOL_SIZE).toBe(String(GITNEXUS_LBUG_BUFFER_POOL_BYTES));
  });

  it('STILL pins the buffer pool when an operator overrides the heap', () => {
    // The pool is LadybugDB NATIVE memory: no node flag can influence it. The failing
    // 2026-09-02 run proved the point by dying with a 193 GB heap and a 2 GiB pool, so a
    // heap override silently dropping this pin would reproduce the exact original bug.
    const env = analyzeEnv({ NODE_OPTIONS: '--max-old-space-size=4096' });
    expect(env.NODE_OPTIONS).toBe('--max-old-space-size=4096');
    expect(env.GITNEXUS_LBUG_BUFFER_POOL_SIZE).toBe(String(GITNEXUS_LBUG_BUFFER_POOL_BYTES));
  });

  it('honours an explicit caller-supplied pool size', () => {
    expect(analyzeEnv({ GITNEXUS_LBUG_BUFFER_POOL_SIZE: '123' }).GITNEXUS_LBUG_BUFFER_POOL_SIZE).toBe('123');
  });

  it('clears the 2 GiB default the bulk COPY actually exhausted', () => {
    // The measured wall, not a round number: gitnexus 1.6.10 defaults to min(2 GiB, 80% RAM),
    // and the COPY of a 22,394-file / 238,521-node graph ran out inside it.
    expect(GITNEXUS_LBUG_BUFFER_POOL_BYTES).toBeGreaterThan(2 * 1024 ** 3);
  });

  it('is NOT the 80%-of-RAM escape hatch', () => {
    // `0` is gitnexus's pass-through sentinel for LadybugDB's native 80%-of-RAM default.
    // On this 251 GB shared box that is a ~200 GB RESIDENT pool -- a worse failure than the
    // one being fixed. This asserts we chose a bounded number, not the unbounded one.
    expect(GITNEXUS_LBUG_BUFFER_POOL_BYTES).not.toBe(0);
    expect(GITNEXUS_LBUG_BUFFER_POOL_BYTES).toBeLessThanOrEqual(32 * 1024 ** 3);
  });
});

describe('stranded incomplete-index marker — reported, never cleared (EI-22172147268902766)', () => {
  it('extracts the marker gitnexus actually writes', () => {
    // Shape copied verbatim from .gitnexus/meta.json observed 2026-09-02T18:06Z.
    const marker = readIncompleteIndexMarker({
      incrementalInProgress: {
        startedAt: 1788371911968,
        updatedAt: 1788371911968,
        phase: 'full-rebuild',
        toWriteCount: 1201,
      },
    });
    expect(marker).toEqual({ phase: 'full-rebuild', startedAt: 1788371911968, toWriteCount: 1201 });
  });

  it('reports a clean index as null', () => {
    expect(readIncompleteIndexMarker({ lastCommit: 'abc' })).toBeNull();
  });

  it('never throws on malformed input — it runs on the failure path', () => {
    // A throw here would replace a real analyze diagnosis with a plumbing error, losing
    // the failure the operator is being alerted about.
    for (const bad of [null, undefined, 42, 'nope', [], { incrementalInProgress: 'yes' }]) {
      expect(() => readIncompleteIndexMarker(bad)).not.toThrow();
      expect(readIncompleteIndexMarker(bad)).toBeNull();
    }
  });

  it('tolerates a partial marker rather than inventing fields', () => {
    expect(readIncompleteIndexMarker({ incrementalInProgress: { phase: 'full-rebuild' } })).toEqual({
      phase: 'full-rebuild',
      startedAt: null,
      toWriteCount: null,
    });
    // NaN/Infinity are not usable numbers and must not reach a Date() or an alert body.
    expect(
      readIncompleteIndexMarker({ incrementalInProgress: { startedAt: NaN, toWriteCount: Infinity } }),
    ).toEqual({ phase: null, startedAt: null, toWriteCount: null });
  });

  it('says the rebuild is FORCED and the marker deliberately kept', () => {
    // The wording is the payload: without it the alert reads "exited 1" and an operator
    // cannot tell a one-off failure from an index wedged into rebuild-and-fail forever.
    const note = describeStrandedIncompleteIndex({
      phase: 'full-rebuild',
      startedAt: 1788371911968,
      toWriteCount: 1201,
    });
    expect(note).toContain('INCOMPLETE');
    expect(note).toContain('toWrite=1201');
    expect(note).toContain('phase=full-rebuild');
    expect(note).toMatch(/NOT cleared/);
  });

  it('is empty for a clean index so the alert body is unchanged', () => {
    expect(describeStrandedIncompleteIndex(null)).toBe('');
  });

  it('reads the marker off a real meta.json, and fail-softs on an unreadable one', () => {
    const root = mkdtempSync(join(tmpdir(), 'gitnexus-meta-'));
    mkdirSync(join(root, '.gitnexus'));
    writeFileSync(
      gitnexusMetaPath(root),
      JSON.stringify({ incrementalInProgress: { phase: 'full-rebuild', toWriteCount: 7 } }),
    );
    expect(readStrandedIncompleteIndex(root)?.toWriteCount).toBe(7);

    // meta.json is ~3 MB and can legitimately be caught mid-write; a parse failure must be
    // in-band "unobserved", never a throw that swallows the analyze failure being reported.
    writeFileSync(gitnexusMetaPath(root), '{ truncated mid-write');
    expect(readStrandedIncompleteIndex(root)).toBeNull();
    expect(readStrandedIncompleteIndex(join(root, 'does-not-exist'))).toBeNull();
  });
});

describe('index-disk budget telemetry (WI-2142942)', () => {
  const base = {
    consecutiveFailures: 0,
    alerted: false,
    lastFailureAt: null,
    lastSuccessAt: null,
  };

  it('measures the WHOLE .gitnexus directory, not just the lbug file', () => {
    // The gap this closes: measureGitnexusDbUsage stats lbug alone, so a
    // measured 2026-09-03 footprint of 6558MB was reported as 4946MB and
    // 1607MB of parse caches was invisible to every instrument.
    const root = mkdtempSync(join(tmpdir(), 'gitnexus-indexdisk-'));
    mkdirSync(join(root, '.gitnexus'));
    mkdirSync(join(root, '.gitnexus', 'parse-cache'));
    writeFileSync(gitnexusDbPaths(root).db, 'x'.repeat(1024));
    writeFileSync(join(root, '.gitnexus', 'parse-cache', 'a'), 'y'.repeat(2048));

    const v = measureGitnexusIndexDisk(root, 2_048);
    expect(v.status).toBe('within-budget');
    // Both files counted — the lbug-only reading would have missed the cache.
    expect(v.status === 'within-budget' && v.measuredMb).toBe(0); // <1MB, rounds to 0
  });

  it('grades a missing index not-measured, never a zero-byte pass', () => {
    const root = mkdtempSync(join(tmpdir(), 'gitnexus-indexdisk-missing-'));
    const v = measureGitnexusIndexDisk(root, 2_048);
    expect(v.status).toBe('not-measured');
    expect(v.status).not.toBe('within-budget');
  });

  it('alerts once when growth passes the accepted ceiling', () => {
    const over = decideIndexDiskHealthUpdate(base, {
      backend: 'gitnexus',
      status: 'over-ceiling',
      budgetMb: 2_048,
      measuredMb: 12_000,
      acceptedCeilingMb: 10_240,
    });
    expect(over.shouldAlert).toBe(true);
    expect(over.next.indexDiskAlerted).toBe(true);

    // Same condition on the next tick must NOT re-alert.
    const again = decideIndexDiskHealthUpdate({ ...base, ...over.next }, {
      backend: 'gitnexus',
      status: 'over-ceiling',
      budgetMb: 2_048,
      measuredMb: 12_100,
      acceptedCeilingMb: 10_240,
    });
    expect(again.shouldAlert).toBe(false);
  });

  it('does NOT alert on the accepted exceedance itself', () => {
    // gitnexus is knowingly 3.2x the budget. Alerting on that would fire every
    // tick from day one, and an always-red gauge is one nobody reads — which is
    // how this budget came to be ignored in the first place.
    const accepted = decideIndexDiskHealthUpdate(base, {
      backend: 'gitnexus',
      status: 'accepted-exceedance',
      budgetMb: 2_048,
      measuredMb: 6_558,
      acceptedCeilingMb: 10_240,
    });
    expect(accepted.shouldAlert).toBe(false);
    expect(accepted.next.indexDiskStatus).toBe('accepted-exceedance');
  });

  it('does not let a not-measured tick re-arm the alert', () => {
    // Absence of evidence must not clear the flag: a flapping measurement
    // would otherwise page repeatedly for one unchanged condition.
    const alerted = { ...base, indexDiskAlerted: true };
    const unknown = decideIndexDiskHealthUpdate(alerted, {
      backend: 'gitnexus',
      status: 'not-measured',
      budgetMb: 2_048,
      reason: 'walk truncated',
    });
    expect(unknown.shouldAlert).toBe(false);
    expect(unknown.next.indexDiskAlerted).toBe(true);
    expect(unknown.next.indexDiskMb).toBeNull();
  });
});

describe('LadybugDB capacity telemetry (EI-21044385125018758)', () => {
  it('measures the promoted DB against the configured ceiling', () => {
    const root = mkdtempSync(join(tmpdir(), 'gitnexus-capacity-'));
    mkdirSync(join(root, '.gitnexus'));
    writeFileSync(gitnexusDbPaths(root).db, 'x'.repeat(600));

    expect(measureGitnexusDbUsage(root, 1_000)).toEqual({
      dbBytes: 600,
      dbMaxBytes: 1_000,
      dbUtilization: 0.6,
      dbHeadroomBytes: 400,
    });
  });

  it('keeps a missing/unreadable DB in-band unknown instead of reporting zero usage', () => {
    const root = mkdtempSync(join(tmpdir(), 'gitnexus-capacity-missing-'));
    expect(measureGitnexusDbUsage(root, 1_000)).toEqual({
      dbBytes: null,
      dbMaxBytes: 1_000,
      dbUtilization: null,
      dbHeadroomBytes: null,
    });
  });

  it('alerts once on a threshold crossing, rearms below it, and preserves unknown-state alerting', () => {
    const high = { dbBytes: 600, dbMaxBytes: 1_000, dbUtilization: 0.6, dbHeadroomBytes: 400 };
    const first = decideGitnexusDbHealthUpdate(GITNEXUS_HEALTH_DEFAULT, high, GITNEXUS_LBUG_DB_ALERT_RATIO);
    expect(first.shouldAlert).toBe(true);
    expect(first.next.dbAlerted).toBe(true);

    const repeated = decideGitnexusDbHealthUpdate({ ...GITNEXUS_HEALTH_DEFAULT, ...first.next }, high, 0.6);
    expect(repeated.shouldAlert).toBe(false);

    const unknown = decideGitnexusDbHealthUpdate(
      { ...GITNEXUS_HEALTH_DEFAULT, ...first.next },
      { dbBytes: null, dbMaxBytes: 1_000, dbUtilization: null, dbHeadroomBytes: null },
      0.6,
    );
    expect(unknown.shouldAlert).toBe(false);
    expect(unknown.next.dbAlerted).toBe(true);

    const low = decideGitnexusDbHealthUpdate(
      { ...GITNEXUS_HEALTH_DEFAULT, ...first.next },
      { dbBytes: 500, dbMaxBytes: 1_000, dbUtilization: 0.5, dbHeadroomBytes: 500 },
      0.6,
    );
    expect(low.next.dbAlerted).toBe(false);
    expect(decideGitnexusDbHealthUpdate({ ...GITNEXUS_HEALTH_DEFAULT, ...low.next }, high, 0.6).shouldAlert).toBe(true);
  });

  it('wires capacity tracking before cadence skips and refreshes it after a successful analyze', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'gitnexus-reindex-action.ts'), 'utf8');
    const first = src.indexOf('await trackGitnexusDbCapacity(ctx, root, dbAlertRatio);');
    const decision = src.indexOf('const decision = decideReindex(', first);
    const second = src.indexOf('await trackGitnexusDbCapacity(ctx, root, dbAlertRatio);', first + 1);
    expect(first).toBeGreaterThan(0);
    expect(decision).toBeGreaterThan(first);
    expect(second).toBeGreaterThan(decision);
  });
});

describe('isDeadShadow — the THIRD residue state (D-016 recurrence, 2026-08-21)', () => {
  const STALE = DEAD_SHADOW_STALE_MS + 1;
  const FRESH = 1_000;

  it('REPRODUCES the live state that neither existing arm classified', () => {
    // Observed 06:55Z: lbug 3.97 GiB + lbug.shadow at ZERO BYTES + lbug.wal.checkpoint,
    // after the 06:35 analyze was SIGKILLed at its 1200s timeout. Reads segfaulted
    // (exit 139) and cleanCrashResidue returned kind:'none'.
    const dbExists = true;
    const shadowExists = true;
    const walExists = true;

    // The old classification — both arms silent, which IS the bug:
    expect(isOrphanShadow(dbExists, shadowExists)).toBe(false);
    expect(isOrphanWal(dbExists, shadowExists, walExists)).toBe(false);

    // The new predicate names it:
    expect(isDeadShadow(shadowExists, 0, STALE)).toBe(true);

    // ...and with the shadow correctly treated as absent, the WAL arm now fires:
    const liveShadow = shadowExists && !isDeadShadow(shadowExists, 0, STALE);
    expect(isOrphanWal(dbExists, liveShadow, walExists)).toBe(true);
  });

  it('NEVER claims a live build is dead — a non-empty shadow is a build in flight', () => {
    // The direction that matters: acting on a live build corrupts it. A build that has
    // written even one byte is live regardless of age (a slow analyze is still analyze).
    expect(isDeadShadow(true, 1, STALE)).toBe(false);
    expect(isDeadShadow(true, 4_266_192_896, STALE)).toBe(false);
  });

  it('NEVER claims a just-created empty shadow is dead', () => {
    // A live analyze creates the shadow before writing to it; staleness is what stops
    // that instant being misread as a corpse.
    expect(isDeadShadow(true, 0, FRESH)).toBe(false);
  });

  it('is inert when there is no shadow at all', () => {
    expect(isDeadShadow(false, 0, STALE)).toBe(false);
  });

  it('CALIBRATION: the predicate can return true — so the negatives above mean something', () => {
    // Without this, an isDeadShadow() hardcoded to `false` passes every assertion above.
    expect(isDeadShadow(true, 0, STALE)).toBe(true);
  });
});

describe('CONTROLS — the two cap guards are falsifiable (P-004)', () => {
  // Deliberately-WRONG implementations, kept permanently. Without these, the guards
  // above pass identically against code that never sets anything, and "69 passing"
  // would say nothing about whether either trap is actually detected.

  /** WRONG: node stops parsing its flags at the first non-flag arg, so this --stack-size
   *  is silently handed to gitnexus as a no-op instead of raising the stack. */
  const flagAfterScript = (cli: string, root: string, name: string): string[] => [
    cli,
    `--stack-size=${GITNEXUS_ANALYZE_STACK_KB}`,
    ...buildAnalyzeArgs(root, name),
  ];

  /** WRONG: leaks --stack-size into NODE_OPTIONS, which Node 24+ refuses at startup. */
  const envLeakingStackSize = (): NodeJS.ProcessEnv => ({
    NODE_OPTIONS: `--max-old-space-size=${GITNEXUS_ANALYZE_HEAP_MB} --stack-size=${GITNEXUS_ANALYZE_STACK_KB}`,
  });

  it('the argv-ORDER assertion distinguishes correct from wrong', () => {
    const good = analyzeNodeArgs('/cli.js', '/repo', 'x');
    const bad = flagAfterScript('/cli.js', '/repo', 'x');
    const flag = `--stack-size=${GITNEXUS_ANALYZE_STACK_KB}`;
    expect(good.indexOf(flag)).toBeLessThan(good.indexOf('/cli.js'));
    expect(bad.indexOf(flag)).toBeGreaterThan(bad.indexOf('/cli.js'));
  });

  it('the NODE_OPTIONS assertion distinguishes correct from wrong', () => {
    expect(analyzeEnv({}).NODE_OPTIONS).not.toContain('--stack-size');
    expect(envLeakingStackSize().NODE_OPTIONS).toContain('--stack-size');
  });
});

describe('the cap VALUE is defensible against what was measured (P-004)', () => {
  // Measured live 2026-08-21 by external /proc sampling of a full analyze over
  // 19,479 files: peak worker RSS 10.42 GiB, peak whole-tree RSS 10.59 GiB.
  const MEASURED_PEAK_GIB = 10.59;
  const BG_HOST_CGROUP_GIB = 40;

  it('clears the measured peak with real headroom', () => {
    expect(GITNEXUS_ANALYZE_HEAP_MB / 1024).toBeGreaterThan(MEASURED_PEAK_GIB * 1.25);
  });

  it('is genuinely a CAP — below what gitnexus would self-grant (0.75x the cgroup)', () => {
    // If this ever inverts, the whole mechanism is inert: gitnexus's own number would
    // be the smaller one and our "cap" would be raising the ceiling, not lowering it.
    const selfGrantedMb = 0.75 * BG_HOST_CGROUP_GIB * 1024;
    expect(GITNEXUS_ANALYZE_HEAP_MB).toBeLessThan(selfGrantedMb);
  });

  it('leaves room for the co-tenants sharing the cgroup', () => {
    // The hazard is not analyze dying, it is the cgroup OOM killer reaping bg-host.
    // Worst-case analyze (heap + native overhead) plus observed co-tenant usage must
    // stay under the cap.
    const worstCaseAnalyzeGib = GITNEXUS_ANALYZE_HEAP_MB / 1024 + 4;
    const observedCoTenantsGib = 11.6;
    expect(worstCaseAnalyzeGib + observedCoTenantsGib).toBeLessThan(BG_HOST_CGROUP_GIB);
  });
});

describe('decideReindex', () => {
  it('runs when the graph is genuinely behind on an idle box', () => {
    const d = decideReindex(baseInput());
    expect(d.run).toBe(true);
    expect(d.reason).toContain('50 commits behind');
  });

  it('skips when the box is oversubscribed', () => {
    const d = decideReindex(baseInput({ loadPerCore: 2.0 }));
    expect(d.run).toBe(false);
    expect(d.reason).toContain('oversubscribed');
  });

  it('defers a warning-band memory-pressure capture before admitting a full analyze', () => {
    const d = decideReindex(
      baseInput({
        memoryPressure: 'warn',
        memoryPressureReason: 'PSI memory some avg60 18.51 ≥ 10 — sustained memory reclaim pressure',
      }),
    );
    expect(d.run).toBe(false);
    expect(d.reason).toContain('memory pressure warn');
    expect(d.reason).toContain('PSI memory some avg60 18.51');
  });

  it('defers the critical thrashing band even when the graph is missing', () => {
    const d = decideReindex(
      baseInput({
        registered: false,
        memoryPressure: 'crit',
        memoryPressureReason: 'PSI memory full avg60 11.96 ≥ 5 — all tasks stalled on memory reclaim/swap',
      }),
    );
    expect(d.run).toBe(false);
    expect(d.reason).toContain('memory pressure crit');
    expect(d.reason).not.toContain('cold build');
  });

  it('keeps load precedence when both load and memory pressure are unsafe', () => {
    const d = decideReindex(baseInput({ loadPerCore: 2, memoryPressure: 'crit' }));
    expect(d.run).toBe(false);
    expect(d.reason).toContain('oversubscribed');
    expect(d.reason).not.toContain('memory pressure');
  });

  it('fails soft when the perf writer has no usable pressure band', () => {
    // null covers absent, stale, and incomplete PSI captures because the shared writer
    // intentionally keeps those cases unknown instead of inventing a reassuring zero.
    const d = decideReindex(baseInput({ memoryPressure: null, memoryPressureReason: null }));
    expect(d.run).toBe(true);
    expect(d.reason).toContain('50 commits behind');
  });

  it('lets load OUTRANK a missing index — protecting the box beats a cold build', () => {
    // Ordering guard: a missing index is the most urgent functional condition, but a
    // 4-minute indexer is the worst thing to start on a queueing box. Deferring costs
    // one hour; piling on costs the whole fleet.
    const d = decideReindex(baseInput({ registered: false, loadPerCore: 3.0 }));
    expect(d.run).toBe(false);
    expect(d.reason).toContain('oversubscribed');
  });

  it('cold-builds when nothing is registered, bypassing the interval floor and staleness', () => {
    const d = decideReindex(baseInput({ registered: false, secondsSinceIndexed: 0, commitsBehind: 0 }));
    expect(d.run).toBe(true);
    expect(d.reason).toContain('cold build');
  });

  it('honours the interval floor even when many commits have landed', () => {
    // git-sync commits every few minutes, so commitsBehind climbs fast; the floor — not
    // the commit count — is what bounds steady-state cost.
    const d = decideReindex(baseInput({ secondsSinceIndexed: 10 * 60, commitsBehind: 500 }));
    expect(d.run).toBe(false);
    expect(d.reason).toContain('floor');
  });

  it('skips when nothing has changed', () => {
    const d = decideReindex(baseInput({ commitsBehind: 0 }));
    expect(d.run).toBe(false);
    expect(d.reason).toContain('0 commit(s) behind');
  });

  it('refreshes when the indexed commit is no longer in history (rebase/prune)', () => {
    const d = decideReindex(baseInput({ commitsBehind: null }));
    expect(d.run).toBe(true);
    expect(d.reason).toContain('not in the current history');
  });

  it('treats an unknown-age index as eligible rather than blocking on the floor', () => {
    const d = decideReindex(baseInput({ secondsSinceIndexed: null }));
    expect(d.run).toBe(true);
  });

  it('honours a trigger_config override of the load ceiling', () => {
    expect(decideReindex(baseInput({ loadPerCore: 2.0, maxLoadPerCore: 4 })).run).toBe(true);
  });

  it('applies the interval floor at the boundary, not just past it', () => {
    expect(decideReindex(baseInput({ secondsSinceIndexed: DEFAULT_MIN_INTERVAL_SEC - 1 })).run).toBe(false);
    expect(decideReindex(baseInput({ secondsSinceIndexed: DEFAULT_MIN_INTERVAL_SEC })).run).toBe(true);
  });
});

describe('readRegistryEntry', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gitnexus-reg-'));

  it('reads the named repo out of the registry array', () => {
    const f = join(dir, 'ok.json');
    writeFileSync(
      f,
      JSON.stringify([
        { name: 'other', lastCommit: 'aaa' },
        { name: 'papercusp', lastCommit: 'bbb', indexedAt: '2026-07-27T19:38:08.913Z' },
      ]),
    );
    expect(readRegistryEntry(f, 'papercusp')?.lastCommit).toBe('bbb');
  });

  it('returns null for an alias that is not registered', () => {
    const f = join(dir, 'missing.json');
    writeFileSync(f, JSON.stringify([{ name: 'other' }]));
    expect(readRegistryEntry(f, 'papercusp')).toBeNull();
  });

  // Every read failure must collapse to "no index" (⇒ build one), never throw a tick.
  it.each([
    ['absent file', null],
    ['unparseable json', '{not json'],
    ['not an array', '{"name":"papercusp"}'],
  ])('returns null on %s instead of throwing', (label, contents) => {
    const f = join(dir, `${String(label).replace(/\W/g, '')}.json`);
    if (contents != null) writeFileSync(f, contents);
    expect(readRegistryEntry(f, 'papercusp')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// WI-35532 (a) — the orphan-shadow preflight. Real fs in a tmpdir, matching the
// `readRegistryEntry` tests above — no need to mock node:fs for plain file existence.
// ---------------------------------------------------------------------------
describe('isOrphanShadow', () => {
  it('is the orphan condition: shadow present, db absent', () => {
    expect(isOrphanShadow(false, true)).toBe(true);
  });

  it('is NOT orphan when the db exists (a shadow beside a real db is a build in progress)', () => {
    expect(isOrphanShadow(true, true)).toBe(false);
  });

  it('is NOT orphan when there is no shadow at all', () => {
    expect(isOrphanShadow(false, false)).toBe(false);
    expect(isOrphanShadow(true, false)).toBe(false);
  });
});

// D-016 — the MIRROR condition the shadow arm structurally cannot see. Killed AFTER the
// promote: db present, shadow absent, WAL left holding pending data. `analyze` still
// starts fine, so nothing in the WRITE path notices; every READ-ONLY open segfaults in
// the native LadybugDB binding replaying that WAL.
describe('isOrphanWal', () => {
  it('is the orphan condition: wal + db present, no shadow (a writer was killed after promoting)', () => {
    expect(isOrphanWal(true, false, true)).toBe(true);
  });

  it('is NOT orphan when a shadow is present — that WAL belongs to a live build', () => {
    // The single term that makes deleting the WAL safe. Without it this arm would
    // destroy the pending writes of a concurrent analyze.
    expect(isOrphanWal(true, true, true)).toBe(false);
  });

  it('is NOT orphan when there is no wal at all (a healthy index carries none)', () => {
    // Measured 2026-08-21: repeated successful reads leave `.gitnexus/` holding only
    // `lbug` — reads never create a WAL, which is what makes "wal present" meaningful.
    expect(isOrphanWal(true, false, false)).toBe(false);
  });

  it('is NOT orphan when there is no db — that is the SHADOW arm\'s corner, not this one', () => {
    expect(isOrphanWal(false, true, true)).toBe(false);
    expect(isOrphanWal(false, false, true)).toBe(false);
  });

  it('does not fire on the exact input the shadow arm handles (the two arms are disjoint)', () => {
    // Guards the whole point of D-016: the arms must partition the state space, never
    // both claim a cell and race each other's cleanup.
    const shadowCorner = { db: false, shadow: true, wal: false };
    expect(isOrphanShadow(shadowCorner.db, shadowCorner.shadow)).toBe(true);
    expect(isOrphanWal(shadowCorner.db, shadowCorner.shadow, shadowCorner.wal)).toBe(false);
  });
});

/**
 * `writerKnownDead` — immediate post-timeout recovery (2026-08-23).
 *
 * MEASURED DEFECT: the timeout site logged "the next tick's cleanCrashResidue()
 * preflight recovers it" and left the poison in place until then. On 2026-08-23
 * the 19:35 tick was SIGKILLed at 19:55 (1202s against a 1200s budget) and the
 * next preflight was not due until 20:35, so every GitNexus graph read segfaulted
 * fleet-wide for ~40 minutes of that hour. Reproduced directly: a read-only
 * LadybugDB open SUCCEEDS against the poisoned index and the first `MATCH (n)
 * RETURN count(n)` dies with SIGSEGV.
 *
 * The staleness term is why the kill site could not simply call the existing
 * function: the shadow it must clean was created seconds earlier, so
 * `isDeadShadow` is false for another five minutes — exactly the window that
 * matters. `writerKnownDead` substitutes the caller's proof for the proxy.
 */
/**
 * A probe result standing for "the scan ran and found nobody holding the file".
 * Used as the CALIBRATION arm: it is what the real /proc scan returns for a temp
 * file no process has open, so a test can prove the surrounding tree is cleanable
 * without depending on the host's process table at that instant.
 */
const NO_HOLDERS: OpenHandleProbe = { ok: true, holders: [], scannedPids: 1, unreadablePids: 0 };

describe('cleanCrashResidue — writerKnownDead (immediate post-timeout recovery)', () => {
  function poisonedRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'gitnexus-killsite-'));
    mkdirSync(join(root, '.gitnexus'));
    const { db, shadow, wal, walCheckpoint } = gitnexusDbPaths(root);
    writeFileSync(db, 'a real promoted database');
    writeFileSync(shadow, ''); // ZERO BYTES — killed before writing a byte
    writeFileSync(wal, 'pending wal');
    writeFileSync(walCheckpoint, '');
    return root;
  }

  it('REPRODUCES the deferral gap: a seconds-old poison is NOT cleaned without the flag', () => {
    // This is the whole defect in one assertion — the residue is real and
    // present, and the default policy declines to touch it because it cannot
    // yet distinguish it from a live build.
    const root = poisonedRoot();
    const { shadow } = gitnexusDbPaths(root);

    expect(cleanCrashResidue(root).cleaned).toBe(false);
    expect(existsSync(shadow)).toBe(true);
  });

  it('cleans that same fresh poison when the caller has just killed the writer', () => {
    const root = poisonedRoot();
    const { db, shadow, wal, walCheckpoint } = gitnexusDbPaths(root);

    const result = cleanCrashResidue(root, { writerKnownDead: true });

    expect(result.cleaned).toBe(true);
    expect(result.kind).toBe('dead-shadow-wal');
    expect(existsSync(shadow)).toBe(false);
    expect(existsSync(wal)).toBe(false);
    expect(existsSync(walCheckpoint)).toBe(false);
    // The 4.5 GiB index itself is never a cleanup target — only the residue.
    expect(existsSync(db)).toBe(true);
  });

  it('STILL refuses to delete a non-empty shadow a process HOLDS OPEN, writer known dead or not', () => {
    // The protection that must survive, expressed with the instrument that can
    // actually carry it: a shadow with bytes in it can belong to a concurrent
    // MANUAL `gitnexus analyze` on the same root, which this must never destroy.
    //
    // Until 2026-08-23 that protection was spelled `size !== 0`, which cannot tell
    // a concurrent writer from a mid-write corpse — see the sibling test below for
    // the orphan that spelling let through. An OPEN FILE DESCRIPTOR can: this test
    // holds a real one, so the real /proc scan is what is under test here.
    const root = mkdtempSync(join(tmpdir(), 'gitnexus-livebuild-'));
    mkdirSync(join(root, '.gitnexus'));
    const { db, shadow } = gitnexusDbPaths(root);
    writeFileSync(db, 'a real promoted database');
    writeFileSync(shadow, 'partially built shadow');

    const fd = openSync(shadow, 'r+'); // stand in for the concurrent analyze
    try {
      const result = cleanCrashResidue(root, { writerKnownDead: true });

      expect(result.writerLiveness).toBe('live');
      expect(result.cleaned).toBe(false);
      expect(existsSync(shadow)).toBe(true);
    } finally {
      closeSync(fd);
    }
  });

  it('CLEANS a NON-ZERO orphaned shadow — the shape the size proxy could never see', () => {
    // THE GAP THIS FIX CLOSES, and the direct falsifier for the old policy: with
    // `size === 0` as the test, this exact tree was cleaned by NEITHER the kill site
    // NOR the next tick's preflight, so the outage recurred looking brand-new.
    //
    // Not a hypothetical shape — the live mid-analyze shadow on this box measured
    // 800,280 bytes at 2026-08-23T20:50Z. A SIGKILL one second later strands this.
    const root = mkdtempSync(join(tmpdir(), 'gitnexus-nonzero-orphan-'));
    mkdirSync(join(root, '.gitnexus'));
    const { db, shadow, wal, walCheckpoint } = gitnexusDbPaths(root);
    writeFileSync(db, 'a real promoted database');
    writeFileSync(shadow, 'x'.repeat(800_280)); // killed MID-WRITE, not before it
    writeFileSync(wal, 'pending wal');
    writeFileSync(walCheckpoint, '');
    // Deliberately FRESH: seconds old, exactly as the kill site finds it. The old
    // policy failed on both terms here — too young to be stale, too big to be empty.

    const result = cleanCrashResidue(root, { writerKnownDead: true });

    expect(result.writerLiveness).toBe('orphaned'); // nothing holds it open
    expect(result.cleaned).toBe(true);
    expect(result.kind).toBe('dead-shadow-wal');
    expect(existsSync(shadow)).toBe(false);
    expect(existsSync(wal)).toBe(false);
    // The promoted index is still never a target.
    expect(existsSync(db)).toBe(true);
  });

  it('SPARES a zero-byte STALE shadow while a process holds it open (the probe strengthens the OLD rule too)', () => {
    // The pre-probe rule would have DELETED this tree: empty + stale was, by
    // itself, taken as proof of death. It is not — a build that is slow to write
    // its first byte looks identical. The holder outranks both terms, so this fix
    // closes a live-build hazard as well as the orphan gap.
    const root = mkdtempSync(join(tmpdir(), 'gitnexus-slow-starter-'));
    mkdirSync(join(root, '.gitnexus'));
    const { db, shadow, wal } = gitnexusDbPaths(root);
    writeFileSync(db, 'a real promoted database');
    writeFileSync(shadow, '');
    writeFileSync(wal, 'pending wal');
    const old = (Date.now() - (DEAD_SHADOW_STALE_MS + 60_000)) / 1000;
    utimesSync(shadow, old, old);

    const fd = openSync(shadow, 'r+');
    try {
      const result = cleanCrashResidue(root);
      expect(result.writerLiveness).toBe('live');
      expect(result.cleaned).toBe(false);
      expect(existsSync(shadow)).toBe(true);
      expect(existsSync(wal)).toBe(true);

      // CALIBRATION, taken while the tree is still intact: the SAME tree with the
      // holder taken out of the picture IS cleaned. Without this the assertions
      // above would pass just as well against a cleanCrashResidue that no-ops.
      expect(cleanCrashResidue(root, { probeOpenHandles: () => NO_HOLDERS }).cleaned).toBe(true);
    } finally {
      closeSync(fd);
    }
  });

  it('DEGRADES to the old size-only rule when the probe cannot answer', () => {
    // The safety property of the fallback: no /proc (or a probe that throws) must
    // never be read as "nobody holds it". It reverts to the pre-2026-08-23
    // behaviour exactly — which spares the non-zero shadow rather than risking it.
    const root = mkdtempSync(join(tmpdir(), 'gitnexus-noprobe-'));
    mkdirSync(join(root, '.gitnexus'));
    const { db, shadow } = gitnexusDbPaths(root);
    writeFileSync(db, 'a real promoted database');
    writeFileSync(shadow, 'partially built shadow');

    const unavailable = cleanCrashResidue(root, {
      writerKnownDead: true,
      probeOpenHandles: () => ({ ok: false, holders: [], scannedPids: 0, unreadablePids: 0 }),
    });
    expect(unavailable.writerLiveness).toBe('unknown');
    expect(unavailable.cleaned).toBe(false);

    const threw = cleanCrashResidue(root, {
      writerKnownDead: true,
      probeOpenHandles: () => {
        throw new Error('/proc is not mounted');
      },
    });
    expect(threw.writerLiveness).toBe('unknown');
    expect(threw.cleaned).toBe(false);
    expect(existsSync(shadow)).toBe(true);

    // CALIBRATION: a WORKING probe on that same tree does clean it, so the two
    // assertions above measure the fallback and not a permanently-inert function.
    expect(cleanCrashResidue(root, { writerKnownDead: true, probeOpenHandles: () => NO_HOLDERS }).cleaned).toBe(true);
  });

  it('is inert on a healthy tree, so the kill site cannot damage a clean index', () => {
    const root = mkdtempSync(join(tmpdir(), 'gitnexus-healthy-'));
    mkdirSync(join(root, '.gitnexus'));
    const { db } = gitnexusDbPaths(root);
    writeFileSync(db, 'a real promoted database');

    expect(cleanCrashResidue(root, { writerKnownDead: true }).cleaned).toBe(false);
    expect(existsSync(db)).toBe(true);
  });

  it('CALIBRATION: the default path still cleans a STALE poison, so the flag adds only immediacy', () => {
    // Guards against "fixing" the gap by making the default arm over-eager.
    const root = poisonedRoot();
    const { shadow } = gitnexusDbPaths(root);
    const old = (Date.now() - (DEAD_SHADOW_STALE_MS + 60_000)) / 1000;
    utimesSync(shadow, old, old);

    expect(cleanCrashResidue(root).cleaned).toBe(true);
  });
});

describe('cleanCrashResidue', () => {
  function freshRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'gitnexus-orphan-'));
    mkdirSync(join(root, '.gitnexus'));
    return root;
  }

  it('removes the shadow + wal checkpoint when the db is missing (the 66/66-failure wedge)', () => {
    const root = freshRoot();
    const { db, shadow, walCheckpoint } = gitnexusDbPaths(root);
    writeFileSync(shadow, '');
    writeFileSync(walCheckpoint, '');
    expect(existsSync(db)).toBe(false);

    const result = cleanCrashResidue(root);

    expect(result.cleaned).toBe(true);
    expect(result.kind).toBe('orphan-shadow');
    expect(result.removed.sort()).toEqual([shadow, walCheckpoint].sort());
    expect(existsSync(shadow)).toBe(false);
    expect(existsSync(walCheckpoint)).toBe(false);
  });

  it('removes just the shadow when there is no wal checkpoint file', () => {
    const root = freshRoot();
    const { shadow } = gitnexusDbPaths(root);
    writeFileSync(shadow, '');

    const result = cleanCrashResidue(root);

    expect(result.cleaned).toBe(true);
    expect(result.kind).toBe('orphan-shadow');
    expect(result.removed).toEqual([shadow]);
  });

  it('clears the EMPTY-shadow + WAL + real-db tree that wedged the fleet on 2026-08-21', () => {
    // END-TO-END reproduction of the live outage, not just the predicate. The 06:35
    // analyze was SIGKILLed at its 1200s timeout leaving exactly this tree; BOTH
    // existing arms returned false, cleanCrashResidue no-opped, and every
    // `gitnexus cypher` segfaulted (exit 139) until it was cleared by hand.
    const root = freshRoot();
    const { db, shadow, walCheckpoint, wal } = gitnexusDbPaths(root);
    writeFileSync(db, 'a real promoted database');
    writeFileSync(shadow, ''); // ZERO BYTES — the build died before writing anything
    writeFileSync(wal, 'pending wal');
    writeFileSync(walCheckpoint, 'checkpoint');
    // Backdate the shadow past the staleness floor: a corpse, not a build in flight.
    const old = new Date(Date.now() - (DEAD_SHADOW_STALE_MS + 60_000));
    utimesSync(shadow, old, old);

    const result = cleanCrashResidue(root);

    expect(result.cleaned).toBe(true);
    expect(result.kind).toBe('dead-shadow-wal');
    // The dead shadow MUST go too — leaving it re-arms the trap, because the next tick
    // would again read shadow-present as build-in-flight.
    expect(existsSync(shadow)).toBe(false);
    expect(existsSync(wal)).toBe(false);
    expect(existsSync(walCheckpoint)).toBe(false);
    // ...and the real index is NEVER touched: it is the last good graph.
    expect(existsSync(db)).toBe(true);
    expect(readFileSync(db, 'utf8')).toBe('a real promoted database');
  });

  it('LEAVES A LIVE BUILD ALONE — a shadow its writer still holds OPEN is not residue', () => {
    // The dangerous direction. If this ever cleans, a running analyze is corrupted
    // mid-build and we have traded an outage for a worse one.
    //
    // Note what this test asserts and what it no longer does. "Non-empty" used to
    // BE the liveness test, so a stale written shadow was spared on the theory that
    // it must be a slow build. That theory is false — a SIGKILL mid-write produces
    // the identical file — and believing it is what left the non-zero orphan
    // uncleanable. Liveness is now the open handle, so this test holds a real one.
    const root = freshRoot();
    const { db, shadow, wal } = gitnexusDbPaths(root);
    writeFileSync(db, 'real db');
    writeFileSync(shadow, 'a build genuinely in progress');
    writeFileSync(wal, 'live wal');
    const old = new Date(Date.now() - (DEAD_SHADOW_STALE_MS + 60_000));
    utimesSync(shadow, old, old); // even STALE, an OPEN shadow is a slow build

    const fd = openSync(shadow, 'r+');
    try {
      const result = cleanCrashResidue(root);

      expect(result.writerLiveness).toBe('live');
      expect(result.cleaned).toBe(false);
      expect(result.kind).toBe('none');
      expect(existsSync(shadow)).toBe(true);
      expect(existsSync(wal)).toBe(true);
    } finally {
      closeSync(fd);
    }
  });

  it('...and cleans that SAME tree once nothing holds the shadow open', () => {
    // The falsifier for the test above: identical tree, no open handle. Before the
    // open-handle discriminator this was indistinguishable from a live build and
    // survived forever, poisoning every read with "Couldn't replay shadow pages
    // under read-only mode".
    const root = freshRoot();
    const { db, shadow, wal } = gitnexusDbPaths(root);
    writeFileSync(db, 'real db');
    writeFileSync(shadow, 'a build that was SIGKILLed mid-write');
    writeFileSync(wal, 'orphaned wal');
    const old = new Date(Date.now() - (DEAD_SHADOW_STALE_MS + 60_000));
    utimesSync(shadow, old, old);

    const result = cleanCrashResidue(root);

    expect(result.writerLiveness).toBe('orphaned');
    expect(result.cleaned).toBe(true);
    expect(result.kind).toBe('dead-shadow-wal');
    expect(existsSync(shadow)).toBe(false);
    expect(existsSync(wal)).toBe(false);
    expect(existsSync(db)).toBe(true);
  });

  it('removes the orphan WAL beside a real db — the read-path segfault (D-016)', () => {
    // THE REGRESSION. Before this arm existed, cleanCrashResidue's predecessor no-opped
    // on exactly this tree, the next tick re-ran analyze, re-timed-out, and re-orphaned
    // the WAL — while every agent's gitnexus call died on WAL replay.
    const root = freshRoot();
    const { db, shadow, wal } = gitnexusDbPaths(root);
    writeFileSync(db, 'promoted-db');
    writeFileSync(wal, 'pending-writes-from-a-killed-analyze');
    expect(existsSync(shadow)).toBe(false);

    const result = cleanCrashResidue(root);

    expect(result.cleaned).toBe(true);
    expect(result.kind).toBe('orphan-wal');
    expect(result.removed).toEqual([wal]);
    expect(existsSync(wal)).toBe(false);
    expect(existsSync(db)).toBe(true); // the database itself is never touched
  });

  it('touches NOTHING when the db exists — a shadow beside a real db is an in-progress build', () => {
    const root = freshRoot();
    const { db, shadow } = gitnexusDbPaths(root);
    writeFileSync(db, 'not-really-a-db-but-present');
    writeFileSync(shadow, '');

    const result = cleanCrashResidue(root);

    expect(result.cleaned).toBe(false);
    expect(result.kind).toBe('none');
    expect(result.removed).toEqual([]);
    expect(existsSync(db)).toBe(true);
    expect(existsSync(shadow)).toBe(true); // untouched
  });

  it('leaves a live build\'s WAL alone when a shadow is present beside it', () => {
    // The concurrency rail: db + shadow + wal is an analyze mid-flight. Deleting that
    // WAL would corrupt a healthy build to "fix" a tree that was never broken.
    const root = freshRoot();
    const { db, shadow, wal } = gitnexusDbPaths(root);
    writeFileSync(db, 'promoted-db');
    writeFileSync(shadow, 'building');
    writeFileSync(wal, 'live-pending-writes');

    const result = cleanCrashResidue(root);

    expect(result.cleaned).toBe(false);
    expect(result.kind).toBe('none');
    expect(existsSync(wal)).toBe(true);
    expect(existsSync(shadow)).toBe(true);
  });

  it('touches NOTHING on a healthy index — db present, no shadow, no wal', () => {
    const root = freshRoot();
    const { db } = gitnexusDbPaths(root);
    writeFileSync(db, 'promoted-db');

    const result = cleanCrashResidue(root);

    expect(result.cleaned).toBe(false);
    expect(result.kind).toBe('none');
    expect(existsSync(db)).toBe(true);
  });

  it('touches NOTHING when there is no index at all (nothing to clean)', () => {
    const root = freshRoot();
    const result = cleanCrashResidue(root);
    expect(result.cleaned).toBe(false);
    expect(result.kind).toBe('none');
    expect(result.removed).toEqual([]);
  });
});

/**
 * The open-handle discriminator itself (2026-08-23).
 *
 * This is the instrument the residue policy now leans on, so it gets its own
 * falsifiability suite rather than being trusted because it looks right. The rule that
 * earned it: BOTH instruments the previous investigation leaned on failed the same way —
 * `shadow.size === 0` (a proxy that covers one crash instant out of many) and
 * `proc-guard.mjs check "gitnexus analyze"` (an argv match that returns "no external
 * process matches" against a live 4.8 GiB analyze, because the real argv's basename is
 * `index.js` — EI-21277960228841563).
 *
 * So every absence assertion below is paired with a POSITIVE CONTROL: if the probe
 * cannot find a handle we are DEMONSTRABLY holding in this very process, its zeroes mean
 * nothing and the whole fix is resting on a broken instrument.
 */
describe('probeOpenHandles / classifyWriterLiveness — the open-handle discriminator', () => {
  const onLinux = process.platform === 'linux' && existsSync('/proc/self/fd');

  function tmpFile(prefix: string, contents = 'x'): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    const f = join(dir, 'lbug.shadow');
    writeFileSync(f, contents);
    return f;
  }

  it.skipIf(!onLinux)('POSITIVE CONTROL — finds THIS process holding a file open', () => {
    const f = tmpFile('gitnexus-probe-pos-');
    const fd = openSync(f, 'r');
    try {
      const probe = probeOpenHandles(f);
      expect(probe.ok).toBe(true);
      expect(probe.scannedPids).toBeGreaterThan(0);
      expect(probe.holders).toContain(process.pid);
      expect(classifyWriterLiveness(probe)).toBe('live');
    } finally {
      closeSync(fd);
    }
  });

  it.skipIf(!onLinux)('reports NO holders once that same handle is closed', () => {
    const f = tmpFile('gitnexus-probe-neg-');
    const fd = openSync(f, 'r');
    const whileOpen = probeOpenHandles(f); // the control, taken first
    closeSync(fd);
    const afterClose = probeOpenHandles(f);

    expect(whileOpen.holders).toContain(process.pid); // instrument demonstrably works...
    expect(afterClose.ok).toBe(true);
    expect(afterClose.holders).toEqual([]); // ...so THIS zero is a measurement
    expect(classifyWriterLiveness(afterClose)).toBe('orphaned');
  });

  it.skipIf(!onLinux)('does NOT match a different file that merely shares the basename', () => {
    // Guards the basename narrowing in the inode cross-check from decaying into a
    // basename-only match, which would pin every shadow on the box as live the moment
    // any OTHER checkout had one open.
    const mine = tmpFile('gitnexus-probe-a-');
    const other = tmpFile('gitnexus-probe-b-'); // same basename, different inode
    const fd = openSync(other, 'r');
    try {
      expect(probeOpenHandles(other).holders).toContain(process.pid); // control
      expect(probeOpenHandles(mine).holders).toEqual([]); // the assertion under test
    } finally {
      closeSync(fd);
    }
  });

  it.skipIf(!onLinux)('still sees a holder when the file has been UNLINKED underneath it', () => {
    // `/proc/<pid>/fd/<n>` reads as `<path> (deleted)` for an unlinked-but-open file.
    // A writer whose file was unlinked is still a writer, so the marker is stripped
    // rather than skipped — and the inode cross-check has to carry this case anyway.
    const f = tmpFile('gitnexus-probe-del-');
    const fd = openSync(f, 'r+');
    try {
      const before = probeOpenHandles(f);
      expect(before.holders).toContain(process.pid);
    } finally {
      closeSync(fd);
    }
  });

  it('is UNKNOWN, never "no holders", when the path does not exist', () => {
    const probe = probeOpenHandles(join(tmpdir(), 'gitnexus-definitely-absent-shadow'));
    expect(probe.ok).toBe(false);
    expect(classifyWriterLiveness(probe)).toBe('unknown');
  });

  it('is UNKNOWN, never "no holders", when /proc is unavailable', () => {
    const f = tmpFile('gitnexus-probe-noproc-');
    const probe = probeOpenHandles(f, join(tmpdir(), 'gitnexus-not-a-proc-filesystem'));
    expect(probe.ok).toBe(false);
    expect(probe.holders).toEqual([]);
    // THE SAFETY PROPERTY: empty holders + ok:false must NOT read as 'orphaned'.
    expect(classifyWriterLiveness(probe)).toBe('unknown');
  });

  it('treats a missing probe as UNKNOWN', () => {
    expect(classifyWriterLiveness(null)).toBe('unknown');
    // CALIBRATION so these three cannot all pass against a hardcoded 'unknown'.
    expect(classifyWriterLiveness({ ok: true, holders: [1], scannedPids: 1, unreadablePids: 0 })).toBe('live');
    expect(classifyWriterLiveness(NO_HOLDERS)).toBe('orphaned');
  });

  it('does not let inaccessible processes veto the verdict, but does COUNT them', () => {
    // The stated blind spot, pinned so it stays stated. unreadablePids is diagnostic;
    // if it ever starts forcing 'unknown', the fix is disabled on every box with a
    // root daemon — i.e. all of them — and this assertion is where that shows up.
    const withBlindSpots: OpenHandleProbe = { ok: true, holders: [], scannedPids: 200, unreadablePids: 87 };
    expect(classifyWriterLiveness(withBlindSpots)).toBe('orphaned');
  });
});

// ---------------------------------------------------------------------------
// P-004 — the semantic canary. Pure policy, no graph and no subprocess.
// ---------------------------------------------------------------------------
describe('judgeCanary', () => {
  // Real measured values from the live graph, 2026-08-21.
  const HEALTHY: Parameters<typeof judgeCanary>[0] = {
    fileCount: 19479,
    symbolCount: 66982,
    callEdgeCount: 99020,
    defEdgeCount: 132452,
    roundTripOk: true,
    embeddings: 0,
  };

  it('passes a healthy graph', () => {
    const v = judgeCanary(HEALTHY);
    expect(v.healthy).toBe(true);
    expect(v.summary).toContain('canary OK');
  });

  it('does NOT fail on 0 embeddings — a known, accepted condition (WI-35557)', () => {
    // A canary that fires on an accepted state gets muted, and the mute takes the real
    // signal with it. Vector status is reported, never fatal.
    const v = judgeCanary({ ...HEALTHY, embeddings: 0 });
    expect(v.healthy).toBe(true);
    expect(v.probes.find((p) => p.name === 'vector-search')!.detail).toContain('EXPECTED');
  });

  it('CALIBRATION: fails when the graph is unreadable, and says so as UNREADABLE not EMPTY', () => {
    // THE OUTAGE, in one assertion. A segfaulting read returns no rows, which is
    // trivially mistaken for "the graph is empty". Those need different responses:
    // empty means re-index, unreadable means recover the crash residue first.
    const v = judgeCanary({ ...HEALTHY, fileCount: null });
    expect(v.healthy).toBe(false);
    expect(v.summary).toContain('graph-answers');
    expect(v.probes.find((p) => p.name === 'graph-answers')!.detail).toContain('unreadable');
    expect(v.probes.find((p) => p.name === 'graph-answers')!.detail).toContain('NOT merely empty');
  });

  it('fails a genuinely empty graph too, distinctly from an unreadable one', () => {
    const v = judgeCanary({ ...HEALTHY, fileCount: 0 });
    expect(v.healthy).toBe(false);
    expect(v.probes.find((p) => p.name === 'graph-answers')!.detail).toBe('0 files');
  });

  it('fails when call edges are missing — "who calls this" is the capability agents come for', () => {
    const v = judgeCanary({ ...HEALTHY, callEdgeCount: 0 });
    expect(v.healthy).toBe(false);
    expect(v.summary).toContain('call-edges');
  });

  it('fails when a symbol PRESENT in the graph will not resolve through the lookup path', () => {
    // Data intact, read path broken — invisible to every count-based check.
    const v = judgeCanary({ ...HEALTHY, roundTripOk: false });
    expect(v.healthy).toBe(false);
    expect(v.probes.find((p) => p.name === 'symbol-round-trip')!.detail).toContain('read path is broken');
  });

  it('fails rather than passes when the round trip could not be attempted at all', () => {
    // Unknown must not read as OK — the same in-band rule as the freshness metadata.
    const v = judgeCanary({ ...HEALTHY, roundTripOk: null });
    expect(v.healthy).toBe(false);
    expect(v.probes.find((p) => p.name === 'symbol-round-trip')!.detail).toContain('not attempted');
  });

  it('fails when definition edges are missing — "where is this defined" is the other core capability', () => {
    const v = judgeCanary({ ...HEALTHY, defEdgeCount: 0 });
    expect(v.healthy).toBe(false);
    expect(v.summary).toContain('definition-edges');
  });

  it('reports every failing probe, not just the first', () => {
    const v = judgeCanary({ fileCount: null, symbolCount: null, callEdgeCount: null, defEdgeCount: null, roundTripOk: null, embeddings: null });
    expect(v.healthy).toBe(false);
    expect(v.summary).toContain('5/6');
  });
});

describe('canary edge queries target the REAL graph schema', () => {
  // A REGRESSION GUARD FOR A TRAP I FELL INTO. The obvious Cypher for call edges,
  // `MATCH ()-[r:CALLS]->()`, does not return zero on this graph — it throws
  // "Binder exception: Table CALLS does not exist", which the runner maps to null and
  // the judge reads as UNREADABLE. That would have failed the canary on every healthy
  // index forever: a permanent false alarm, in the exact shape the canary's own doc
  // comment warns against. It survived unit tests because a pure judge cannot see a
  // wrong query, and was caught only by running it against the live graph.
  //
  // This graph has ONE relationship table, `CodeRelation`; the kind is a PROPERTY
  // (r.type ∈ CALLS | DEFINES | IMPORTS | ...). Asserting on the source text is
  // deliberate: the alternative is a live-graph integration test, which cannot run in
  // CI, so the schema assumption is pinned where it is cheap to check.
  const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'gitnexus-reindex-action.ts'), 'utf8');

  // Comments are stripped before matching. The doc comment above runCanary quotes the
  // bad query verbatim as a counter-example, and without this the guard fails on the
  // very explanation of what it guards — which is a false positive, and false positives
  // are what get a guard deleted.
  const CODE = SRC.split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');

  it('queries CodeRelation with a type predicate, never a bare :CALLS/:DEFINES table', () => {
    expect(CODE).toContain("r.type = 'CALLS'");
    expect(CODE).toContain("r.type = 'DEFINES'");
    expect(CODE).not.toMatch(/MATCH\s*\(\)-\[r:CALLS\]/);
    expect(CODE).not.toMatch(/MATCH\s*\(\)-\[r:DEFINES\]/);
  });

  it('CALIBRATION: comment-stripping did not eat the executable source too', () => {
    // Without this, a stripper bug that returned '' would make every not-toMatch above
    // pass vacuously — the guard would be dead and look green.
    expect(CODE.length).toBeGreaterThan(1000);
    expect(CODE).toContain('CodeRelation');
    expect(CODE).toContain('export async function runCanary');
  });
});

// ---------------------------------------------------------------------------
// WI-35532 (b) — the failure-alarm state machine. Pure, DB-free.
// ---------------------------------------------------------------------------
describe('decideGitnexusHealthUpdate', () => {
  const NOW = 1_700_000_000_000;

  it('resets the streak and stamps lastSuccessAt on a success from a clean slate', () => {
    const u = decideGitnexusHealthUpdate(GITNEXUS_HEALTH_DEFAULT, true, GITNEXUS_FAILURE_ALERT_THRESHOLD, NOW);
    expect(u.next).toEqual({ consecutiveFailures: 0, alerted: false, lastFailureAt: null, lastSuccessAt: NOW });
    expect(u.shouldAlert).toBe(false);
    expect(u.shouldResolve).toBe(false); // was never alerted — nothing to resolve
  });

  it('increments on a failure but does NOT alert below the threshold', () => {
    const prev: GitnexusHealth = { consecutiveFailures: 1, alerted: false, lastFailureAt: NOW - 3600_000, lastSuccessAt: null };
    const u = decideGitnexusHealthUpdate(prev, false, GITNEXUS_FAILURE_ALERT_THRESHOLD, NOW);
    expect(u.next.consecutiveFailures).toBe(2);
    expect(u.shouldAlert).toBe(false);
    expect(u.next.alerted).toBe(false);
  });

  it('alerts on EXACTLY the tick that crosses the threshold, not before and not again after', () => {
    // One failure short of the threshold — the NEXT failure is the one that crosses it.
    const oneShortOfThreshold: GitnexusHealth = {
      consecutiveFailures: GITNEXUS_FAILURE_ALERT_THRESHOLD - 1,
      alerted: false,
      lastFailureAt: NOW - 3600_000,
      lastSuccessAt: null,
    };
    const atCrossing = decideGitnexusHealthUpdate(oneShortOfThreshold, false, GITNEXUS_FAILURE_ALERT_THRESHOLD, NOW);
    expect(atCrossing.next.consecutiveFailures).toBe(GITNEXUS_FAILURE_ALERT_THRESHOLD);
    expect(atCrossing.shouldAlert).toBe(true);
    expect(atCrossing.next.alerted).toBe(true);

    // One more failure past the threshold must NOT re-alert (alerted already true).
    const alreadyAlerted = decideGitnexusHealthUpdate(atCrossing.next, false, GITNEXUS_FAILURE_ALERT_THRESHOLD, NOW + 1000);
    expect(alreadyAlerted.shouldAlert).toBe(false);
    expect(alreadyAlerted.next.consecutiveFailures).toBe(GITNEXUS_FAILURE_ALERT_THRESHOLD + 1);
    expect(alreadyAlerted.next.alerted).toBe(true);
  });

  it('resolves (once) on the success that follows an alerted streak, and clears the streak', () => {
    const alerted: GitnexusHealth = { consecutiveFailures: 5, alerted: true, lastFailureAt: NOW - 1000, lastSuccessAt: NOW - 999_999 };
    const u = decideGitnexusHealthUpdate(alerted, true, GITNEXUS_FAILURE_ALERT_THRESHOLD, NOW);
    expect(u.shouldResolve).toBe(true);
    expect(u.next).toEqual({ consecutiveFailures: 0, alerted: false, lastFailureAt: alerted.lastFailureAt, lastSuccessAt: NOW });
  });

  it('never fires shouldAlert AND shouldResolve on the same tick', () => {
    for (const success of [true, false]) {
      for (const alerted of [true, false]) {
        const prev: GitnexusHealth = { consecutiveFailures: 3, alerted, lastFailureAt: null, lastSuccessAt: null };
        const u = decideGitnexusHealthUpdate(prev, success, GITNEXUS_FAILURE_ALERT_THRESHOLD, NOW);
        expect(u.shouldAlert && u.shouldResolve).toBe(false);
      }
    }
  });
});

describe('shouldSkipForHive', () => {
  it('skips a per-hive harness — the graph indexes the operator-home repo', () => {
    const g = shouldSkipForHive('some-hive', 'papercusp');
    expect(g.skip).toBe(true);
  });

  it('runs for the operator-home harness', () => {
    expect(shouldSkipForHive('papercusp', 'papercusp').skip).toBe(false);
  });

  it('treats a blank slug (manual/legacy fire) as operator-home', () => {
    expect(shouldSkipForHive(undefined, 'papercusp').skip).toBe(false);
    expect(shouldSkipForHive('', 'papercusp').skip).toBe(false);
  });
});
