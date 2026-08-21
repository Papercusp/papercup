/**
 * stale-routine-executor-watchdog.test.ts — EI-19409061552037718. Pure decider
 * only (no DB, no git, no DBOS) — the sweep's PG/paging orchestration mirrors
 * release-deploy-staleness-watchdog.ts's already-tested shape byte-for-byte and
 * is exercised indirectly via those siblings; this file is the DISCRIMINATION
 * bar for the actual judgment call: healthy-not-enabled, healthy-under-uptime,
 * healthy-unresolvable (fail-safe), healthy-unchanged-commit, and the one true
 * stale case.
 */
import { describe, expect, it } from 'vitest';

import {
  evaluateExecutorStaleness,
  executorAlarmContext,
  executorIdentity,
  staleExecutorThresholdSec,
} from './stale-routine-executor-watchdog';
import { captureProcessBootIdentity, processBootTimeMs } from '../../dbos/process-boot-identity';

const TWO_H = 2 * 3_600_000;
const BOOT = 1_000_000;

describe('process boot identity — import timing cannot reset executor age', () => {
  it('derives boot time from process.uptime(), not from the lazy watchdog module load', () => {
    const now = Date.now();
    const boot = processBootTimeMs();
    const uptimeMs = process.uptime() * 1000;

    expect(boot).toBeLessThanOrEqual(now);
    // Allow a small scheduling window between the two uptime/clock reads while
    // still rejecting a module-load timestamp on a long-lived test process.
    expect(Math.abs(now - boot - uptimeMs)).toBeLessThan(2_000);
  });

  it('starts the boot-commit sample when the identity is captured', async () => {
    let resolveCalls = 0;
    const identity = captureProcessBootIdentity({
      nowMs: 5_000,
      uptimeSec: 2,
      resolveCommit: async () => {
        resolveCalls += 1;
        return 'a'.repeat(40);
      },
    });

    expect(resolveCalls).toBe(1);
    expect(identity.bootTimeMs).toBe(3_000);
    await expect(identity.bootCommit).resolves.toBe('a'.repeat(40));
  });
});

describe('evaluateExecutorStaleness — the pure decider', () => {
  it('healthy when PAPERCUSP_DBOS_ROUTINES is not enabled on this process', () => {
    const v = evaluateExecutorStaleness({
      routinesEnabled: false,
      bootCommit: 'a'.repeat(40),
      currentCommit: 'b'.repeat(40),
      bootTimeMs: BOOT,
      now: BOOT + TWO_H * 10,
      thresholdMs: TWO_H,
    });
    expect(v.stale).toBe(false);
    expect(v.reason).toContain('not enabled');
  });

  it('healthy on the kill switch (thresholdMs <= 0)', () => {
    const v = evaluateExecutorStaleness({
      routinesEnabled: true,
      bootCommit: 'a'.repeat(40),
      currentCommit: 'b'.repeat(40),
      bootTimeMs: BOOT,
      now: BOOT + TWO_H * 10,
      thresholdMs: 0,
    });
    expect(v.stale).toBe(false);
    expect(v.reason).toContain('kill switch');
  });

  it('healthy under the uptime threshold, even with a commit divergence', () => {
    const v = evaluateExecutorStaleness({
      routinesEnabled: true,
      bootCommit: 'a'.repeat(40),
      currentCommit: 'b'.repeat(40),
      bootTimeMs: BOOT,
      now: BOOT + TWO_H / 2,
      thresholdMs: TWO_H,
    });
    expect(v.stale).toBe(false);
    expect(v.reason).toContain('under the');
  });

  it('fails SAFE (not stale) when either commit is unresolvable — never alert on an unreadable git state', () => {
    const v1 = evaluateExecutorStaleness({
      routinesEnabled: true,
      bootCommit: null,
      currentCommit: 'b'.repeat(40),
      bootTimeMs: BOOT,
      now: BOOT + TWO_H * 10,
      thresholdMs: TWO_H,
    });
    expect(v1.stale).toBe(false);
    expect(v1.reason).toContain('unresolvable');

    const v2 = evaluateExecutorStaleness({
      routinesEnabled: true,
      bootCommit: 'a'.repeat(40),
      currentCommit: null,
      bootTimeMs: BOOT,
      now: BOOT + TWO_H * 10,
      thresholdMs: TWO_H,
    });
    expect(v2.stale).toBe(false);
    expect(v2.reason).toContain('unresolvable');
  });

  it('healthy past the threshold when the boot commit still matches tree HEAD — nothing has moved', () => {
    const sha = 'c'.repeat(40);
    const v = evaluateExecutorStaleness({
      routinesEnabled: true,
      bootCommit: sha,
      currentCommit: sha,
      bootTimeMs: BOOT,
      now: BOOT + TWO_H * 10,
      thresholdMs: TWO_H,
    });
    expect(v.stale).toBe(false);
    expect(v.reason).toContain('nothing has moved');
  });

  it('STALE past the threshold with a genuine boot-commit-vs-HEAD divergence — reports code drift and restart, not a claim race', () => {
    const boot = 'd'.repeat(40);
    const head = 'e'.repeat(40);
    const now = BOOT + 7 * 3_600_000; // 7h uptime, matches the measured incident
    const v = evaluateExecutorStaleness({
      routinesEnabled: true,
      bootCommit: boot,
      currentCommit: head,
      bootTimeMs: BOOT,
      now,
      thresholdMs: TWO_H,
    });
    expect(v.stale).toBe(true);
    expect(v.reason).toContain(boot.slice(0, 10));
    expect(v.reason).toContain(head.slice(0, 10));
    expect(v.reason).toContain('EI-19409061552037718');
    expect(v.reason).toContain('7h');
    expect(v.reason).toContain('not loaded by this process');
    expect(v.reason).toContain('Restart this host');
    expect(v.reason).not.toContain('claim race');
    expect(v.reason).not.toContain('HALF-APPLIED');
    expect(v.ageMs).toBe(now - BOOT);
  });
});

