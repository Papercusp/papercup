/**
 * gate-throughput-shift-left-2026-10-06 P-001 / P-002 (bars R-1, R-2, R-3).
 *
 * R-1: the per-sync delta check runs under load — the soft load band and a running
 *      green-checkpoint suite shrink its budget instead of skipping it, every heavy
 *      leg runs at idle CPU/IO priority, and only a hard ceiling still skips.
 * R-2: every tick records whether it judged its window; coverage below the
 *      threshold over the alarm window files ONE condition-keyed alarm, which
 *      clears when coverage recovers.
 * R-3: a red is routed to the agent whose edit introduced it, read from the
 *      per-edit attribution ledger (never git blame), and an assignment refusal
 *      never costs the red itself.
 */
import { describe, expect, it, vi } from 'vitest';

const captured = vi.hoisted(() => ({
  sqlCalls: [] as Array<{ text: string; values: unknown[] }>,
  sqlRows: [] as Array<Record<string, unknown>>,
  createArgs: [] as Array<Record<string, unknown>>,
}));

vi.mock('@papercusp/db-org', () => ({
  getOrgPg: () => ({
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
      captured.sqlCalls.push({ text: strings.join('$?'), values });
      return Promise.resolve(captured.sqlRows);
    },
  }),
}));

vi.mock('../agent-tools/work_items/_create-core', () => ({
  createOneWorkItem: async (args: Record<string, unknown>) => {
    captured.createArgs.push(args);
    return { ok: true, workItem: { id: 'WI-77' } };
  },
}));

import { buildSyncBatchDeltaDeps, type RunResult } from './sync-batch-delta-check-deps';
import {
  COVERAGE_ALARM_CONDITION_KEY,
  COVERAGE_ALARM_MIN_TICKS,
  REDUCED_BUDGET,
  evaluateCapacity,
  evaluateCoverage,
  fileRoutedRed,
  idlePriorityArgv,
  pickRedAuthor,
  recordCoverageTick,
  runSyncBatchDeltaCheck,
  type CoverageTick,
  type EditorHit,
  type RedFinding,
  type SyncBatch,
  type SyncBatchDeltaDeps,
  type SyncDeltaCursor,
} from './sync-batch-delta-check';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);
const NOW = 10_000_000;
const FULL = { maxConfirmRuns: 3, maxAttributionProbes: 8 };

function batch(overrides: Partial<SyncBatch> = {}): SyncBatch {
  return { sha: SHA_C, committedAtMs: NOW - 60_000, agent: 'su-trailer', paths: ['packages/foo/src/a.ts'], ...overrides };
}

function fakeDeps(overrides: Partial<SyncBatchDeltaDeps> = {}, cursor: SyncDeltaCursor | null = null) {
  const state = { cursor, filed: [] as RedFinding[], logs: [] as string[], confirms: 0 };
  const deps: SyncBatchDeltaDeps = {
    readCursor: async () => state.cursor,
    writeCursor: async (n) => {
      state.cursor = n;
    },
    hostLoad: () => ({ load1: 2, cores: 128 }),
    greenCheckpointRunning: async () => false,
    headSha: async () => SHA_B,
    listBatches: async () => [batch()],
    probeRadius: async () => ({ workspaces: ['foo'], guards: [] }),
    runAffected: async () => ({ ok: true, failing: [] }),
    runTsc: async () => ({ ok: true, failing: [] }),
    confirmOne: async () => {
      state.confirms += 1;
      return false;
    },
    fileRed: async (f) => {
      state.filed.push(f);
      return { ok: true, id: `WI-${state.filed.length}` };
    },
    now: () => NOW,
    log: (m) => state.logs.push(m),
    ...overrides,
  };
  return { deps, state };
}

function ticks(n: number, evaluated: boolean): CoverageTick[] {
  return Array.from({ length: n }, (_, i) => ({
    atMs: NOW - (i + 1) * 60_000,
    evaluated,
    status: evaluated ? ('green' as const) : ('skipped' as const),
  }));
}

