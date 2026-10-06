/**
 * Unit tests for the sync-batch delta check (gate-verdict-liveness P-012).
 *
 * Everything runs against plain `SyncBatchDeltaDeps` fakes — no `vi.mock`, so the
 * full-replacement-mock-guard has nothing to trip on. One test pins
 * `parseFailingFilesLine` against the REAL emitter
 * (`formatFailingFilesLine`, scripts/lib/vitest-summary.mjs) so the two cannot
 * drift, per the module header's contract.
 */
import { describe, expect, it } from 'vitest';
import { formatFailingFilesLine } from '../../../../scripts/lib/vitest-summary.mjs';
import { parseConfirmOutput } from './sync-batch-delta-check-deps';
import {
  conditionKeyForRed,
  parseFailingFilesLine,
  parseSyncBatches,
  runSyncBatchDeltaCheck,
  unionBatchPaths,
  type FailingFile,
  type RedFinding,
  type SyncBatch,
  type SyncBatchDeltaDeps,
  type SyncDeltaCursor,
} from './sync-batch-delta-check';

const NUL = String.fromCharCode(0);
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);

function makeBatch(overrides: Partial<SyncBatch> = {}): SyncBatch {
  return { sha: SHA_C, committedAtMs: 1_700_000_000_000, agent: 'su-test', paths: ['packages/foo/src/a.ts'], ...overrides };
}

interface FakeState {
  cursor: SyncDeltaCursor | null;
  filed: RedFinding[];
  logs: string[];
}

function makeDeps(
  overrides: Partial<SyncBatchDeltaDeps> = {},
  initialCursor: SyncDeltaCursor | null = null,
): { deps: SyncBatchDeltaDeps; state: FakeState } {
  const state: FakeState = { cursor: initialCursor, filed: [], logs: [] };
  const deps: SyncBatchDeltaDeps = {
    readCursor: async () => state.cursor,
    writeCursor: async (n) => {
      state.cursor = n;
    },
    hostLoad: () => ({ load1: 2, cores: 128 }),
    // async by contract — these legs shell out; see SyncBatchDeltaDeps (WI-10001771).
    greenCheckpointRunning: async () => false,
    headSha: async () => SHA_B,
    listBatches: async () => [makeBatch()],
    probeRadius: async () => ({ workspaces: ['foo'], guards: [] }),
    runAffected: async () => ({ ok: true, failing: [] }),
    runTsc: async () => ({ ok: true, failing: [] }),
    confirmOne: async () => false,
    fileRed: async (f) => {
      state.filed.push(f);
      return { ok: true, id: 'WI-1' };
    },
    now: () => 1_000,
    log: (m) => state.logs.push(m),
    ...overrides,
  };
  return { deps, state };
}

describe('parseSyncBatches', () => {
  it('parses NUL-separated blocks: sha + epoch header, Papercusp-Agent trailer, changed paths', () => {
    const raw =
      `${NUL}${SHA_C} 1700000000\nPapercusp-Agent: su-1\npackages/foo/a.ts\npackages/foo/b.ts\n` +
      `${NUL}${SHA_A} 1700000100\npackages/bar/c.ts\n`;
    const batches = parseSyncBatches(raw);
    expect(batches).toHaveLength(2);
    expect(batches[0]).toEqual({
      sha: SHA_C,
      committedAtMs: 1_700_000_000_000,
      agent: 'su-1',
      paths: ['packages/foo/a.ts', 'packages/foo/b.ts'],
    });
    expect(batches[1]?.agent).toBeNull();
    expect(batches[1]?.paths).toEqual(['packages/bar/c.ts']);
  });

  it('skips malformed headers instead of inventing a batch', () => {
    expect(parseSyncBatches(`${NUL}not-a-sha 123\nfoo.ts\n`)).toEqual([]);
  });
});

describe('unionBatchPaths', () => {
  it('dedupes in first-seen order and reports truncation as a refusal, not a narrower set', () => {
    const b1 = makeBatch({ paths: ['a.ts', 'b.ts'] });
    const b2 = makeBatch({ sha: SHA_A, paths: ['b.ts', 'c.ts', 'd.ts'] });
    const capped = unionBatchPaths([b1, b2], 3);
    expect(capped.truncated).toBe(true);
    expect(capped.totalPaths).toBe(4);
    expect(capped.paths).toEqual(['a.ts', 'b.ts', 'c.ts']);
    const fits = unionBatchPaths([b1, b2], 10);
    expect(fits.truncated).toBe(false);
    expect(fits.paths).toEqual(['a.ts', 'b.ts', 'c.ts', 'd.ts']);
  });
});

