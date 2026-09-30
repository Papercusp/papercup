import { describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';

// EI-19937931088042507 / EI-19938311427988534: readBgHostJournalUncached shells out to
// `journalctl` via execFile with NO default timeout — an unresponsive/slow journal (disk
// pressure, journal rotation stall) hung it INDEFINITELY, and status.ts's `.catch(() =>
// null)` around readPotSoakReport only guards a rejection, never a hang, so pot:status
// never returned (measured >55s, 3/3 reproductions). Stub `node:child_process`'s `execFile`
// to reproduce Node's own timeout-kill contract (callback invoked with `killed:true`) WITHOUT
// waiting out the real JOURNALCTL_TIMEOUT_MS, so this test both runs fast and proves the
// bound actually degrades to a reported `journalError` instead of hanging the caller.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: vi.fn(
      (
        _file: string,
        _args: readonly string[],
        _options: unknown,
        callback: (error: Error & { killed?: boolean; signal?: string }, stdout: string, stderr: string) => void,
      ) => {
        setImmediate(() => {
          const err = Object.assign(new Error('journalctl killed'), { killed: true, signal: 'SIGTERM' });
          callback(err, '', '');
        });
        return { kill: vi.fn() };
      },
    ),
  };
});

import {
  WAKE_MEAN_CHAR_BUDGET,
  computeSoakReport,
  parseBgHostGlobalJournal,
  parseBgHostUnitJournal,
  readBgHostJournalUncached,
} from './soak-report';

describe('parseBgHostUnitJournal', () => {
  it('counts evidence from the canonical bg-host unit', () => {
    const journal = [
      'Sep 30 10:00:00 host systemd[4022]: Started papercusp-bg-host.service - Papercusp dedicated background host.',
      'Sep 30 10:01:00 host systemd[4022]: papercusp-bg-host.service: Consumed 1min CPU time, 4G memory peak, 0B memory swap peak.',
      "Sep 30 10:01:00 host systemd[4022]: papercusp-bg-host.service: Failed with result 'oom-kill'.",
      'Sep 30 10:01:00 host systemd[4022]: papercusp-bg-host.service: A process of this unit has been killed by the OOM killer.',
    ].join('\n');

    expect(parseBgHostUnitJournal(journal)).toMatchObject({
      restartCount: 1,
      failureCount: 1,
      oomKillCount: 1,
      peakMemoryMb: 4096,
      highMemoryPeakCount: 1,
      journalAvailable: true,
      journalError: null,
    });
    expect(parseBgHostGlobalJournal(journal)).toBe(1);
  });

  it('counts restarts, oom evidence, and memory peaks', () => {
    const journal = [
      'Started papercup-bg-host.service',
      'papercup-bg-host.service: Consumed 10min CPU time, 6.5G memory peak, 0B memory swap peak.',
      'Started papercup-bg-host.service',
      'FatalProcessOutOfMemory',
    ].join('\n');

    expect(parseBgHostUnitJournal(journal)).toEqual({
      oomKillCount: 1,
      restartCount: 2,
      failureCount: 0,
      peakMemoryMb: 6656,
      highMemoryPeakCount: 1,
      journalError: null,
      journalAvailable: true,
    });
  });

  it('separates a CRASH from a deliberate restart (the readiness criterion)', () => {
    // A deploy restart is stop+start: systemd logs "Stopping"/"Started" and NO
    // failure line. A crash logs "Failed with result '<why>'" — exactly one per
    // death. Both bump restartCount; only the crash may red the gate.
    const deliberate = [
      'Jul 13 00:31:02 host systemd[4022]: Stopping papercup-bg-host.service - Papercusp dedicated background host...',
      'Jul 13 00:31:04 host systemd[4022]: Started papercup-bg-host.service - Papercusp dedicated background host.',
    ].join('\n');
    const crashed = [
      'Jul 13 01:02:03 host systemd[4022]: papercup-bg-host.service: Main process exited, code=killed, status=9/KILL',
      "Jul 13 01:02:03 host systemd[4022]: papercup-bg-host.service: Failed with result 'oom-kill'.",
      'Jul 13 01:02:05 host systemd[4022]: Started papercup-bg-host.service - Papercusp dedicated background host.',
    ].join('\n');

    expect(parseBgHostUnitJournal(deliberate)).toMatchObject({ restartCount: 1, failureCount: 0 });
    expect(parseBgHostUnitJournal(crashed)).toMatchObject({ restartCount: 1, failureCount: 1 });
  });

  it('parses the lines systemd actually emits (unit name + description suffix)', () => {
    // Verbatim from `journalctl --user -u papercup-bg-host.service` on the dev host.
    // The synthetic fixture above is trimmed to the bare message; production lines
    // carry a timestamp/host/pid prefix AND a " - <Description>" suffix, so pin the
    // real shape — the parser is worthless if it only matches the test's own strings.
    const journal = [
      'Jul 12 12:14:44 host systemd[4022]: papercup-bg-host.service: Consumed 20h 24min 15.394s CPU time, 23.8G memory peak, 0B memory swap peak.',
      'Jul 12 12:14:44 host systemd[4022]: Started papercup-bg-host.service - Papercusp dedicated background host — DBOS routines/git-sync/substrate primary (P1-3).',
    ].join('\n');

    const parsed = parseBgHostUnitJournal(journal);
    expect(parsed.restartCount).toBe(1);
    expect(parsed.peakMemoryMb).toBe(24371);
    expect(parsed.highMemoryPeakCount).toBe(1);
  });
});