describe('evaluateCapacity (R-1)', () => {
  it('runs the full budget below the soft band with no gate running', () => {
    const v = evaluateCapacity({ reading: { load1: 10, cores: 128 }, gateRunning: false, fullBudget: FULL });
    expect(v).toEqual({ skip: false, mode: 'full', budget: FULL });
  });

  it('the soft load band reduces the budget instead of skipping', () => {
    const v = evaluateCapacity({ reading: { load1: 200, cores: 128 }, gateRunning: false, fullBudget: FULL });
    expect(v.skip).toBe(false);
    if (v.skip) return;
    expect(v.mode).toBe('reduced');
    expect(v.budget).toEqual(REDUCED_BUDGET);
  });

  it('a running gate reduces the budget; an undetectable gate (null) does not', () => {
    const running = evaluateCapacity({ reading: { load1: 10, cores: 128 }, gateRunning: true, fullBudget: FULL });
    expect(running).toMatchObject({ skip: false, mode: 'reduced', reason: 'green-checkpoint-running' });
    const unknown = evaluateCapacity({ reading: { load1: 10, cores: 128 }, gateRunning: null, fullBudget: FULL });
    expect(unknown).toMatchObject({ skip: false, mode: 'full' });
  });

  it('only the hard ceiling (and an unreadable load) still skip', () => {
    const hard = evaluateCapacity({ reading: { load1: 129 * 3, cores: 128 }, gateRunning: false, fullBudget: FULL });
    expect(hard).toMatchObject({ skip: true });
    if (hard.skip) expect(hard.reason).toMatch(/hard ceiling/);
    expect(evaluateCapacity({ reading: null, gateRunning: false, fullBudget: FULL })).toEqual({
      skip: true,
      reason: 'host-load-unreadable',
    });
  });

  it('never raises a caller budget that is already below the reduced one', () => {
    const v = evaluateCapacity({
      reading: { load1: 10, cores: 128 },
      gateRunning: true,
      fullBudget: { maxConfirmRuns: 0, maxAttributionProbes: 1 },
    });
    expect(v).toMatchObject({ budget: { maxConfirmRuns: 0, maxAttributionProbes: 1 } });
  });
});

describe('runSyncBatchDeltaCheck under load (R-1)', () => {
  it('judges the window in the soft band, spending at most the reduced confirm budget', async () => {
    const failing = [
      { workspace: 'foo', file: 'packages/foo/src/a.test.ts' },
      { workspace: 'foo', file: 'packages/foo/src/b.test.ts' },
    ];
    const { deps, state } = fakeDeps(
      { hostLoad: () => ({ load1: 200, cores: 128 }), runAffected: async () => ({ ok: false, failing }) },
      { sha: SHA_A, updatedAtMs: 1 },
    );
    const res = await runSyncBatchDeltaCheck(deps);
    expect(res.status).not.toBe('skipped');
    expect(state.confirms).toBe(REDUCED_BUDGET.maxConfirmRuns);
    expect(state.cursor?.sha).toBe(SHA_B);
  });
});

describe('idle-priority legs (R-1)', () => {
  it('idlePriorityArgv wraps a command in nice 19 + ionice idle', () => {
    expect(idlePriorityArgv('node', ['x.mjs', '--a'])).toEqual({
      cmd: 'nice',
      args: ['-n', '19', 'ionice', '-c', '3', 'node', 'x.mjs', '--a'],
    });
  });

  it('every heavy leg spawns through idle priority; the millisecond git/proc-guard reads do not', async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const exec = async (cmd: string, args: string[]): Promise<RunResult | null> => {
      calls.push({ cmd, args });
      return { status: 0, stdout: '', stderr: '' };
    };
    const deps = buildSyncBatchDeltaDeps({ installSlug: 'h', workspaceId: 'w', root: '/r', branch: 'staging', exec });
    await deps.probeRadius(['a.ts']);
    await deps.runAffected(['a.ts']);
    await deps.runTsc(['a.ts']);
    await deps.confirmOne('a.test.ts');
    const heavy = calls.splice(0);
    expect(heavy).toHaveLength(4);
    for (const c of heavy) {
      expect(c.cmd).toBe('nice');
      expect(c.args.slice(0, 6)).toEqual(['-n', '19', 'ionice', '-c', '3', 'node']);
    }
    await deps.headSha();
    await deps.greenCheckpointRunning();
    expect(calls.map((c) => c.cmd)).toEqual(['git', 'node']);
  });
});

