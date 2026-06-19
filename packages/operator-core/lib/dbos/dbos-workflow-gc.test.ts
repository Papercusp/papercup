import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  runDbosWorkflowGcOnce,
  dbosWorkflowGcEnabled,
  dbosWorkflowGcRetentionDays,
  DBOS_TERMINAL_STATUSES,
  type DbosGcDeps,
} from './dbos-workflow-gc';

afterEach(() => vi.unstubAllEnvs());

describe('terminal-status safety', () => {
  it('only ever targets terminal statuses (never PENDING/ENQUEUED)', () => {
    expect([...DBOS_TERMINAL_STATUSES]).toEqual(['SUCCESS', 'ERROR', 'MAX_RECOVERY_ATTEMPTS_EXCEEDED', 'CANCELLED']);
    expect(DBOS_TERMINAL_STATUSES as readonly string[]).not.toContain('PENDING');
    expect(DBOS_TERMINAL_STATUSES as readonly string[]).not.toContain('ENQUEUED');
  });
});

describe('env knobs', () => {
  it('default-OFF; armed only by PAPERCUSP_DBOS_WORKFLOW_GC=1', () => {
    vi.unstubAllEnvs();
    expect(dbosWorkflowGcEnabled()).toBe(false);
    vi.stubEnv('PAPERCUSP_DBOS_WORKFLOW_GC', '1');
    expect(dbosWorkflowGcEnabled()).toBe(true);
  });
  it('retention defaults 14d, env-tunable', () => {
    vi.unstubAllEnvs();
    expect(dbosWorkflowGcRetentionDays()).toBe(14);
    vi.stubEnv('PAPERCUSP_DBOS_WORKFLOW_GC_DAYS', '30');
    expect(dbosWorkflowGcRetentionDays()).toBe(30);
  });
});

describe('runDbosWorkflowGcOnce', () => {
  it('disabled → skipped, runs NO queries', async () => {
    const deps: DbosGcDeps = {
      selectTerminalVictims: vi.fn(async () => []),
      deleteOutputs: vi.fn(async () => 0),
      deleteWorkflows: vi.fn(async () => 0),
    };
    const r = await runDbosWorkflowGcOnce({ enabled: false, deps });
    expect(r).toMatchObject({ skipped: true, deletedWorkflows: 0, deletedOutputs: 0 });
    expect(deps.selectTerminalVictims).not.toHaveBeenCalled();
  });

  it('enabled: deletes a sub-batch, outputs BEFORE workflows (FK order), computes cutoff', async () => {
    const calls: string[] = [];
    let served = false;
    const deps: DbosGcDeps = {
      selectTerminalVictims: async () => {
        calls.push('select');
        if (served) return [];
        served = true;
        return ['a', 'b'];
      },
      deleteOutputs: async (ids) => { calls.push(`outputs:${ids.join(',')}`); return ids.length; },
      deleteWorkflows: async (ids) => { calls.push(`workflows:${ids.join(',')}`); return ids.length; },
    };
    const r = await runDbosWorkflowGcOnce({ enabled: true, retentionDays: 14, batchLimit: 5000, nowMs: 1_000_000_000_000, deps });
    expect(r.skipped).toBe(false);
    expect(r.deletedOutputs).toBe(2);
    expect(r.deletedWorkflows).toBe(2);
    expect(r.cutoffMs).toBe(1_000_000_000_000 - 14 * 86_400_000);
    const oi = calls.indexOf('outputs:a,b');
    const wi = calls.indexOf('workflows:a,b');
    expect(oi).toBeGreaterThanOrEqual(0);
    expect(wi).toBeGreaterThan(oi); // operation_outputs deleted before workflow_status
  });

  it('enabled: loops across a FULL batch then stops on a short/empty batch', async () => {
    let call = 0;
    const deps: DbosGcDeps = {
      selectTerminalVictims: async () => { call++; return call === 1 ? ['a', 'b'] : []; },
      deleteOutputs: async (ids) => ids.length,
      deleteWorkflows: async (ids) => ids.length,
    };
    const r = await runDbosWorkflowGcOnce({ enabled: true, batchLimit: 2, nowMs: 0, deps });
    expect(call).toBe(2); // batch1 (==limit) → continue; batch2 (empty) → break
    expect(r.batches).toBe(1);
    expect(r.deletedWorkflows).toBe(2);
  });
});
