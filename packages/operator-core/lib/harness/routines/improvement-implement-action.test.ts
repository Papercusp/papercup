/**
 * Handler-level tests for the `system:improvement-implement` action — the
 * exhausted⇒needs-human flip (self-improvement-consume-edges-2026-06-12 P-012).
 *
 * The pure decision (which items are exhausted) is plan-implement.test.ts; the
 * flip semantics (comment + needsHuman + release) is resolve-core.test.ts. This
 * file proves the ROUTINE wires them: every tick, whatever the plan action,
 * each attempts-exhausted item goes through the flip seam — the silent-worker-
 * death case finally leaves the auto lane.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../improvements/read-items', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../improvements/read-items')>()),
  readImprovementItems: vi.fn(async () => []),
}));
vi.mock('@papercusp/flags/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/flags/server')>()),
  getFlag: vi.fn(async () => false),
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
import type { ImprovementCandidate } from '../improvements/policy';
import type { ScoredItem } from '../improvements/digest';
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
      // hiveSlug is null for an operator-scoped item (cand() defaults scope:'operator') —
      // the P-012 per-hive dispatch stamp only resolves for `harness:` scopes.
      { workspaceId: 'ws-1', itemId: 'EI-1', attempt: 2, runnerHarness: 'improvement-runner-harness', hiveSlug: null },
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

    // The routine workflow drains result.durableSpawns and starts them durably AFTER the step.
    expect(result).toEqual({ durableSpawns: [req] });
    expect(ledgerResults).toEqual([
      { dispatchId: 'd-1', result: { ok: true, spawnedRunId: 'durable-spawn:implement:EI-1:2' } },
    ]);
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
      { workspaceId: 'ws-1', itemId: 'EI-NOENV', attempt: 1, runnerHarness: 'papercup', hiveSlug: null },
    ]);
  });

  it('the env override, when set, still wins over the install-slug default', async () => {
    process.env.PAPERCUSP_IMPROVEMENT_RUNNER_HARNESS = 'a-different-runner';
    arm(cand({ id: 'EI-OVERRIDE', attempts: 0 }));

    await run();

    expect(ledgerFired).toEqual([
      { workspaceId: 'ws-1', itemId: 'EI-OVERRIDE', attempt: 1, runnerHarness: 'a-different-runner', hiveSlug: null },
    ]);
  });
});
