import { describe, expect, it } from 'vitest';
import { WAKE_MEAN_CHAR_BUDGET, computeSoakReport, parseBgHostGlobalJournal, parseBgHostUnitJournal } from './soak-report';

describe('parseBgHostUnitJournal', () => {
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
      peakMemoryMb: 6656,
      highMemoryPeakCount: 1,
      journalError: null,
    });
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
        restartCount: 0,
        peakMemoryMb: 2048,
        highMemoryPeakCount: 0,
        journalError: null,
        tickerUp: true,
        tickerNote: null,
      },
      roleSuccess: [
        { role: 'cup', totalTerminalTurns: 4, successfulTurns: 4, successRate: 1 },
        { role: 'mug', totalTerminalTurns: 3, successfulTurns: 3, successRate: 1 },
        { role: 'kettle', totalTerminalTurns: 2, successfulTurns: 2, successRate: 1 },
      ],
      infraCurse: { placementsSeen: 10, infraCurses: 0, rate: 0 },
      escalationBacklog: { openNow: 0, olderOpenCount: 0, newerOpenCount: 0, improving: true },
      gateGreenRatio: { green: 5, total: 5, ratio: 1 },
      deployLatency: { samples: 2, meanMs: 120000 },
      contextBurn: {
        loopWakes: 400,
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
      bgHost: { oomKillCount: 0, restartCount: 0, peakMemoryMb: null, highMemoryPeakCount: 0, journalError: null, tickerUp: true, tickerNote: null },
      roleSuccess: [
        { role: 'cup', totalTerminalTurns: 1, successfulTurns: 1, successRate: 1 },
        { role: 'mug', totalTerminalTurns: 1, successfulTurns: 1, successRate: 1 },
        { role: 'kettle', totalTerminalTurns: 1, successfulTurns: 1, successRate: 1 },
      ],
      infraCurse: { placementsSeen: 10, infraCurses: 0, rate: 0 },
      escalationBacklog: { openNow: 0, olderOpenCount: 0, newerOpenCount: 0, improving: true },
      gateGreenRatio: { green: 5, total: 5, ratio: 1 },
      deployLatency: { samples: 2, meanMs: 120000 },
      contextBurn: {
        loopWakes: 0,
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
        peakMemoryMb: 8192,
        highMemoryPeakCount: 2,
        journalError: null,
        tickerUp: false,
        tickerNote: 'ticker stale',
      },
      roleSuccess: [
        { role: 'cup', totalTerminalTurns: 4, successfulTurns: 3, successRate: 0.75 },
        { role: 'mug', totalTerminalTurns: 0, successfulTurns: 0, successRate: null },
        { role: 'kettle', totalTerminalTurns: 1, successfulTurns: 1, successRate: 1 },
      ],
      infraCurse: { placementsSeen: 10, infraCurses: 1, rate: 0.1 },
      escalationBacklog: { openNow: 2, olderOpenCount: 0, newerOpenCount: 2, improving: false },
      gateGreenRatio: { green: 2, total: 3, ratio: 2 / 3 },
      deployLatency: { samples: 1, meanMs: 20 * 60_000 },
      contextBurn: {
        loopWakes: 900,
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
        'bg-host restarted 2 time(s) in window',
        'infra-attributed curse rate non-zero (10%)',
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
        peakMemoryMb: null,
        highMemoryPeakCount: 0,
        journalError: 'stdout maxBuffer length exceeded',
        tickerUp: true,
        tickerNote: null,
      },
      roleSuccess: [
        { role: 'cup', totalTerminalTurns: 1, successfulTurns: 1, successRate: 1 },
        { role: 'mug', totalTerminalTurns: 1, successfulTurns: 1, successRate: 1 },
        { role: 'kettle', totalTerminalTurns: 1, successfulTurns: 1, successRate: 1 },
      ],
      infraCurse: { placementsSeen: 10, infraCurses: 0, rate: 0 },
      escalationBacklog: { openNow: 0, olderOpenCount: 0, newerOpenCount: 0, improving: true },
      gateGreenRatio: { green: 5, total: 5, ratio: 1 },
      deployLatency: { samples: 2, meanMs: 120000 },
      contextBurn: {
        loopWakes: 0,
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