describe('runSyncBatchDeltaCheck — cursor discipline', () => {
  it('bootstraps the cursor at tip on first run (never scans history backwards)', async () => {
    const { deps, state } = makeDeps();
    const res = await runSyncBatchDeltaCheck(deps);
    expect(res.status).toBe('bootstrapped');
    expect(state.cursor?.sha).toBe(SHA_B);
  });

  it('reports up-to-date when the cursor already sits at head', async () => {
    const { deps, state } = makeDeps({}, { sha: SHA_B, updatedAtMs: 1 });
    const res = await runSyncBatchDeltaCheck(deps);
    expect(res.status).toBe('up-to-date');
    expect(state.cursor?.sha).toBe(SHA_B);
  });

  it('load-skip: does NOT advance the cursor, only annotates the skip', async () => {
    const { deps, state } = makeDeps(
      { hostLoad: () => ({ load1: 500, cores: 128 }) },
      { sha: SHA_A, updatedAtMs: 1 },
    );
    const res = await runSyncBatchDeltaCheck(deps);
    expect(res.status).toBe('skipped');
    expect(res.reason).toMatch(/^host-load/);
    expect(state.cursor?.sha).toBe(SHA_A); // window stays unjudged
    expect(state.cursor?.lastSkipReason).toMatch(/^host-load/);
  });

  it('an unreadable load also skips (optional work never runs blind)', async () => {
    const { deps } = makeDeps({ hostLoad: () => null }, { sha: SHA_A, updatedAtMs: 1 });
    const res = await runSyncBatchDeltaCheck(deps);
    expect(res.status).toBe('skipped');
    expect(res.reason).toBe('host-load-unreadable');
  });

  it('a running green-checkpoint suite REDUCES the budget instead of skipping (P-001)', async () => {
    // The old rule skipped here; with the gate running for hours that judged almost
    // nothing. Legs run at idle priority instead, so the window IS judged.
    const { deps, state } = makeDeps({ greenCheckpointRunning: async () => true }, { sha: SHA_A, updatedAtMs: 1 });
    const res = await runSyncBatchDeltaCheck(deps);
    expect(res.status).toBe('green');
    expect(state.cursor?.sha).toBe(SHA_B);
    expect(state.logs.some((l) => l.includes('reduced budget') && l.includes('green-checkpoint-running'))).toBe(true);
  });

  it('an undetermined affected run (red, no break-set line) holds the cursor', async () => {
    const { deps, state } = makeDeps(
      { runAffected: async () => ({ ok: false, failing: null }) },
      { sha: SHA_A, updatedAtMs: 1 },
    );
    const res = await runSyncBatchDeltaCheck(deps);
    expect(res.status).toBe('skipped');
    expect(res.reason).toBe('affected-run-undetermined');
    expect(state.cursor?.sha).toBe(SHA_A); // re-judged next tick
  });

  it('a too-wide radius is refused but the cursor ADVANCES (a parked cursor would re-refuse forever)', async () => {
    const { deps, state } = makeDeps(
      { probeRadius: async () => ({ workspaces: ['a', 'b', 'c', 'd'], guards: [] }) },
      { sha: SHA_A, updatedAtMs: 1 },
    );
    const res = await runSyncBatchDeltaCheck(deps);
    expect(res.status).toBe('radius-too-wide');
    expect(state.cursor?.sha).toBe(SHA_B);
    expect(state.cursor?.lastSkipReason).toBe('radius-too-wide');
  });
});

