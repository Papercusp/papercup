/**
 * maxturn-sweep-live (P-024 live driver, WI-5002): the pure transcript→metrics
 * extractor, the benchmark kickoff builder, repeat aggregation, and the seam-
 * injected headless cell driver (bind→spawn→extract→clear, fail-soft clear).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  SWEEP_TASK_DONE_MARKER,
  aggregateRepeatMetrics,
  buildBenchmarkKickoff,
  buildLogFixture,
  buildSweepSpawnArgs,
  extractCellMetricsFromJsonl,
  makeHeadlessPsuCellDriver,
  sweepWorkDir,
  transcriptSawAssistantDoneMarker,
} from './maxturn-sweep-live';
import { emptyCellMetrics, expandSweepCells, resolveCellConfig, type SweepCell } from './maxturn-sweep';

// ── transcript fixture helpers ────────────────────────────────────────────────

const ts = (i: number) => new Date(1_784_300_000_000 + i * 1_000).toISOString();

function assistantLine(opts: {
  id: string;
  i: number;
  stop?: string | null;
  input?: number;
  cacheRead?: number;
  text?: string;
}): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: ts(opts.i),
    message: {
      id: opts.id,
      model: 'claude-opus-4-8',
      stop_reason: opts.stop ?? 'end_turn',
      usage: { input_tokens: opts.input ?? 100, cache_read_input_tokens: opts.cacheRead ?? 900, output_tokens: 50 },
      content: [{ type: 'text', text: opts.text ?? 'working' }],
    },
  });
}

describe('extractCellMetricsFromJsonl — the pure transcript grader', () => {
  it('an empty/unparseable transcript yields ALL-NULL metrics (never fabricated zeros)', () => {
    expect(extractCellMetricsFromJsonl('')).toEqual(emptyCellMetrics());
    expect(extractCellMetricsFromJsonl('not json\n{"torn')).toEqual(emptyCellMetrics());
  });

  it('dedupes assistant lines by message.id (one API call = one hop) with max-merged usage', () => {
    const jsonl = [
      assistantLine({ id: 'm1', i: 0, input: 10, cacheRead: 100 }),
      assistantLine({ id: 'm1', i: 1, input: 120, cacheRead: 480 }), // same message streaming — max wins
      assistantLine({ id: 'm2', i: 2, input: 30, cacheRead: 200 }),
    ].join('\n');
    const m = extractCellMetricsFromJsonl(jsonl);
    expect(m.hopsPerTask).toBe(2);
    expect(m.freshInputTokens).toBe(120 + 30);
    expect(m.cacheReadInputTokens).toBe(480 + 200);
  });

  it("counts stop_reason 'max_tokens' AND 'length' as length-stops (rate over hops)", () => {
    const jsonl = [
      assistantLine({ id: 'm1', i: 0, stop: 'max_tokens' }),
      assistantLine({ id: 'm2', i: 1, stop: 'tool_use' }),
      assistantLine({ id: 'm3', i: 2, stop: 'length' }),
      assistantLine({ id: 'm4', i: 3, stop: 'end_turn' }),
    ].join('\n');
    expect(extractCellMetricsFromJsonl(jsonl).stopReasonLengthRate).toBe(0.5);
  });

  it('counts compact_boundary system lines and the wall clock from timestamps', () => {
    const jsonl = [
      assistantLine({ id: 'm1', i: 0 }),
      JSON.stringify({ type: 'system', subtype: 'compact_boundary', timestamp: ts(5) }),
      assistantLine({ id: 'm2', i: 60 }),
    ].join('\n');
    const m = extractCellMetricsFromJsonl(jsonl);
    expect(m.compactionCount).toBe(1);
    expect(m.wallClockMs).toBe(60_000);
  });

  it('task success reads the done marker from ASSISTANT content only — a kickoff/user line quoting it never counts', () => {
    const userQuoting = JSON.stringify({
      type: 'user',
      timestamp: ts(0),
      message: { role: 'user', content: `finish then print ${SWEEP_TASK_DONE_MARKER}` },
    });
    const withoutDone = [userQuoting, assistantLine({ id: 'm1', i: 1 })].join('\n');
    expect(extractCellMetricsFromJsonl(withoutDone).taskSuccessRate).toBe(0);
    const withDone = [userQuoting, assistantLine({ id: 'm1', i: 1, text: `done\n${SWEEP_TASK_DONE_MARKER}` })].join('\n');
    expect(extractCellMetricsFromJsonl(withDone).taskSuccessRate).toBe(1);
  });

  it('spill-chase: a result-door pointer path read back later counts as chased; an ignored one does not; no spills ⇒ null', () => {
    const spillLine = JSON.stringify({
      type: 'user',
      timestamp: ts(1),
      message: { content: [{ type: 'tool_result', content: '[result-door: truncated — full result at /home/x/.papercusp/scratch/ws/tool/abc/result-door-1.md — page it]' }] },
    });
    const chaseLine = JSON.stringify({
      type: 'assistant',
      timestamp: ts(2),
      message: { id: 'm9', model: 'claude-opus-4-8', stop_reason: 'tool_use', usage: { input_tokens: 1 }, content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/home/x/.papercusp/scratch/ws/tool/abc/result-door-1.md' } }] },
    });
    const ignoredSpill = JSON.stringify({
      type: 'user',
      timestamp: ts(3),
      message: { content: [{ type: 'tool_result', content: '[result-door: full result at /home/x/.papercusp/scratch/ws/tool/def/result-door-2.md]' }] },
    });
    const both = [assistantLine({ id: 'm1', i: 0 }), spillLine, chaseLine, ignoredSpill].join('\n');
    expect(extractCellMetricsFromJsonl(both).spillChaseSuccessRate).toBe(0.5); // 1 of 2 chased
    expect(extractCellMetricsFromJsonl(assistantLine({ id: 'm1', i: 0 })).spillChaseSuccessRate).toBeNull();
  });

  it('synthetic (<synthetic>) assistant rows are not hops', () => {
    const synthetic = JSON.stringify({
      type: 'assistant',
      timestamp: ts(0),
      message: { id: 's1', model: '<synthetic>', usage: { input_tokens: 5 }, content: [] },
    });
    expect(extractCellMetricsFromJsonl(synthetic)).toEqual(emptyCellMetrics());
  });

  // WI-5003: raw-file workloads never spill through a result-door, so spill-chase
  // was null on EVERY campaign cell and the 0.95 gate could never pass. For those,
  // the declared fixture IS the spill: success = union Read-window coverage.
  describe('spillFixture coverage (raw-file spill-chase)', () => {
    const FIXTURE = '/bench/wd/fixture.log';
    const readLine = (i: number, id: string, input: Record<string, unknown>) =>
      JSON.stringify({
        type: 'assistant',
        timestamp: ts(i),
        message: {
          id,
          model: 'claude-opus-4-8',
          stop_reason: 'tool_use',
          usage: { input_tokens: 1 },
          content: [{ type: 'tool_use', name: 'Read', input }],
        },
      });
    const opts = { spillFixture: { path: FIXTURE, lines: 4_000 } };

    it('full paged coverage ⇒ 1; overlap never double-counts', () => {
      const jsonl = [
        readLine(0, 'm1', { file_path: FIXTURE, offset: 1, limit: 2000 }), // lines 1..2000
        readLine(1, 'm2', { file_path: FIXTURE, offset: 1500, limit: 2000 }), // 1500..3499 (overlap)
        readLine(2, 'm3', { file_path: FIXTURE, offset: 3001, limit: 1000 }), // 3001..4000 — finishes
      ].join('\n');
      expect(extractCellMetricsFromJsonl(jsonl, opts).spillChaseSuccessRate).toBe(1);
    });

    it('half coverage ⇒ 0.5; an offset-less/limit-less Read counts as the default 2000-line window', () => {
      const jsonl = readLine(0, 'm1', { file_path: FIXTURE });
      expect(extractCellMetricsFromJsonl(jsonl, opts).spillChaseSuccessRate).toBe(0.5);
    });

    it('a session that NEVER read the fixture scores 0 — a real failure, distinct from null/not-exercised', () => {
      const jsonl = [
        assistantLine({ id: 'm1', i: 0 }),
        readLine(1, 'm2', { file_path: '/bench/wd/other.md', offset: 1, limit: 4000 }), // different path
      ].join('\n');
      expect(extractCellMetricsFromJsonl(jsonl, opts).spillChaseSuccessRate).toBe(0);
    });

    it('without a declared fixture the metric stays null (unchanged not-exercised semantics)', () => {
      const jsonl = readLine(0, 'm1', { file_path: FIXTURE, offset: 1, limit: 4000 });
      expect(extractCellMetricsFromJsonl(jsonl).spillChaseSuccessRate).toBeNull();
    });

    it('result-door pointers take precedence over fixture coverage when both are present', () => {
      const spillLine = JSON.stringify({
        type: 'user',
        timestamp: ts(1),
        message: { content: [{ type: 'tool_result', content: '[result-door: full result at /scratch/t/result-door-9.md]' }] },
      });
      // Fixture fully covered, but the result-door spill was never chased ⇒ 0/1.
      const jsonl = [readLine(0, 'm1', { file_path: FIXTURE, offset: 1, limit: 4000 }), spillLine].join('\n');
      expect(extractCellMetricsFromJsonl(jsonl, opts).spillChaseSuccessRate).toBe(0);
    });
  });
});

describe('buildBenchmarkKickoff / buildLogFixture', () => {
  const cell = expandSweepCells().find((c) => c.taskKind === 'long-log-analysis')!;

  it('every kickoff sandboxes to the work dir, forbids shared surfaces, and closes with the done-marker discipline', () => {
    for (const c of ['drain-style', 'file-heavy-writes', 'long-log-analysis'] as const) {
      const anyCell = expandSweepCells().find((x) => x.taskKind === c)!;
      const text = buildBenchmarkKickoff({ id: anyCell.taskId, kind: c, summary: '' }, anyCell, '/tmp/wd');
      expect(text).toContain('/tmp/wd');
      expect(text).toContain('never create work items');
      expect(text.trimEnd().endsWith(`${SWEEP_TASK_DONE_MARKER} as your final line and stop.`)).toBe(true);
      expect(text).toContain(anyCell.cellId);
    }
  });

  it('the long-log kickoff names the fixture; the fixture is long, deterministic, and carries a burst', () => {
    const text = buildBenchmarkKickoff({ id: cell.taskId, kind: cell.taskKind, summary: '' }, cell, '/tmp/wd');
    expect(text).toContain('/tmp/wd/fixture.log');
    const fixture = buildLogFixture(1_000);
    expect(fixture).toBe(buildLogFixture(1_000)); // deterministic
    expect(fixture.split('\n')).toHaveLength(1_000);
    expect(fixture).toContain('ERROR');
  });

  // WI-5003 benchmark-calibration fixes (owner 2026-07-17 "fix it"):
  it('the long-log kickoff MANDATES Read-tool paging (coverage is the spill-chase metric; shell reads are invisible to it)', () => {
    const text = buildBenchmarkKickoff({ id: cell.taskId, kind: cell.taskKind, summary: '' }, cell, '/tmp/wd');
    expect(text).toContain('Read tool with offset/limit');
    expect(text).toContain('never shell commands');
  });

  it('file-writes asks for 3 docs — completable inside the task timeout (8 docs ≈ 23min vs the cap zeroed taskSuccess on every 2026-07-17 cell)', () => {
    const fw = expandSweepCells().find((x) => x.taskKind === 'file-heavy-writes')!;
    const text = buildBenchmarkKickoff({ id: fw.taskId, kind: fw.taskKind, summary: '' }, fw, '/tmp/wd');
    expect(text).toContain('doc-3.md');
    expect(text).not.toContain('doc-8.md');
  });

  it('sweepWorkDir sanitizes the cell id into a safe path segment', () => {
    expect(sweepWorkDir('a/b c__x', '/base')).toBe('/base/a_b_c__x');
  });
});

describe('aggregateRepeatMetrics', () => {
  it('means per metric, excluding nulls PER METRIC (one failed repeat never nulls the cell)', () => {
    const a = { ...emptyCellMetrics(), hopsPerTask: 10, taskSuccessRate: 1, spillChaseSuccessRate: null };
    const b = { ...emptyCellMetrics(), hopsPerTask: 20, taskSuccessRate: 0, spillChaseSuccessRate: 0.5 };
    const agg = aggregateRepeatMetrics([a, b]);
    expect(agg.hopsPerTask).toBe(15);
    expect(agg.taskSuccessRate).toBe(0.5);
    expect(agg.spillChaseSuccessRate).toBe(0.5); // the one non-null repeat
    expect(agg.compactionCount).toBeNull();
  });

  it('no repeats ⇒ empty metrics', () => {
    expect(aggregateRepeatMetrics([])).toEqual(emptyCellMetrics());
  });
});

describe('buildSweepSpawnArgs — WI-5003 live-canary finding', () => {
  it('ALWAYS includes --harness — omitting it makes psu skip su bootstrap entirely, so the', () => {
    // per-session CLAUDE_CONFIG_DIR is never seeded and the transcript lookup
    // (newestTranscriptUnderOwner) finds nothing even though the session ran the
    // benchmark task to completion. Reproduced live 2026-07-17: 12/12 unit files
    // written, transcript unfindable, because this flag was missing.
    const args = buildSweepSpawnArgs(
      { ownerId: 'su-sweep-x-r1-abc', kickoff: 'do the thing', workDir: '/tmp/x', cellId: 'x', timeoutMs: 1000, harness: 'papercusp', account: 'auto' },
      '/repo',
    );
    expect(args).toContain('--harness=papercusp');
    expect(args).toContain('--agent=claude');
    expect(args).toContain('--headless');
    expect(args).toContain('--owner-id=su-sweep-x-r1-abc');
    expect(args).toContain('--kickoff=do the thing');
    expect(args[0]).toBe('/repo/apps/operator/scripts/psu-launcher.mjs');
  });

  it('threads a non-default harness through', () => {
    const args = buildSweepSpawnArgs(
      { ownerId: 'su-sweep-y-r1-def', kickoff: 'k', workDir: '/tmp/y', cellId: 'y', timeoutMs: 1000, harness: 'some-other-harness', account: 'auto' },
      '/repo',
    );
    expect(args).toContain('--harness=some-other-harness');
  });

  // account-routing-3-options (owner 2026-07-17 "pin them to the gateway"): the
  // no-flag 'default' mode routes every cell through the ONE shared CLI credential
  // (no failover), which starved the 2026-07-17 campaign's tail cells to
  // all-null-but-ok rows while the 7-account gateway pool sat idle (WI-5003).
  it('ALWAYS emits --account so gateway routing is never an implicit fall-through', () => {
    const args = buildSweepSpawnArgs(
      { ownerId: 'su-sweep-z-r1-ghi', kickoff: 'k', workDir: '/tmp/z', cellId: 'z', timeoutMs: 1000, harness: 'papercusp', account: 'auto' },
      '/repo',
    );
    expect(args).toContain('--account=auto');
  });

  it('threads a pinned pool-account id through (hard-pin variant)', () => {
    const args = buildSweepSpawnArgs(
      { ownerId: 'su-sweep-w-r1-jkl', kickoff: 'k', workDir: '/tmp/w', cellId: 'w', timeoutMs: 1000, harness: 'papercusp', account: 'aviynw7' },
      '/repo',
    );
    expect(args).toContain('--account=aviynw7');
  });
});

describe('makeHeadlessPsuCellDriver — the seam-injected cell run', () => {
  const cell: SweepCell = expandSweepCells().find((c) => c.taskKind === 'drain-style' && c.maxTurnTargetTokens === 8_000)!;
  const config = resolveCellConfig(cell);

  function stubDeps() {
    const calls: string[] = [];
    const jsonl = [assistantLine({ id: 'm1', i: 0, text: SWEEP_TASK_DONE_MARKER })].join('\n');
    return {
      calls,
      deps: {
        mintOwnerId: (_c: SweepCell, r: number) => `su-sweep-test-r${r}`,
        bindOverride: vi.fn(async (ownerId: string, patch: unknown, cellId: string) => {
          calls.push(`bind:${ownerId}:${cellId}:${JSON.stringify(patch) === JSON.stringify(config.patch)}`);
        }),
        clearOverride: vi.fn(async (ownerId: string) => {
          calls.push(`clear:${ownerId}`);
        }),
        prepareWorkDir: vi.fn(async () => {
          calls.push('prepare');
        }),
        spawnSession: vi.fn((input: { ownerId: string; kickoff: string }) => {
          calls.push(`spawn:${input.ownerId}`);
          expect(input.kickoff).toContain(SWEEP_TASK_DONE_MARKER);
          return { done: Promise.resolve(), terminate: vi.fn() };
        }),
        readTranscript: vi.fn(async (): Promise<string | null> => jsonl),
        pollIntervalMs: 1,
      },
    };
  }

  it('binds the cell patch BEFORE spawning, extracts from the transcript, and ALWAYS clears', async () => {
    const { calls, deps } = stubDeps();
    const driver = makeHeadlessPsuCellDriver(deps);
    const metrics = await driver(cell, config, { repeats: 1, now: Date.now });
    expect(metrics.hopsPerTask).toBe(1);
    expect(metrics.taskSuccessRate).toBe(1);
    expect(calls).toEqual([
      'bind:su-sweep-test-r1:' + cell.cellId + ':true',
      'prepare',
      'spawn:su-sweep-test-r1',
      'clear:su-sweep-test-r1',
    ]);
  });

  it('runs N repeats with fresh owners and aggregates', async () => {
    const { deps } = stubDeps();
    const driver = makeHeadlessPsuCellDriver(deps);
    const metrics = await driver(cell, config, { repeats: 3, now: Date.now });
    expect(deps.spawnSession).toHaveBeenCalledTimes(3);
    expect(deps.clearOverride).toHaveBeenCalledTimes(3);
    expect(metrics.taskSuccessRate).toBe(1);
  });

  // account-routing-3-options (owner 2026-07-17 "pin them to the gateway"): the
  // driver defaults every cell to gateway auto-routing, and a caller can override
  // it (pin a pool-id / bypass with 'default').
  it('threads account into the spawn input — DEFAULTS to gateway auto-routing when unset', async () => {
    const { deps } = stubDeps();
    let seenAccount: string | undefined;
    deps.spawnSession = vi.fn((input: { ownerId: string; account?: string }) => {
      seenAccount = input.account;
      return { done: Promise.resolve(), terminate: vi.fn() };
    });
    // deps.account omitted ⇒ the driver supplies DEFAULT_SWEEP_ACCOUNT_ROUTING.
    const driver = makeHeadlessPsuCellDriver(deps);
    await driver(cell, config, { repeats: 1, now: Date.now });
    expect(seenAccount).toBe('auto');
  });

  it('threads an explicit account override (pinned pool-id) into every spawn', async () => {
    const { deps } = stubDeps();
    let seenAccount: string | undefined;
    deps.spawnSession = vi.fn((input: { ownerId: string; account?: string }) => {
      seenAccount = input.account;
      return { done: Promise.resolve(), terminate: vi.fn() };
    });
    const driver = makeHeadlessPsuCellDriver({ ...deps, account: 'aviynw7' });
    await driver(cell, config, { repeats: 1, now: Date.now });
    expect(seenAccount).toBe('aviynw7');
  });

  it('a missing transcript THROWS (runMaxTurnSweep captures it as the cell error) — and the override is STILL cleared', async () => {
    const { deps } = stubDeps();
    deps.readTranscript = vi.fn(async () => null);
    const driver = makeHeadlessPsuCellDriver(deps);
    await expect(driver(cell, config, { repeats: 1, now: Date.now })).rejects.toThrow(/no transcript/);
    expect(deps.clearOverride).toHaveBeenCalledTimes(1);
  });

  // WI-5003: a session that spawned but never completed ONE API call is a
  // routing/capacity failure, not a benchmark result — the 2026-07-17 campaign
  // silently recorded 10+ all-null rows stamped 'ok' exactly where load peaked.
  it('a ZERO-HOP transcript THROWS (status:error, never an all-null row stamped ok)', async () => {
    const { deps } = stubDeps();
    deps.readTranscript = vi.fn(async () =>
      JSON.stringify({ type: 'user', timestamp: ts(0), message: { content: [{ type: 'text', text: 'kickoff' }] } }),
    );
    const driver = makeHeadlessPsuCellDriver(deps);
    await expect(driver(cell, config, { repeats: 1, now: Date.now })).rejects.toThrow(/zero-hop/);
    expect(deps.clearOverride).toHaveBeenCalledTimes(1);
  });

  it('a long-log-analysis cell threads its fixture into extraction — full Read coverage scores spill-chase 1', async () => {
    const { join } = await import('node:path');
    const logCell: SweepCell = expandSweepCells().find((c) => c.taskKind === 'long-log-analysis' && c.maxTurnTargetTokens === 8_000)!;
    const logConfig = resolveCellConfig(logCell);
    const fixturePath = join(sweepWorkDir(`${logCell.cellId}-r1`), 'fixture.log');
    const { deps } = stubDeps();
    deps.readTranscript = vi.fn(async () =>
      [
        JSON.stringify({
          type: 'assistant',
          timestamp: ts(0),
          message: {
            id: 'm1',
            model: 'claude-opus-4-8',
            stop_reason: 'tool_use',
            usage: { input_tokens: 1 },
            content: [{ type: 'tool_use', name: 'Read', input: { file_path: fixturePath, offset: 1, limit: 4_000 } }],
          },
        }),
        assistantLine({ id: 'm2', i: 1, text: SWEEP_TASK_DONE_MARKER }),
      ].join('\n'),
    );
    const driver = makeHeadlessPsuCellDriver(deps);
    const metrics = await driver(logCell, logConfig, { repeats: 1, now: Date.now });
    expect(metrics.spillChaseSuccessRate).toBe(1);
    expect(metrics.taskSuccessRate).toBe(1);
  });

  it('a clear failure never masks the run result (warned, swallowed)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { deps } = stubDeps();
      deps.clearOverride = vi.fn(async () => {
        throw new Error('pg down');
      });
      const driver = makeHeadlessPsuCellDriver(deps);
      const metrics = await driver(cell, config, { repeats: 1, now: Date.now });
      expect(metrics.taskSuccessRate).toBe(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('failed to clear session doors override'));
    } finally {
      warn.mockRestore();
    }
  });

  it('terminates a finished cell EARLY: the poll spots the assistant done marker and calls terminate (canary run 2 idled 7 of 10 minutes otherwise)', async () => {
    const { deps } = stubDeps();
    const terminate = vi.fn();
    let resolveDone!: () => void;
    // A child that NEVER exits on its own — only terminate() releases it (the
    // pty host keeps a settled headless child alive to the timeout).
    deps.spawnSession = vi.fn(() => ({
      done: new Promise<void>((r) => {
        resolveDone = r;
      }),
      terminate: vi.fn(() => {
        terminate();
        resolveDone();
      }),
    }));
    const driver = makeHeadlessPsuCellDriver(deps);
    const metrics = await driver(cell, config, { repeats: 1, now: Date.now });
    expect(terminate).toHaveBeenCalled();
    expect(metrics.taskSuccessRate).toBe(1);
  });

  it('a transcript readable only MID-RUN still extracts (EI-13277: the store can be cleaned at host end — the post-exit read is a fallback, not the plan)', async () => {
    const { deps } = stubDeps();
    const jsonl = [assistantLine({ id: 'm1', i: 0, text: SWEEP_TASK_DONE_MARKER })].join('\n');
    let alive = false;
    let resolveDone!: () => void;
    deps.spawnSession = vi.fn(() => {
      alive = true;
      return {
        done: new Promise<void>((r) => {
          resolveDone = r;
        }),
        terminate: vi.fn(() => {
          alive = false;
          resolveDone();
        }),
      };
    });
    // Alive ⇒ the transcript exists; after exit the host cleaned it.
    deps.readTranscript = vi.fn(async () => (alive ? jsonl : null));
    const driver = makeHeadlessPsuCellDriver(deps);
    const metrics = await driver(cell, config, { repeats: 1, now: Date.now });
    expect(metrics.hopsPerTask).toBe(1);
    expect(metrics.taskSuccessRate).toBe(1);
  });
});

describe('transcriptSawAssistantDoneMarker — the early-stop signal', () => {
  it('an ASSISTANT turn printing the marker fires; a user/kickoff line quoting it never does', () => {
    const userQuoting = JSON.stringify({ type: 'user', message: { content: `print ${SWEEP_TASK_DONE_MARKER}` } });
    expect(transcriptSawAssistantDoneMarker(userQuoting)).toBe(false);
    const assistant = assistantLine({ id: 'm1', i: 0, text: SWEEP_TASK_DONE_MARKER });
    expect(transcriptSawAssistantDoneMarker([userQuoting, assistant].join('\n'))).toBe(true);
  });

  it('a synthetic (<synthetic>) assistant row never fires', () => {
    const synthetic = JSON.stringify({
      type: 'assistant',
      message: { id: 's1', model: '<synthetic>', content: [{ type: 'text', text: SWEEP_TASK_DONE_MARKER }] },
    });
    expect(transcriptSawAssistantDoneMarker(synthetic)).toBe(false);
  });
});