describe('coverage record + alarm (R-2)', () => {
  it('recordCoverageTick appends and drops ticks older than the retention window', () => {
    const old = { atMs: NOW - 25 * 60 * 60_000, evaluated: true, status: 'green' as const };
    const next = recordCoverageTick({ ticks: [old] }, { atMs: NOW, evaluated: false, status: 'skipped' });
    expect(next.ticks).toEqual([{ atMs: NOW, evaluated: false, status: 'skipped' }]);
  });

  it('too few samples is NOT an alarm (ratio null), never a false low', () => {
    const v = evaluateCoverage({ ticks: ticks(COVERAGE_ALARM_MIN_TICKS - 1, false) }, NOW);
    expect(v).toMatchObject({ ratio: null, low: false });
  });

  it('files ONE condition-keyed alarm when coverage drops, dedups the next tick, clears on recovery', async () => {
    const { deps, state } = fakeDeps(
      { hostLoad: () => null }, // every tick skips → unevaluated
      { sha: SHA_A, updatedAtMs: 1, coverage: { ticks: ticks(COVERAGE_ALARM_MIN_TICKS, false) } },
    );
    await runSyncBatchDeltaCheck(deps);
    expect(state.filed).toHaveLength(1);
    expect(state.filed[0]?.conditionKey).toBe(COVERAGE_ALARM_CONDITION_KEY);
    expect(state.cursor?.coverage?.alarmOpenSinceMs).toBe(NOW);

    await runSyncBatchDeltaCheck(deps); // still low — must not re-file
    expect(state.filed).toHaveLength(1);

    // Recovery: a window of evaluated ticks and a judged run clear the alarm state.
    state.cursor = {
      sha: SHA_A,
      updatedAtMs: 1,
      coverage: { alarmOpenSinceMs: NOW - 1, ticks: ticks(COVERAGE_ALARM_MIN_TICKS + 1, true) },
    };
    deps.hostLoad = () => ({ load1: 2, cores: 128 });
    const res = await runSyncBatchDeltaCheck(deps);
    expect(res.status).toBe('green');
    expect(state.cursor?.coverage?.alarmOpenSinceMs).toBeUndefined();
    expect(state.cursor?.coverage?.ticks.at(-1)).toMatchObject({ atMs: NOW, evaluated: true });
  });
});