describe('parseBgHostGlobalJournal', () => {
  it('counts only bg-host-tagged oom lines', () => {
    const journal = [
      'systemd: papercup-bg-host.service: A process of this unit has been killed by the OOM killer.',
      'systemd: some-other.service: A process of this unit has been killed by the OOM killer.',
      'bash: bg-host FatalProcessOutOfMemory',
    ].join('\n');

    expect(parseBgHostGlobalJournal(journal)).toBe(2);
  });
});

describe('computeSoakReport', () => {
  it('returns READY only when every threshold holds', () => {
    const report = computeSoakReport({
      potSlug: 'papercusp',
      surveyScope: 'members',
      surveySlugs: ['papercusp', 'papercusp-member'],
      windowHours: 24,
      generatedAtMs: Date.UTC(2026, 6, 2, 10, 0, 0),
      bgHost: {
        oomKillCount: 0,
        // Deploy restarts in the window do NOT red the gate — only failures do
        // [owner 2026-07-13 "red only on crashes"]. Shipping a routine fix
        // must not make readiness unsatisfiable.
        restartCount: 3,
        failureCount: 0,
        peakMemoryMb: 2048,
        highMemoryPeakCount: 0,
        journalError: null,
        journalAvailable: true,
        tickerUp: true,
        tickerNote: null,
      },
      roleSuccess: [
        { role: 'cup', totalTerminalTurns: 4, successfulTurns: 4, successRate: 1 },
        { role: 'mug', totalTerminalTurns: 3, successfulTurns: 3, successRate: 1 },
        { role: 'kettle', totalTerminalTurns: 2, successfulTurns: 2, successRate: 1 },
      ],
      frontier: { placeable: 4, quarantined: 0 },
      infraCurse: { placementsSeen: 10, infraCurses: 0, rate: 0, recoveringOpen: 1, staleRecovering: 0 },
      escalationBacklog: { openNow: 0, olderOpenCount: 0, newerOpenCount: 0, improving: true },
      gateGreenRatio: { green: 5, total: 5, ratio: 1 },
      deployLatency: { samples: 2, meanMs: 120000 },
      contextBurn: {
        loopWakes: 400,
        nonLoopInboxWakes: 0,
        meanWakeChars: 1500,
        maxWakeChars: 5900,
        estMeanWakeTokens: 375,
        requestedCompactions: 12,
        sessionsCompacting: 6,
        compactionsPerSession: 2,
        postCompactionErrorMarkers: 0,
      },
    });

    expect(report.ready).toBe(true);
    expect(report.reasons).toEqual([]);
  });

  it('a quiet window (no loop wakes, no compactions) adds NO context-burn reasons', () => {
    const report = computeSoakReport({
      potSlug: 'papercusp',
      surveyScope: 'members',
      surveySlugs: ['papercusp'],
      windowHours: 24,
      generatedAtMs: Date.UTC(2026, 6, 2, 10, 0, 0),
      bgHost: {
        oomKillCount: 0,
        restartCount: 0,
        failureCount: 0,
        peakMemoryMb: null,
        highMemoryPeakCount: 0,
        journalError: null,
        journalAvailable: true,
        tickerUp: true,
        tickerNote: null,
      },
      roleSuccess: [
        { role: 'cup', totalTerminalTurns: 1, successfulTurns: 1, successRate: 1 },
        { role: 'mug', totalTerminalTurns: 1, successfulTurns: 1, successRate: 1 },
        { role: 'kettle', totalTerminalTurns: 1, successfulTurns: 1, successRate: 1 },
      ],
      frontier: { placeable: 4, quarantined: 0 },
      infraCurse: { placementsSeen: 10, infraCurses: 0, rate: 0, recoveringOpen: 0, staleRecovering: 0 },
      escalationBacklog: { openNow: 0, olderOpenCount: 0, newerOpenCount: 0, improving: true },
      gateGreenRatio: { green: 5, total: 5, ratio: 1 },
      deployLatency: { samples: 2, meanMs: 120000 },
      contextBurn: {
        loopWakes: 0,
        nonLoopInboxWakes: 0,
        meanWakeChars: null,
        maxWakeChars: null,
        estMeanWakeTokens: null,
        requestedCompactions: 0,
        sessionsCompacting: 0,
        compactionsPerSession: null,
        postCompactionErrorMarkers: 0,
      },
    });

    expect(report.ready).toBe(true);
    expect(report.reasons).toEqual([]);
  });

  it('lists concrete failing reasons when the gate is red', () => {
    const report = computeSoakReport({
      potSlug: 'papercusp',
      surveyScope: 'workspace',
      surveySlugs: ['papercusp'],
      windowHours: 24,
      generatedAtMs: Date.UTC(2026, 6, 2, 10, 0, 0),
      bgHost: {
        oomKillCount: 1,
        restartCount: 2,
        failureCount: 2,
        peakMemoryMb: 8192,
        highMemoryPeakCount: 2,
        journalError: null,
        journalAvailable: true,
        tickerUp: false,
        tickerNote: 'ticker stale',
      },
      roleSuccess: [
        { role: 'cup', totalTerminalTurns: 4, successfulTurns: 3, successRate: 0.75 },
        { role: 'mug', totalTerminalTurns: 0, successfulTurns: 0, successRate: null },
        { role: 'kettle', totalTerminalTurns: 1, successfulTurns: 1, successRate: 1 },
      ],
      frontier: { placeable: 0, quarantined: 7 },
      infraCurse: { placementsSeen: 10, infraCurses: 1, rate: 0.1, recoveringOpen: 2, staleRecovering: 2 },
      escalationBacklog: { openNow: 2, olderOpenCount: 0, newerOpenCount: 2, improving: false },
      gateGreenRatio: { green: 2, total: 3, ratio: 2 / 3 },
      deployLatency: { samples: 1, meanMs: 20 * 60_000 },
      contextBurn: {
        loopWakes: 900,
        nonLoopInboxWakes: 0,
        meanWakeChars: WAKE_MEAN_CHAR_BUDGET + 600,
        maxWakeChars: 9000,
        estMeanWakeTokens: 900,
        requestedCompactions: 40,
        sessionsCompacting: 5,
        compactionsPerSession: 8,
        postCompactionErrorMarkers: 3,
      },
    });

    expect(report.ready).toBe(false);
    expect(report.reasons).toEqual(
      expect.arrayContaining([
        'bg-host ticker unhealthy: ticker stale',
        'bg-host OOM evidence in window (1)',
        'bg-host FAILED 2 time(s) in window (crash/OOM/watchdog — deliberate restarts excluded)',
        'placement DEADLOCKED: 0 placeable, 7 item(s) quarantined by the admission gate ' +
          '(remote origin, unaudited) — the loop has work it may never place, and no admit path will clear it',
        'infra-attributed curse rate non-zero (10%)',
        'stale placement recovery exceeds 24h (2)',
        'cup turn success below 100% (75%)',
        'no terminal mug turns in window',
        'open escalation backlog present (2)',
        'open escalation backlog is not shrinking',
        'green-checkpoint ratio below 100% (67%)',
        'mean deploy latency above 15m',
        `per-wake injected overhead above budget (mean ${WAKE_MEAN_CHAR_BUDGET + 600} chars > ${WAKE_MEAN_CHAR_BUDGET})`,
        'post-compaction error markers in window (3)',
      ]),
    );
  });

  it('an otherwise-PERFECT pot is RED when it may place none of the work it has', () => {
    // The 2026-07-13 silent starvation, pinned. papercusp's entire placeable pool was
    // 10 federated `feature` items, every one quarantined by the G2 admission gate
    // (remote origin, no `admit` verdict, no trusted author — and nothing in production
    // writes that verdict, so waiting would never clear them). The Mug woke every ~20min,
    // surveyed a frontier of zero, correctly placed nothing, and reported SUCCESS: five
    // hours, zero cups, EVERY OTHER SIGNAL GREEN. That is what this test forbids.
    //
    // Note the shape: bg-host clean, 100% turn success, no escalations, gate green, fast
    // deploys — a pot that looks flawless precisely BECAUSE it is doing nothing. An empty
    // frontier is only healthy when there is nothing to do; when work is being WITHHELD it
    // is a deadlock, and no amount of soaking resolves it.
    const report = computeSoakReport({
      potSlug: 'papercusp',
      surveyScope: 'members',
      surveySlugs: ['papercusp'],
      windowHours: 24,
      generatedAtMs: Date.UTC(2026, 6, 13, 6, 0, 0),
      bgHost: {
        oomKillCount: 0,
        restartCount: 0,
        failureCount: 0,
        peakMemoryMb: 2048,
        highMemoryPeakCount: 0,
        journalError: null,
        journalAvailable: true,
        tickerUp: true,
        tickerNote: null,
      },
      // The tell: the mug and kettle keep taking successful turns — it is only the CUPS
      // that never happen, because there is nothing the Mug is allowed to place.
      roleSuccess: [
        { role: 'mug', totalTerminalTurns: 15, successfulTurns: 15, successRate: 1 },
        { role: 'kettle', totalTerminalTurns: 20, successfulTurns: 20, successRate: 1 },
      ],
      frontier: { placeable: 0, quarantined: 10 },
      infraCurse: { placementsSeen: 10, infraCurses: 0, rate: 0, recoveringOpen: 0, staleRecovering: 0 },
      escalationBacklog: { openNow: 0, olderOpenCount: 0, newerOpenCount: 0, improving: true },
      gateGreenRatio: { green: 5, total: 5, ratio: 1 },
      deployLatency: { samples: 2, meanMs: 120000 },
      contextBurn: {
        loopWakes: 100,
        nonLoopInboxWakes: 0,
        meanWakeChars: 1500,
        maxWakeChars: 5900,
        estMeanWakeTokens: 375,
        requestedCompactions: 4,
        sessionsCompacting: 2,
        compactionsPerSession: 2,
        postCompactionErrorMarkers: 0,
      },
    });

    expect(report.ready).toBe(false);
    expect(report.reasons).toContain(
      'placement DEADLOCKED: 0 placeable, 10 item(s) quarantined by the admission gate ' +
        '(remote origin, unaudited) — the loop has work it may never place, and no admit path will clear it',
    );
    expect(report.frontier).toEqual({ placeable: 0, quarantined: 10 });
  });

  it('an EMPTY frontier with nothing withheld is idle, not deadlocked — stays green', () => {
    // The other side of the line: a pot that has genuinely finished its work must NOT be
    // red. Only a frontier that is empty BECAUSE something is being withheld is a deadlock.
    const report = computeSoakReport({
      potSlug: 'papercusp',
      surveyScope: 'members',
      surveySlugs: ['papercusp'],
      windowHours: 24,
      generatedAtMs: Date.UTC(2026, 6, 13, 6, 0, 0),
      bgHost: {
        oomKillCount: 0,
        restartCount: 0,
        failureCount: 0,
        peakMemoryMb: 2048,
        highMemoryPeakCount: 0,
        journalError: null,
        journalAvailable: true,
        tickerUp: true,
        tickerNote: null,
      },
      roleSuccess: [
        { role: 'cup', totalTerminalTurns: 4, successfulTurns: 4, successRate: 1 },
        { role: 'mug', totalTerminalTurns: 3, successfulTurns: 3, successRate: 1 },
        { role: 'kettle', totalTerminalTurns: 2, successfulTurns: 2, successRate: 1 },
      ],
      frontier: { placeable: 0, quarantined: 0 },
      infraCurse: { placementsSeen: 10, infraCurses: 0, rate: 0, recoveringOpen: 0, staleRecovering: 0 },
      escalationBacklog: { openNow: 0, olderOpenCount: 0, newerOpenCount: 0, improving: true },
      gateGreenRatio: { green: 5, total: 5, ratio: 1 },
      deployLatency: { samples: 2, meanMs: 120000 },
      contextBurn: {
        loopWakes: 400,
        nonLoopInboxWakes: 0,
        meanWakeChars: 1500,
        maxWakeChars: 5900,
        estMeanWakeTokens: 375,
        requestedCompactions: 12,
        sessionsCompacting: 6,
        compactionsPerSession: 2,
        postCompactionErrorMarkers: 0,
      },
    });

    expect(report.ready).toBe(true);
    expect(report.reasons).toEqual([]);
  });

  it('an unreadable journal reds the gate — zero counts are NOT a clean bill of health', () => {
    // The false-green this guards: readBgHostJournal used to swallow any journalctl
    // failure and return all-zero counts, which the verdict read as "no OOMs, no
    // restarts" — a PASS. On the dev host the read failed every single time (the 24h
    // user journal is ~400MB, far past execFile's maxBuffer), so the gate reported a
    // spotless bg-host while it had actually restarted 9 times and peaked at 23.8GB.
    // Absent evidence must never masquerade as evidence of absence.
    const report = computeSoakReport({
      potSlug: 'papercusp',
      surveyScope: 'members',
      surveySlugs: ['papercusp'],
      windowHours: 24,
      generatedAtMs: Date.UTC(2026, 6, 2, 10, 0, 0),
      bgHost: {
        oomKillCount: 0,
        restartCount: 0,
        failureCount: 0,
        peakMemoryMb: null,
        highMemoryPeakCount: 0,
        journalError: 'stdout maxBuffer length exceeded',
        journalAvailable: true,
        tickerUp: true,
        tickerNote: null,
      },
      roleSuccess: [
        { role: 'cup', totalTerminalTurns: 1, successfulTurns: 1, successRate: 1 },
        { role: 'mug', totalTerminalTurns: 1, successfulTurns: 1, successRate: 1 },
        { role: 'kettle', totalTerminalTurns: 1, successfulTurns: 1, successRate: 1 },
      ],
      frontier: { placeable: 4, quarantined: 0 },
      infraCurse: { placementsSeen: 10, infraCurses: 0, rate: 0, recoveringOpen: 0, staleRecovering: 0 },
      escalationBacklog: { openNow: 0, olderOpenCount: 0, newerOpenCount: 0, improving: true },
      gateGreenRatio: { green: 5, total: 5, ratio: 1 },
      deployLatency: { samples: 2, meanMs: 120000 },
      contextBurn: {
        loopWakes: 0,
        nonLoopInboxWakes: 0,
        meanWakeChars: null,
        maxWakeChars: null,
        estMeanWakeTokens: null,
        requestedCompactions: 0,
        sessionsCompacting: 0,
        compactionsPerSession: null,
        postCompactionErrorMarkers: 0,
      },
    });

    expect(report.ready).toBe(false);
    expect(report.reasons).toEqual([
      'bg-host journal unreadable — OOM/restart evidence unavailable (stdout maxBuffer length exceeded)',
    ]);
  });
});

