/**
 * Handler-level tests for the `system:improvement-implement` action — the
 * exhausted⇒leader-triage flip (self-improvement-consume-edges-2026-06-12 P-012;
 * routing target changed from the owner inbox to leader triage in P-004/WI-5679).
 *
 * The pure decision (which items are exhausted) is plan-implement.test.ts; the
 * flip semantics (comment + status='blocked' + release) is resolve-core.test.ts. This
 * file proves the ROUTINE wires them: every tick, whatever the plan action,
 * each attempts-exhausted item goes through the flip seam — the silent-worker-
 * death case finally leaves the auto lane.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The routine reads its risk-tier policy via readAutoImplementPolicy → readOperatorState, which
// opens a real PG pool [EI-19311807188719573]. Stub the STORE, not the policy: `null` = "nothing
// stored", so readAutoImplementPolicy still computes the genuine DEFAULT_RISK_TIER_POLICY merge
// under test rather than a hand-written shape that would silently drift from the real defaults.
vi.mock('../../operator-state-pg', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../operator-state-pg')>()),
  readOperatorState: vi.fn(async () => null),
  writeOperatorState: vi.fn(async () => {}),
  updateOperatorState: vi.fn(async () => {}),
}));
vi.mock('../improvements/read-items', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../improvements/read-items')>()),
  readImprovementItems: vi.fn(async () => []),
}));
vi.mock('@papercusp/flags/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/flags/server')>()),
  getFlag: vi.fn(async () => false),
}));
vi.mock('../../blueprint/launch-blueprint', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../blueprint/launch-blueprint')>()),
  buildLaunchSpawnRequest: vi.fn(async (_blueprintId: string, _input: unknown, idempotencyKey: string) => ({
    url: 'http://x/invoke?role=worker',
    body: { kickoff: 'go' },
    idempotencyKey,
    label: 'h/worker',
  })),
}));

// Importing the module registers the improvement actions.
import {
  setImprovementDispatchLedger,
  setImprovementExhaustedFlip,
  setImprovementImplementFire,
  setImprovementMarkDispatched,
} from './improvement-actions';
import { getSystemAction } from './system-actions';
import { readImprovementItems } from '../improvements/read-items';
import { getFlag } from '@papercusp/flags/server';
import { buildLaunchSpawnRequest } from '../../blueprint/launch-blueprint';
import type { ImprovementCandidate } from '../improvements/policy';
import type { ScoredItem } from '../improvements/digest';
import { LEARNING_MODEL_SPEC } from '../../learning/model-policy';
import type { RecordDispatchInput, FireResultUpdate } from '../improvements/dispatch-ledger';

const ctx = { installSlug: 'papercup', workspaceId: 'ws-1', triggerConfig: {}, payloadTemplate: null };
const run = () => getSystemAction('improvement-implement')!(ctx as never);

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

function cand(p: Partial<ImprovementCandidate> & { id: string }): ImprovementCandidate {
  return { kind: 'bug', scope: 'operator', title: `bug ${p.id}`, state: 'open', severity: 'major', ...p };
}

let flipped: ScoredItem[];
let dispatched: ScoredItem[];
let ledgerFired: RecordDispatchInput[];
let ledgerResults: Array<{ dispatchId: string; result: FireResultUpdate }>;
let log: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  flipped = [];
  dispatched = [];
  ledgerFired = [];
  ledgerResults = [];
  setImprovementExhaustedFlip(async (item) => {
    flipped.push(item);
  });
  setImprovementMarkDispatched(async (item) => {
    dispatched.push(item);
    return true;
  });
  setImprovementImplementFire(async () => {});
  // ALWAYS stub the dispatch ledger here — the default is PG-backed and
  // swallow-on-failure, so without this a unit-test dispatch silently writes
  // REAL improvement_dispatches rows on a box with a live PG.
  setImprovementDispatchLedger({
    recordDispatchFired: async (input) => {
      ledgerFired.push(input);
      return `d-${ledgerFired.length}`;
    },
    recordFireResult: async (dispatchId, result) => {
      ledgerResults.push({ dispatchId, result });
    },
  });
  process.env.PAPERCUSP_IMPROVEMENT_RUNNER_HARNESS = 'improvement-runner-harness';
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  setImprovementExhaustedFlip(null);
  setImprovementMarkDispatched(null);
  setImprovementImplementFire(null);
  setImprovementDispatchLedger(null);
  delete process.env.PAPERCUSP_IMPROVEMENT_RUNNER_HARNESS;
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('system:improvement-implement — exhausted⇒needs-human flip (consume-edges P-012)', () => {
  it('SILENT WORKER DEATH: a stale-claimed exhausted item is flipped; a dispatchable one still dispatches', async () => {
    vi.mocked(getFlag).mockResolvedValue(true as never);
    vi.mocked(readImprovementItems).mockResolvedValue([
      // 3/3 attempts, claim went stale 4h ago, no resolve ever recorded → flip.
      cand({ id: 'EI-DEAD', attempts: 3, assignee: 'improvement-runner', assignedAt: hoursAgo(4) }),
      // Fresh work → the normal dispatch path is untouched.
      cand({ id: 'EI-LIVE', attempts: 0 }),
    ] as never);

    await run();

    expect(flipped.map((s) => s.id)).toEqual(['EI-DEAD']);
    expect(dispatched.map((s) => s.id)).toEqual(['EI-LIVE']);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/EI-DEAD.*no resolve recorded.*human tier/));
  });

  it('an exhausted item whose FINAL claim is still fresh is NOT flipped (the worker may yet resolve)', async () => {
    vi.mocked(getFlag).mockResolvedValue(true as never);
    vi.mocked(readImprovementItems).mockResolvedValue([
      cand({ id: 'EI-FINAL', attempts: 3, assignee: 'improvement-runner', assignedAt: hoursAgo(0.5) }),
    ] as never);

    await run();

    expect(flipped).toEqual([]);
    expect(dispatched).toEqual([]);
  });

  it('flips even when the flag is OFF — a disarmed lane still surfaces its strays', async () => {
    vi.mocked(getFlag).mockResolvedValue(false as never);
    vi.mocked(readImprovementItems).mockResolvedValue([
      cand({ id: 'EI-STRAY', attempts: 3, assignee: 'improvement-runner', assignedAt: hoursAgo(48) }),
    ] as never);

    await run();

    expect(flipped.map((s) => s.id)).toEqual(['EI-STRAY']);
    expect(dispatched).toEqual([]); // disabled — nothing fires
  });

  it('a flip failure never blocks the dispatch loop (best-effort per item)', async () => {
    vi.mocked(getFlag).mockResolvedValue(true as never);
    vi.mocked(readImprovementItems).mockResolvedValue([
      cand({ id: 'EI-DEAD', attempts: 3, assignee: 'improvement-runner', assignedAt: hoursAgo(4) }),
      cand({ id: 'EI-LIVE', attempts: 0 }),
    ] as never);
    setImprovementExhaustedFlip(async () => {
      throw new Error('PG hiccup');
    });

    await run();

    expect(dispatched.map((s) => s.id)).toEqual(['EI-LIVE']); // dispatch survived the flip failure
  });
});

describe('system:improvement-implement — dispatch ledger write path (consume-edges P-010 / B-04)', () => {
  const arm = (...items: ImprovementCandidate[]) => {
    vi.mocked(getFlag).mockResolvedValue(true as never);
    vi.mocked(readImprovementItems).mockResolvedValue(items as never);
  };

  it('records a ledger row per dispatch (item, 1-based attempt, runner) and the fire ok with the spawn correlation', async () => {
    arm(cand({ id: 'EI-1', attempts: 1 }));
    setImprovementImplementFire(async () => ({ spawnedRunId: 'launch-123-abc' }));

    await run();

    expect(ledgerFired).toEqual([
      // potSlug is null for an operator-scoped item (cand() defaults scope:'operator') —
      // the P-012 per-hive dispatch stamp only resolves for `harness:` scopes.
      { workspaceId: 'ws-1', itemId: 'EI-1', attempt: 2, runnerHarness: 'improvement-runner-harness', potSlug: null },
    ]);
    expect(ledgerResults).toEqual([{ dispatchId: 'd-1', result: { ok: true, spawnedRunId: 'launch-123-abc' } }]);
  });

  it('a fire seam that returns void still closes the fire as ok — spawned_run_id just stays null', async () => {
    arm(cand({ id: 'EI-1', attempts: 0 }));
    setImprovementImplementFire(async () => {});

    await run();

    expect(ledgerResults).toEqual([{ dispatchId: 'd-1', result: { ok: true, spawnedRunId: null } }]);
  });

  it('FIRE FAILURE is terminal in the ledger and does NOT abort the loop — the next candidate still dispatches', async () => {
    // Two candidates must enter the loop — the default per-run cap is 1.
    process.env.PAPERCUSP_IMPROVEMENT_MAX_PER_RUN = '5';
    try {
      arm(cand({ id: 'EI-BOOM', attempts: 0 }), cand({ id: 'EI-NEXT', attempts: 0 }));
      let calls = 0;
      setImprovementImplementFire(async () => {
        calls += 1;
        if (calls === 1) throw new Error('invoke route down');
      });

      await run();

      expect(dispatched.map((s) => s.id)).toEqual(['EI-BOOM', 'EI-NEXT']); // both claimed
      expect(ledgerFired.map((f) => f.itemId)).toEqual(['EI-BOOM', 'EI-NEXT']); // both recorded
      expect(ledgerResults).toEqual([
        { dispatchId: 'd-1', result: { ok: false, error: 'invoke route down' } },
        { dispatchId: 'd-2', result: { ok: true, spawnedRunId: null } },
      ]);
    } finally {
      delete process.env.PAPERCUSP_IMPROVEMENT_MAX_PER_RUN;
    }
  });

  it('EI-403-A: collects the fire seam durableSpawn requests and returns them as the action result', async () => {
    arm(cand({ id: 'EI-1', attempts: 1 }));
    const req = { url: 'http://x/invoke?role=worker', body: { kickoff: 'go' }, idempotencyKey: 'implement:EI-1:2', label: 'h/worker' };
    setImprovementImplementFire(async () => ({ spawnedRunId: `durable-spawn:${req.idempotencyKey}`, durableSpawn: req }));

    const result = await run();

    // The routine workflow starts this child after the step. Until its enqueue
    // succeeds the dispatch ledger stays pending, not optimistically accepted.
    expect(result).toEqual({ durableSpawns: [req] });
    expect(ledgerResults).toEqual([]);
  });

  it('EI-403-A: returns void when the fire seam yields no durableSpawn (disarmed / void seam)', async () => {
    arm(cand({ id: 'EI-1', attempts: 0 }));
    setImprovementImplementFire(async () => {});

    await expect(run()).resolves.toBeUndefined();
  });

  it('a ledger insert that failed (null id) skips the fire-result write without crashing the dispatch', async () => {
    arm(cand({ id: 'EI-1', attempts: 0 }));
    setImprovementDispatchLedger({
      recordDispatchFired: async (input) => {
        ledgerFired.push(input);
        return null; // PG write failed — swallowed + warned by the real impl
      },
      recordFireResult: async (dispatchId, result) => {
        ledgerResults.push({ dispatchId, result });
      },
    });

    await run();

    expect(dispatched.map((s) => s.id)).toEqual(['EI-1']); // the dispatch itself proceeded
    expect(ledgerResults).toEqual([]); // nothing to update — no row id
  });
});

describe('system:improvement-implement — claim-took-hold guard (EI-18123303195363852)', () => {
  // dispatch-orphan-rate regression: a claim that silently no-ops (0 rows — e.g. a
  // federated origin='remote' item the engineer_issues view guard refuses to write,
  // EI-7833) must never be followed by firing a worker anyway — that worker can never
  // report back, so it just re-queues and eventually orphans with no recorded cause.
  const arm = (...items: ImprovementCandidate[]) => {
    vi.mocked(getFlag).mockResolvedValue(true as never);
    vi.mocked(readImprovementItems).mockResolvedValue(items as never);
  };

  it('markDispatched resolving false skips the fire AND the dispatch ledger entirely', async () => {
    arm(cand({ id: 'EI-NOCLAIM', attempts: 0 }));
    setImprovementMarkDispatched(async () => false); // claim did not take (0 rows)
    let fireCalls = 0;
    setImprovementImplementFire(async () => {
      fireCalls += 1;
    });

    await run();

    expect(fireCalls).toBe(0); // never fire a worker for a claim that didn't take
    expect(ledgerFired).toEqual([]); // no dispatch-ledger row recorded either
    expect(ledgerResults).toEqual([]);
    expect(log).not.toHaveBeenCalledWith(expect.stringMatching(/^\[improvement-implement\] EI-NOCLAIM.*$/));
    // warned, not thrown — an honest, logged no-dispatch beats a silent doomed one.
    expect(vi.mocked(console.warn)).toHaveBeenCalledWith(
      expect.stringMatching(/claim did not take for EI-NOCLAIM/),
    );
  });

  it('a claim that did not take for one candidate does not block the next candidate in the same batch', async () => {
    process.env.PAPERCUSP_IMPROVEMENT_MAX_PER_RUN = '5';
    try {
      arm(cand({ id: 'EI-NOCLAIM', attempts: 0 }), cand({ id: 'EI-OK', attempts: 0 }));
      setImprovementMarkDispatched(async (item) => item.id !== 'EI-NOCLAIM');
      let fired: string[] = [];
      setImprovementImplementFire(async ({ candidate }) => {
        fired.push(candidate.id);
      });

      await run();

      expect(fired).toEqual(['EI-OK']); // only the item whose claim took actually fires
      expect(ledgerFired.map((f) => f.itemId)).toEqual(['EI-OK']);
    } finally {
      delete process.env.PAPERCUSP_IMPROVEMENT_MAX_PER_RUN;
    }
  });
});

describe('system:improvement-implement — runner-harness defaults to ctx.installSlug (WI-290)', () => {
  const arm = (...items: ImprovementCandidate[]) => {
    vi.mocked(getFlag).mockResolvedValue(true as never);
    vi.mocked(readImprovementItems).mockResolvedValue(items as never);
  };

  it('with the env override UNSET, still dispatches — runner resolves to the routine install slug, NOT no-runner', async () => {
    // The regression guard for the 2026-06-19 dark-and-stay-dark: the DBOS routines
    // executor (the bg-host) lacked PAPERCUSP_IMPROVEMENT_RUNNER_HARNESS, so the lane
    // returned action='no-runner' every tick and silently stranded ~200 bugs. The fix
    // defaults the runner to ctx.installSlug, so a dropped env can no longer dark the lane.
    delete process.env.PAPERCUSP_IMPROVEMENT_RUNNER_HARNESS;
    arm(cand({ id: 'EI-NOENV', attempts: 0 }));

    await run();

    // It dispatched (no-runner would have dispatched nothing) and the ledger row carries
    // the install slug as the runner.
    expect(dispatched.map((s) => s.id)).toEqual(['EI-NOENV']);
    expect(ledgerFired).toEqual([
      { workspaceId: 'ws-1', itemId: 'EI-NOENV', attempt: 1, runnerHarness: 'papercup', potSlug: null },
    ]);
  });

  it('the env override, when set, still wins over the install-slug default', async () => {
    process.env.PAPERCUSP_IMPROVEMENT_RUNNER_HARNESS = 'a-different-runner';
    arm(cand({ id: 'EI-OVERRIDE', attempts: 0 }));

    await run();

    expect(ledgerFired).toEqual([
      { workspaceId: 'ws-1', itemId: 'EI-OVERRIDE', attempt: 1, runnerHarness: 'a-different-runner', potSlug: null },
    ]);
  });
});

describe('system:improvement-implement — defaultFire idempotencyKey (EI-18117747280304049 orphaned-dispatch fix)', () => {
  // Exercise the REAL default fire (not the stub the other describes install) so
  // the idempotencyKey derivation itself is under test.
  beforeEach(() => setImprovementImplementFire(null));

  const arm = (...items: ImprovementCandidate[]) => {
    vi.mocked(getFlag).mockResolvedValue(true as never);
    vi.mocked(readImprovementItems).mockResolvedValue(items as never);
  };

  it('pins the learning worker through bodyExtra.spawnModel without losing dispatch correlation', async () => {
    arm(cand({ id: 'EI-SOL', attempts: 0 }));
    await run();
    const input = vi.mocked(buildLaunchSpawnRequest).mock.calls[0]![1] as {
      bodyExtra?: { spawnModel?: string; improvementDispatch?: { itemId?: string } };
    };
    expect(input.bodyExtra).toMatchObject({
      spawnModel: LEARNING_MODEL_SPEC,
      improvementDispatch: { itemId: 'EI-SOL' },
    });
  });

  it('two dispatches of the SAME item with a STUCK attempts counter get DISTINCT idempotency keys', async () => {
    // Root-cause repro: payload.implementAttempts pinned at 0 across two separate
    // ticks (the EI-406 worker-exit rollback makes this routine, not hypothetical —
    // live evidence: EI-10524 88x, EI-8914 10x, EI-13241 4x, every dispatch attempt=1
    // with the IDENTICAL spawned_run_id). Before the fix both ticks computed
    // `implement:EI-STUCK:1` — DBOS's {workflowID, deduplicationID} then silently
    // no-op'd the second dispatch as a replay of the first (already-terminal)
    // workflow, so no new worker ever ran and it sat until the 2h orphan collector
    // mislabeled it "orphaned". dispatchId (a fresh ledger-row UUID per real fire)
    // must make the two keys diverge regardless of the frozen counter.
    arm(cand({ id: 'EI-STUCK', attempts: 0 }));
    await run();
    arm(cand({ id: 'EI-STUCK', attempts: 0 })); // still 0 — the counter never advanced
    await run();

    expect(ledgerFired.map((f) => f.attempt)).toEqual([1, 1]); // the bookkeeping counter IS stuck
    const keys = vi.mocked(buildLaunchSpawnRequest).mock.calls.map((c) => c[2]);
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toEqual(keys[1]); // …but the DISPATCH is never deduped away
    expect(keys[0]).toContain('d-1');
    expect(keys[1]).toContain('d-2');
  });

  it('falls back to the attempt-keyed form when the ledger insert failed (no dispatchId)', async () => {
    setImprovementDispatchLedger({
      recordDispatchFired: async () => null, // ledger write failed — no row id
      recordFireResult: async () => {},
    });
    arm(cand({ id: 'EI-NOLEDGER', attempts: 2 }));

    await run();

    const keys = vi.mocked(buildLaunchSpawnRequest).mock.calls.map((c) => c[2]);
    expect(keys).toEqual(['implement:EI-NOLEDGER:3']);
  });
});