describe('author routing (R-3)', () => {
  const hit = (file: string, agent: string, tsMs: number): EditorHit => ({ file, agent, tsMs });

  it('prefers the newest editor of the failing file, then of the batch, then the trailer', () => {
    const b = batch({ paths: ['packages/foo/src/a.ts', 'packages/foo/src/b.ts'] });
    expect(
      pickRedAuthor({
        failingFile: 'packages/foo/src/a.ts',
        batch: b,
        editors: [hit('packages/foo/src/a.ts', 'su-old', 1), hit('packages/foo/src/a.ts', 'su-new', 2), hit('packages/foo/src/b.ts', 'su-b', 3)],
      }),
    ).toEqual({ agent: 'su-new', source: 'edit-ledger:failing-file' });
    expect(
      pickRedAuthor({ failingFile: 'packages/foo/src/a.test.ts', batch: b, editors: [hit('packages/foo/src/b.ts', 'su-b', 3)] }),
    ).toEqual({ agent: 'su-b', source: 'edit-ledger:batch' });
    expect(pickRedAuthor({ failingFile: 'x.ts', batch: b, editors: null })).toEqual({ agent: 'su-trailer', source: 'trailer' });
  });

  it('never routes to a system identity, and says so when nobody is attributable', () => {
    const b = batch({ agent: 'system:git-sync' });
    expect(
      pickRedAuthor({ failingFile: 'packages/foo/src/a.ts', batch: b, editors: [hit('packages/foo/src/a.ts', 'system:hook', 9)] }),
    ).toEqual({ agent: null, source: 'none' });
  });

  it('end to end: a seeded type error in a sync batch files a fix-it assigned to the editing agent', async () => {
    const lookups: Array<{ files: readonly string[]; sinceMs: number }> = [];
    const { deps, state } = fakeDeps(
      {
        runTsc: async () => ({ ok: false, failing: ['packages/foo/src/a.ts'] }),
        lookupEditors: async (files, sinceMs) => {
          lookups.push({ files, sinceMs });
          return [hit('packages/foo/src/a.ts', 'su-author-1', NOW - 90_000)];
        },
      },
      { sha: SHA_A, updatedAtMs: 1 },
    );
    const res = await runSyncBatchDeltaCheck(deps);
    expect(res.status).toBe('red');
    const finding = state.filed.find((f) => f.conditionKey !== COVERAGE_ALARM_CONDITION_KEY);
    expect(finding?.assignee).toBe('su-author-1');
    expect(finding?.authorSource).toBe('edit-ledger:failing-file');
    expect(finding?.body).toContain('su-author-1');
    expect(lookups[0]?.files).toContain('packages/foo/src/a.ts');
    expect(lookups[0]!.sinceMs).toBeLessThan(NOW - 60_000); // window opens before the batch commit
  });

  it('a refused assignment re-files the red unassigned instead of losing it', async () => {
    const seen: RedFinding[] = [];
    const logs: string[] = [];
    const res = await fileRoutedRed(
      {
        fileRed: async (f) => {
          seen.push(f);
          return f.assignee ? { ok: false, error: 'assignee_unresolvable' } : { ok: true, id: 'WI-9' };
        },
        log: (m) => logs.push(m),
      },
      { title: 't', body: 'b', conditionKey: 'k', paths: [], assignee: 'su-gone', authorSource: 'trailer' } as unknown as RedFinding,
    );
    expect(res).toEqual({ ok: true, id: 'WI-9' });
    expect(seen.map((f) => f.assignee)).toEqual(['su-gone', null]);
    expect(logs.join('\n')).toMatch(/refused/);
  });

  it('the IO binding reads the attribution ledger scoped to the workspace, and files with assign_to', async () => {
    captured.sqlCalls.length = 0;
    captured.createArgs.length = 0;
    captured.sqlRows = [{ file: 'packages/foo/src/a.ts', agent_id: 'su-author-1', ts: new Date(NOW).toISOString() }];
    const deps = buildSyncBatchDeltaDeps({ installSlug: 'h', workspaceId: 'ws-1', root: '/r', branch: 'staging' });
    const hits = await deps.lookupEditors!(['packages/foo/src/a.ts'], NOW - 1000);
    expect(hits).toEqual([{ file: 'packages/foo/src/a.ts', agent: 'su-author-1', tsMs: NOW }]);
    const q = captured.sqlCalls[0]!;
    expect(q.text).toContain('harness_shared.edit_attribution_ledger');
    expect(q.text).not.toMatch(/git blame/);
    expect(q.values).toContain('ws-1');

    await deps.fileRed({
      title: 't',
      body: 'b',
      conditionKey: 'k',
      paths: ['packages/foo/src/a.ts'],
      assignee: 'su-author-1',
      authorSource: 'edit-ledger:failing-file',
    } as unknown as RedFinding);
    await deps.fileRed({ title: 't', body: 'b', conditionKey: 'k2', paths: [], assignee: null, authorSource: 'none' } as unknown as RedFinding);
    expect(captured.createArgs[0]?.assign_to).toBe('su-author-1');
    expect('assign_to' in (captured.createArgs[1] ?? {})).toBe(false);
  });
});