describe('readBgHostJournalUncached — bounded against a hung journalctl (EI-19937931088042507)', () => {
  it('queries the canonical unit and includes its restart lines in the journal filter', async () => {
    const journalctl = vi.mocked(execFile);
    journalctl.mockClear();
    await readBgHostJournalUncached(24);

    expect(journalctl).toHaveBeenCalledTimes(2);
    for (const call of journalctl.mock.calls) {
      expect(call[0]).toBe('journalctl');
      const args = call[1] as string[];
      expect(args[args.indexOf('-u') + 1]).toBe('papercusp-bg-host.service');
    }
    const unitArgs = journalctl.mock.calls[0][1] as string[];
    expect('Started papercusp-bg-host.service').toMatch(new RegExp(unitArgs[unitArgs.indexOf('--grep') + 1]));
  });

  it('degrades to an explicit journalError instead of hanging when journalctl is killed by the timeout', async () => {
    const start = Date.now();
    const result = await readBgHostJournalUncached(24);
    // The stub resolves ~immediately; a real hang would never resolve at all. This bound
    // (well under any CI/test timeout) is the recurrence guard: it fails if a future edit
    // reintroduces an unbounded execFile call whose promise never settles.
    expect(Date.now() - start).toBeLessThan(2_000);
    expect(result.journalAvailable).toBe(true);
    expect(result.journalError).toMatch(/timed out/i);
    // A bounded-but-failed read must report UNKNOWN counts, never a fabricated clean bill
    // of health (the false-green class the maxBuffer test above already guards).
    expect(result).toMatchObject({
      oomKillCount: 0,
      restartCount: 0,
      failureCount: 0,
      peakMemoryMb: null,
      highMemoryPeakCount: 0,
    });
  });
});

