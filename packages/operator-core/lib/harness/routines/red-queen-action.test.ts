/**
 * red-queen-action.test.ts — the `system:red-queen-drill` action's gating
 * wiring (self-learning-frontier P-031 / FB-20; mirrors
 * fleet-ekg-action.test.ts). The cycle's own behavior lives in
 * lib/red-queen/sandbox.test.ts; here we pin flag OFF / governor refuse /
 * happy-path dispatch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@papercusp/flags', () => ({ FLAGS: { RED_QUEEN: 'papercusp-red-queen' } }));
vi.mock('@papercusp/flags/server', () => ({ getFlag: vi.fn() }));
// Partial mock: the red-queen import chain (sandbox → issues-engineer →
// desktop-health) reads db-org's `generated` schema namespace at import time,
// so only getOrgPg is stubbed.
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: vi.fn(),
}));

// Importing the module registers the `red-queen-drill` system action.
import { setRedQueenCycleDeps, setRedQueenGovernorGate } from './red-queen-action';
import { getSystemAction } from './system-actions';
import { getFlag } from '@papercusp/flags/server';
import type { DrillCycleDeps } from '../../red-queen/sandbox';
import type { Sql } from 'postgres';

const ctx = (over: Record<string, unknown> = {}) => ({
  installSlug: 'pot',
  workspaceId: 'ws-1',
  triggerConfig: {},
  payloadTemplate: null,
  ...over,
});
const run = (over: Record<string, unknown> = {}) => getSystemAction('red-queen-drill')!(ctx(over) as never);

function spyDeps() {
  const expireStale = vi.fn(async () => 0);
  const readOutcomes = vi.fn(async () => []);
  const deps = {
    sql: (() => Promise.resolve([])) as unknown as Sql,
    liveWorkspaceId: 'ws-1',
    runTick: vi.fn(async () => ({ status: 'skipped' })),
    getIssue: vi.fn(async () => null),
    readItems: vi.fn(async () => []),
    applyTriage: vi.fn(async () => ({ ok: false, id: 'x' })),
    resolve: vi.fn(async () => ({ ok: false, id: 'x' })),
    store: {
      insert: vi.fn(async () => ({ drillId: 'd', plantedAt: 'x' })),
      detected: vi.fn(async () => {}),
      triaged: vi.fn(async () => {}),
      resolved: vi.fn(async () => {}),
      failed: vi.fn(async () => {}),
      expireStale,
      readOutcomes,
    },
    now: () => 0,
    log: () => {},
  } as unknown as DrillCycleDeps;
  return { deps, expireStale, readOutcomes };
}

let spies: ReturnType<typeof spyDeps>;
beforeEach(() => {
  spies = spyDeps();
  setRedQueenCycleDeps(spies.deps);
  // Governor allows by default — the gate's own verdicts live in
  // lib/red-queen/governor.test.ts; here we pin the action's wiring.
  setRedQueenGovernorGate(async () => ({ allow: true, remainingUsd: 0 }));
  vi.mocked(getFlag).mockResolvedValue(true as never);
});
afterEach(() => {
  setRedQueenCycleDeps(null);
  setRedQueenGovernorGate(null);
  vi.clearAllMocks();
});

describe('system:red-queen-drill (self-learning-frontier P-031 / FB-20)', () => {
  it('registers as a system action', () => {
    expect(getSystemAction('red-queen-drill')).toBeTypeOf('function');
  });

  it('flag OFF → no tick (the frontier D-001 arming gate)', async () => {
    vi.mocked(getFlag).mockResolvedValue(false as never);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await run();
      expect(spies.expireStale).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it('governor refuses → no tick (D-004 unattended-refusal, FB-01)', async () => {
    setRedQueenGovernorGate(async () => ({ allow: false, reason: 'unbudgeted', remainingUsd: null }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await run();
      expect(spies.expireStale).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it('flag ON + governor allows → runs the tick (expire sweep observed)', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await run();
      expect(spies.expireStale).toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it('payload classId pins the rotation to one class', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await run({ payloadTemplate: { classId: 'nope-not-real' } });
      // Unknown class ⇒ idle tick: the expire sweep ran, no cycle started.
      expect(spies.expireStale).toHaveBeenCalled();
      expect(spies.deps.store.insert).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it('a tick failure never throws out of the durable step', async () => {
    (spies.deps.store.expireStale as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('pg down'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(run()).resolves.toBeUndefined();
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }
  });
});
