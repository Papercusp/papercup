import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@papercusp/flags', () => ({ FLAGS: { TRANSFER_HARNESS: 'papercusp-transfer-harness' } }));
vi.mock('@papercusp/flags/server', () => ({ getFlag: vi.fn() }));
vi.mock('@papercusp/db-org', () => ({ getOrgPg: vi.fn() }));

// Importing the module registers the `transfer-distill` system action.
import { setTransferGovernorGate, setTransferTickDeps } from './transfer-distill-action';
import { getSystemAction } from './system-actions';
import { getFlag } from '@papercusp/flags/server';
import type { TransferTickDeps } from '../../transfer/tick';

const ctx = (over: Record<string, unknown> = {}) => ({
  installSlug: 'pot',
  workspaceId: 'ws-1',
  triggerConfig: {},
  payloadTemplate: null,
  ...over,
});
const run = (over: Record<string, unknown> = {}) => getSystemAction('transfer-distill')!(ctx(over) as never);

function spyDeps(): TransferTickDeps & { lister: ReturnType<typeof vi.fn> } {
  const lister = vi.fn(async () => []);
  return {
    store: {
      admit: vi.fn(),
      listForTesting: vi.fn(async () => []),
      recordOutcome: vi.fn(),
      markError: vi.fn(),
      setMemoryId: vi.fn(),
    },
    recordSpend: vi.fn(),
    lister,
    source: { load: vi.fn() },
    llm: vi.fn(),
    replay: null,
    memory: null,
    log: () => {},
  } as never;
}

let deps: ReturnType<typeof spyDeps>;
beforeEach(() => {
  deps = spyDeps();
  setTransferTickDeps(deps);
  // Governor allows by default — the gate's own verdicts live in
  // lib/transfer/governor.test.ts; here we pin the action's wiring.
  setTransferGovernorGate(async () => ({ allow: true, remainingUsd: 5 }));
  vi.mocked(getFlag).mockResolvedValue(true as never);
});
afterEach(() => {
  setTransferTickDeps(null);
  setTransferGovernorGate(null);
  vi.clearAllMocks();
});

describe('system:transfer-distill (self-learning-frontier P-022 / FB-08)', () => {
  it('registers as a system action', () => {
    expect(getSystemAction('transfer-distill')).toBeTypeOf('function');
  });

  it('flag OFF → no tick (the frontier D-001 arming gate)', async () => {
    vi.mocked(getFlag).mockResolvedValue(false as never);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await run();
      expect(deps.lister).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(expect.stringContaining('flag papercusp-transfer-harness is OFF'));
    } finally {
      log.mockRestore();
    }
  });

  it('flag ON + governor allow → runs the tick with the default window/caps', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await run();
      expect(deps.lister).toHaveBeenCalledWith({ windowMs: 24 * 60 * 60_000, cap: 12 });
    } finally {
      log.mockRestore();
    }
  });

  it('governor refuses → no tick (D-004 unattended-refusal, FB-01)', async () => {
    setTransferGovernorGate(async () => ({ allow: false, reason: 'unbudgeted', remainingUsd: null }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await run();
      expect(deps.lister).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(expect.stringContaining('learning-governor refused (unbudgeted)'));
    } finally {
      log.mockRestore();
    }
  });

  it('no gate override (the LIVE preflight) in a hermetic env → fail-closed, no tick', async () => {
    // The default gate must never reach a pool from a PG-free process: the
    // mocked getOrgPg yields no sql, the preflight fail-CLOSES, the tick is
    // refused (the default-on-flag-glue-vs-hermetic-unit-tests insight).
    setTransferGovernorGate(null);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await run();
      expect(deps.lister).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it('payload_template tunes the window + caps', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await run({ payloadTemplate: { windowHours: 48, maxTranscriptsPerTick: 3 } });
      expect(deps.lister).toHaveBeenCalledWith({ windowMs: 48 * 60 * 60_000, cap: 3 });
    } finally {
      log.mockRestore();
    }
  });

  it('a tick failure never throws out of the durable step', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      // A store failure on the admission path propagates out of the tick —
      // the action's catch must absorb it (durable-step discipline).
      deps.lister.mockResolvedValue(['/logs/a.jsonl']);
      (deps.source.load as ReturnType<typeof vi.fn>).mockResolvedValue({
        ref: '/logs/a.jsonl',
        turns: Array.from({ length: 5 }, (_, index) => ({ index, role: 'user', text: `t${index}` })),
      });
      (deps.llm as ReturnType<typeof vi.fn>).mockResolvedValue({
        text: '[{"title":"T","lesson":"L"}]',
        costUsd: 0,
      });
      (deps.store.admit as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('pg down'));
      await expect(run()).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith('[transfer-distill] tick FAILED:', 'pg down');
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
  });
});