describe('staleExecutorThresholdSec — env tunable', () => {
  it('defaults to 2h (7200s) with no env override', () => {
    const saved = process.env.PAPERCUSP_STALE_ROUTINE_EXECUTOR_THRESHOLD_SEC;
    delete process.env.PAPERCUSP_STALE_ROUTINE_EXECUTOR_THRESHOLD_SEC;
    try {
      expect(staleExecutorThresholdSec()).toBe(7_200);
    } finally {
      if (saved !== undefined) process.env.PAPERCUSP_STALE_ROUTINE_EXECUTOR_THRESHOLD_SEC = saved;
    }
  });

  it('honors an env override, including a <=0 kill switch', () => {
    const saved = process.env.PAPERCUSP_STALE_ROUTINE_EXECUTOR_THRESHOLD_SEC;
    try {
      process.env.PAPERCUSP_STALE_ROUTINE_EXECUTOR_THRESHOLD_SEC = '0';
      expect(staleExecutorThresholdSec()).toBe(0);
      process.env.PAPERCUSP_STALE_ROUTINE_EXECUTOR_THRESHOLD_SEC = '3600';
      expect(staleExecutorThresholdSec()).toBe(3_600);
    } finally {
      if (saved !== undefined) process.env.PAPERCUSP_STALE_ROUTINE_EXECUTOR_THRESHOLD_SEC = saved;
      else delete process.env.PAPERCUSP_STALE_ROUTINE_EXECUTOR_THRESHOLD_SEC;
    }
  });
});

describe('executorIdentity — a stable per-process key that never conflates two hosts', () => {
  it('prefers PAPERCUSP_HONO_PORT / PORT so the SAME logical service recovers its own alert across restarts', () => {
    const savedHono = process.env.PAPERCUSP_HONO_PORT;
    const savedPort = process.env.PORT;
    try {
      delete process.env.PAPERCUSP_HONO_PORT;
      process.env.PORT = '3270';
      expect(executorIdentity()).toBe('port-3270');

      process.env.PAPERCUSP_HONO_PORT = '3070';
      expect(executorIdentity()).toBe('port-3070'); // PAPERCUSP_HONO_PORT wins over PORT
    } finally {
      if (savedHono !== undefined) process.env.PAPERCUSP_HONO_PORT = savedHono;
      else delete process.env.PAPERCUSP_HONO_PORT;
      if (savedPort !== undefined) process.env.PORT = savedPort;
      else delete process.env.PORT;
    }
  });

  it('falls back to a pid-scoped identity when no port is resolvable, never colliding two distinct processes', () => {
    const savedHono = process.env.PAPERCUSP_HONO_PORT;
    const savedPort = process.env.PORT;
    try {
      delete process.env.PAPERCUSP_HONO_PORT;
      delete process.env.PORT;
      expect(executorIdentity()).toBe(`pid-${process.pid}`);
    } finally {
      if (savedHono !== undefined) process.env.PAPERCUSP_HONO_PORT = savedHono;
      if (savedPort !== undefined) process.env.PORT = savedPort;
    }
  });
});

describe('executorAlarmContext — identify the owning service before suggesting remediation', () => {
  it('names bg-host service and the sanctioned restart lever instead of presenting a bare worker identity', () => {
    const context = executorAlarmContext('port-3271');

    expect(context.unit).toBe('papercup-bg-host.service');
    expect(context.identityLabel).toContain('papercup-bg-host.service');
    expect(context.identityLabel).toContain('executor identity port-3271');
    expect(context.restartLever).toBe("dev:restart { target: 'bg-host', confirm: true }");
    expect(context.identityLabel).not.toMatch(/^pid-/);
  });

  it('keeps an unresolvable PID identity explicit rather than turning it into a kill instruction', () => {
    const savedUnit = process.env.PAPERCUSP_SYSTEMD_UNIT;
    delete process.env.PAPERCUSP_SYSTEMD_UNIT;
    try {
      const context = executorAlarmContext('pid-1690541');

      expect(context.unit).toBe('systemd unit unresolved');
      expect(context.identityLabel).toContain('systemd unit unresolved');
      expect(context.restartLever).toContain('resolve the owning service');
    } finally {
      if (savedUnit !== undefined) process.env.PAPERCUSP_SYSTEMD_UNIT = savedUnit;
    }
  });
});