describe('runSyncBatchDeltaCheck — reds, confirmation, filing', () => {
  const failingFile: FailingFile = { workspace: 'foo', file: 'packages/foo/src/a.test.ts' };

  it('a confirmed red files ONE deduped item under its conditionKey, attributed to the touching batch', async () => {
    const batch = makeBatch({ paths: ['packages/foo/src/a.test.ts'] });
    const { deps, state } = makeDeps(
      {
        listBatches: async () => [batch],
        runAffected: async () => ({ ok: false, failing: [failingFile] }),
        confirmOne: async () => false, // re-confirmed red in its own invocation
      },
      { sha: SHA_A, updatedAtMs: 1 },
    );
    const res = await runSyncBatchDeltaCheck(deps);
    expect(res.status).toBe('red');
    expect(state.filed).toHaveLength(1);
    const finding = state.filed[0]!;
    expect(finding.conditionKey).toBe(conditionKeyForRed(failingFile.file));
    expect(finding.body).toContain(`Introducing batch: ${batch.sha}`);
    expect(finding.body).toContain('Papercusp-Agent trailer: su-test');
    expect(res.filed[0]?.introducedBy).toBe(batch.sha);
    // the red is held open on the advanced cursor for cheap re-verification
    expect(state.cursor?.sha).toBe(SHA_B);
    expect(state.cursor?.openReds?.[0]?.path).toBe(failingFile.file);
  });

  it('a red the single-file re-run does NOT reproduce is reported unconfirmed, never filed', async () => {
    const { deps, state } = makeDeps(
      {
        runAffected: async () => ({ ok: false, failing: [failingFile] }),
        confirmOne: async () => null, // collection-abort false positive: undetermined
      },
      { sha: SHA_A, updatedAtMs: 1 },
    );
    const res = await runSyncBatchDeltaCheck(deps);
    expect(state.filed).toHaveLength(0);
    expect(res.unconfirmed).toEqual([failingFile.file]);
    expect(res.status).toBe('green'); // nothing was PROVEN red
  });

  it('re-verifies held-open reds even with no new commits, refreshing the same conditionKey', async () => {
    const openRed = {
      path: failingFile.file,
      workspace: failingFile.workspace,
      introducedBy: SHA_C,
      firstSeenMs: 500,
      confirmations: 1,
    };
    const { deps, state } = makeDeps(
      { headSha: async () => SHA_A, confirmOne: async () => false },
      { sha: SHA_A, updatedAtMs: 1, openReds: [openRed] },
    );
    const res = await runSyncBatchDeltaCheck(deps);
    expect(res.status).toBe('up-to-date');
    expect(state.filed).toHaveLength(1);
    expect(state.filed[0]?.conditionKey).toBe(conditionKeyForRed(failingFile.file));
    expect(state.cursor?.openReds?.[0]?.confirmations).toBe(2);
  });

  it('a held-open red that re-runs green stops being held', async () => {
    const openRed = { path: failingFile.file, workspace: null, introducedBy: null, firstSeenMs: 500, confirmations: 1 };
    const { deps, state } = makeDeps(
      { headSha: async () => SHA_A, confirmOne: async () => true },
      { sha: SHA_A, updatedAtMs: 1, openReds: [openRed] },
    );
    await runSyncBatchDeltaCheck(deps);
    expect(state.filed).toHaveLength(0);
    expect(state.cursor?.openReds ?? []).toHaveLength(0);
  });
});

describe('parseFailingFilesLine — pinned against the REAL emitter', () => {
  const emit = (entries: Array<{ workspace: string; file: string }>): string =>
    formatFailingFilesLine({
      runToken: 'r-test',
      entries,
      unattributed: [],
      transformCulprits: [],
      attributionFallbacks: [],
    });

  it('round-trips formatFailingFilesLine output', () => {
    const line = emit([{ workspace: 'foo', file: 'packages/foo/src/a.test.ts' }]);
    expect(parseFailingFilesLine(line)).toEqual([{ workspace: 'foo', file: 'packages/foo/src/a.test.ts' }]);
  });

  it('a PRESENT line with files=[] is [] (red, but unattributed) — an ABSENT line is null (no verdict)', () => {
    expect(parseFailingFilesLine(emit([]))).toEqual([]);
    expect(parseFailingFilesLine('vitest exploded before the summary\n')).toBeNull();
  });

  it('control: a deliberately-wrong parser that reads absence as "no failures" disagrees with the real one', () => {
    // The naive shape this contract exists to forbid: absent line ⇒ [].
    const naive = (text: string): FailingFile[] =>
      parseFailingFilesLine(text) ?? []; // collapses null into []
    const aborted = 'run killed during collection\n';
    expect(naive(aborted)).toEqual([]); // the false green
    expect(parseFailingFilesLine(aborted)).toBeNull(); // the real parser refuses to call it green
  });
});

describe('parseConfirmOutput (deps leg)', () => {
  it('reads status=passed / status=failed from the terminal TEST_FILE_RESULT line', () => {
    expect(parseConfirmOutput('TEST_FILE_RESULT requested=1 matched=1 status=passed durationMs=12\n')).toBe(true);
    expect(parseConfirmOutput('noise\nTEST_FILE_RESULT requested=1 matched=1 status=failed x=1\n')).toBe(false);
  });

  it('matched=0 and an absent line are BOTH undetermined (null), never false', () => {
    expect(parseConfirmOutput('TEST_FILE_ROUTE_ERROR requested=1 matched=0\nTEST_FILE_RESULT requested=1 matched=0 status=failed\n')).toBeNull();
    expect(parseConfirmOutput('vitest never reached its terminal line\n')).toBeNull();
  });
});
