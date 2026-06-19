/**
 * dead-workflow-monitor.test.ts — the pure summarizer for F4
 * (infra-perf-reliability-audit-2026-06-19). Pins that scheduled-workflow instances
 * (fresh uuid + sched-.<name>-<timestamp> per fire) roll up to one row per
 * (name, status), so 171 systemHealth fires read as one line, not 171.
 */
import { describe, expect, it } from 'vitest';
import { summarizeDeadWorkflows } from './dead-workflow-monitor';

describe('summarizeDeadWorkflows (F4)', () => {
  it('rolls scheduled instances up by name (strips sched-. prefix + -<timestamp> suffix)', () => {
    const rows = [
      { name: 'sched-.systemHealth-2026-06-19T01:40:00.000Z', status: 'MAX_RECOVERY_ATTEMPTS_EXCEEDED', updated_at: 100 },
      { name: 'sched-.systemHealth-2026-06-19T02:10:00.000Z', status: 'MAX_RECOVERY_ATTEMPTS_EXCEEDED', updated_at: 300 },
      { name: 'sched-.embedBackfill-2026-06-19T01:50:00.000Z', status: 'MAX_RECOVERY_ATTEMPTS_EXCEEDED', updated_at: 200 },
    ];
    const out = summarizeDeadWorkflows(rows);
    const sysHealth = out.find((s) => s.name === 'systemHealth');
    expect(sysHealth).toBeDefined();
    expect(sysHealth!.count).toBe(2); // two fires rolled up
    expect(sysHealth!.latestMs).toBe(300); // newest retained
    expect(out.find((s) => s.name === 'embedBackfill')!.count).toBe(1);
  });

  it('keeps different statuses of the same name separate, sorted by count desc', () => {
    const rows = [
      { name: 'durableSpawnFire-2026-06-19T01:00:00Z', status: 'ERROR', updated_at: 1 },
      { name: 'durableSpawnFire-2026-06-19T02:00:00Z', status: 'ERROR', updated_at: 2 },
      { name: 'durableSpawnFire-2026-06-19T03:00:00Z', status: 'ERROR', updated_at: 3 },
      { name: 'routineFire-2026-06-19T01:00:00Z', status: 'MAX_RECOVERY_ATTEMPTS_EXCEEDED', updated_at: 5 },
    ];
    const out = summarizeDeadWorkflows(rows);
    expect(out[0]).toMatchObject({ name: 'durableSpawnFire', status: 'ERROR', count: 3 }); // most → first
    expect(out[1]).toMatchObject({ name: 'routineFire', status: 'MAX_RECOVERY_ATTEMPTS_EXCEEDED', count: 1 });
  });

  it('handles null names + string timestamps; empty input → empty', () => {
    expect(summarizeDeadWorkflows([])).toEqual([]);
    const out = summarizeDeadWorkflows([{ name: null, status: 'ERROR', updated_at: '42' }]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ name: 'unknown', status: 'ERROR', count: 1, latestMs: 42 });
  });
});
