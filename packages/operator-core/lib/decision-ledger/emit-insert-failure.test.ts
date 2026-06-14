/**
 * Unit tests for the decision-ledger INSERT failure path (EI-499).
 *
 * The emit is fire-and-forget bookkeeping (never throws, never blocks the trigger).
 * When the `harness_shared.decision_ledger` table is absent — the expected state in
 * isolated test/e2e PG fixtures that run no migrations — the INSERT fails with PG
 * `42P01` (undefined_table). That MUST be swallowed silently: otherwise
 * `vitest-fail-on-console` reds every e2e that drives a governed dispatch. A REAL
 * insert failure (any other error) must still warn loudly.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The INSERT path reads a flag (default-ON kill-switch) and opens the org PG.
// Mock both so the impl reaches the catch block deterministically with no real PG.
const insertError = vi.hoisted(() => ({ current: null as Error | null }));

// Partial mocks (importOriginal) — keep every real export the import chain needs
// (e.g. db-org's `generated`), override only the two seams the INSERT path touches.
vi.mock('@papercusp/flags/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/flags/server')>()),
  getFlag: vi.fn(async () => true),
}));

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({
    sql: {
      // Faithful: begin invokes the callback with a tx whose INSERT throws — the
      // same shape as a real missing-table transaction (set_config succeeds first).
      begin: async (cb: (tx: { unsafe: (q: string) => Promise<unknown> }) => Promise<unknown>) =>
        cb({
          unsafe: async (q: string) => {
            if (q.includes('INSERT INTO harness_shared.decision_ledger')) {
              if (insertError.current) throw insertError.current;
            }
            return undefined;
          },
        }),
    },
  }),
}));

import { recordDecisionLedger } from './emit';
import type { PostInvokeEvent } from '@papercusp/agent-mcp';

/** A governed write event (tier medium) so buildDecisionLedgerRow returns a row. */
function governedEvent(): PostInvokeEvent {
  return {
    toolName: 'plans.set-status',
    pluginName: 'agent-mcp',
    args: { slug: 'p', status: 'wip' },
    result: { ok: true, result: { content: [] } },
    ctx: {
      workspaceId: 'default',
      harnessSlug: 'papercup',
      role: 'worker',
      runId: 'run_1',
      spawnId: 'spw_1',
    } as PostInvokeEvent['ctx'],
    durationMs: 42,
    capabilities: ['plans:write'],
    envelopeVerdict: undefined,
  };
}

/** recordDecisionLedger is fire-and-forget — flush the microtask + catch chain. */
async function flush(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

describe('recordDecisionLedger — INSERT failure (EI-499)', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
    insertError.current = null;
  });

  it('swallows 42P01 (undefined_table — decision_ledger absent in test PG) without warning', async () => {
    const err = new Error('relation "harness_shared.decision_ledger" does not exist') as Error & {
      code?: string;
    };
    err.code = '42P01';
    insertError.current = err;

    recordDecisionLedger(governedEvent());
    await flush();

    expect(warn).not.toHaveBeenCalled();
  });

  it('warns loudly on a real insert failure (any non-42P01 error)', async () => {
    const err = new Error('null value in column "action" violates not-null constraint') as Error & {
      code?: string;
    };
    err.code = '23502'; // not_null_violation — a genuine bug, not an absent table
    insertError.current = err;

    recordDecisionLedger(governedEvent());
    await flush();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('[decision-ledger] insert failed');
  });
});