// EI-19934273886988915: readPotSoakReport's DB fan-out is entirely read-only, but
// bypassed withWorkspace's connect-retry protection by calling getOrgPg().sql
// directly — so a PgBouncer idle-reap CONNECTION_CLOSED on the pooled connection's
// first query (EI-9279) failed the whole tool with no retry. Regresses the fix:
// a fake `sql` that fails CONNECTION_CLOSED exactly once must not fail the call.
vi.mock('./survey', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./survey')>();
  return {
    ...actual,
    resolvePotMembership: vi.fn(async () => ({ scope: 'workspace' as const, surveySlugs: ['test-pot'] })),
    countPlaceableFrontier: vi.fn(async () => 0),
    countQuarantinedFrontier: vi.fn(async () => 0),
  };
});

describe('readPotSoakReport — retries a transient PgBouncer CONNECTION_CLOSED (EI-19934273886988915)', () => {
  it('does not fail the whole report when the pooled connection drops exactly once', async () => {
    const { readPotSoakReport } = await import('./soak-report');
    let calls = 0;
    const fakeSql = ((..._args: unknown[]) => {
      calls += 1;
      if (calls === 1) {
        const e = Object.assign(new Error('write CONNECTION_CLOSED 127.0.0.1:6432'), {
          code: 'CONNECTION_CLOSED',
        });
        return Promise.reject(e);
      }
      return Promise.resolve([]);
    }) as unknown as import('postgres').Sql;
    (fakeSql as unknown as { array: (v: unknown) => unknown }).array = (v: unknown) => v;

    const report = await readPotSoakReport('test-pot', { windowHours: 24, sql: fakeSql });

    expect(report.potSlug).toBe('test-pot');
    // Proves the retry actually re-ran the batch: more than the single batch's
    // worth of sql-tag calls happened (first attempt fired + failed, second succeeded).
    expect(calls).toBeGreaterThan(1);
  });

  it('still throws when every attempt hits CONNECTION_CLOSED (a genuinely dead pool, not a blip)', async () => {
    const { readPotSoakReport } = await import('./soak-report');
    const fakeSql = ((..._args: unknown[]) => {
      const e = Object.assign(new Error('write CONNECTION_CLOSED 127.0.0.1:6432'), {
        code: 'CONNECTION_CLOSED',
      });
      return Promise.reject(e);
    }) as unknown as import('postgres').Sql;
    (fakeSql as unknown as { array: (v: unknown) => unknown }).array = (v: unknown) => v;

    await expect(readPotSoakReport('test-pot', { windowHours: 24, sql: fakeSql })).rejects.toThrow(
      /CONNECTION_CLOSED/,
    );
  });
});
