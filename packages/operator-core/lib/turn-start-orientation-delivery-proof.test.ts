/**
 * Turn-start orientation under ACK-ON-PROOF
 * (owner-directive-delivery-redesign-2026-09-22 P-005, D-005).
 *
 * read-cursors.test.ts pins the cursor contract in isolation. This pins what an
 * agent actually sees: a delta-tracked line (the post-claim history update) that
 * the hook never proved it printed must come back next turn, and one it did prove
 * must not. Before P-005 the turn's ARRIVAL was the ack, so a hook killed after
 * the server staged lost the line for good.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The per-turn telemetry write is fire-and-forget and reaches PG; stub it so a
// unit test never opens a pool.
vi.mock('./orientation-telemetry', () => ({
  recordOrientationTurn: vi.fn(async () => {}),
  selectObligationTelemetry: () => ({ rows: [], evaluatedClasses: [] }),
}));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: vi.fn() }),
}));

import {
  type AckConfirmation,
  type AckResult,
  configureReadCursorStore,
  InMemoryReadCursorStore,
  resetReadCursorStore,
} from './agent-tools/coordination/read-cursors';
import { buildTurnStartOrientationBlock, type OrientationDeps } from './turn-start-orientation';

const HISTORY_LINE = 'post-claim history update(s)';

/** Records what each turn's ack returned, so the tests can read the diff base. */
class RecordingStore extends InMemoryReadCursorStore {
  acks: Array<{ confirmation: AckConfirmation | undefined; result: AckResult }> = [];
  override async ackAndRead(ownerId: string, surface: string, confirmation?: AckConfirmation) {
    const result = await super.ackAndRead(ownerId, surface, confirmation);
    this.acks.push({ confirmation, result });
    return result;
  }
}

const deps: OrientationDeps = {
  held: async () => [{ id: 'WI-9', checkpoint: 'continue here', checkpointStale: false }],
  ownerDirectives: async () => [],
  historyUpdates: async () => [{ workItemId: 'WI-9', count: 1, newestPostId: 12 }],
  effortUpdates: async () => [],
  openChecks: async () => [],
  planDecisions: async () => undefined,
  lockTransitions: async () => undefined,
  coupledPeers: async () => null,
  inbox: async () => ({ count: 0, newest: [] }),
  announcedGates: async () => [],
  openAsks: async () => null,
  modes: async () => [],
  authorityVerdict: async () => null,
  loopArmed: async () => true,
  loopFireWithheld: async () => false,
  improvementTriage: async () => null,
  executableFrontier: async () => null,
  obligations: async () => null,
  neverDropFacts: async () => [],
  toolSurface: async () => null,
  carryBlindWindow: async () => null,
  contextEpoch: async () => 1,
};

const turn = (confirmedDeliveryToken?: string | null) =>
  buildTurnStartOrientationBlock({
    ownerId: 'su-proof',
    workspaceId: 'ws-proof',
    deps,
    ...(confirmedDeliveryToken === undefined ? {} : { confirmedDeliveryToken }),
  });

let store: RecordingStore;
beforeEach(() => {
  store = new RecordingStore();
  configureReadCursorStore(store);
});
afterEach(() => resetReadCursorStore());

describe('turn-start orientation — ack-on-proof', () => {
  it('re-sends a line whose delivery was never proven, and stops once it is', async () => {
    const first = await turn(null);
    expect(first.block).toContain(HISTORY_LINE);
    expect(first.deliveryToken).toEqual(expect.any(String));

    // The hook died before printing, so it still confirms nothing it can prove.
    const retry = await turn('token-from-an-older-turn');
    expect(store.acks[1]?.result.committed).toBeNull();
    expect(retry.block).toContain(HISTORY_LINE);
    expect(retry.deliveryToken).not.toBe(first.deliveryToken);

    // This time the hook printed and recorded the token it was handed.
    const proven = await turn(retry.deliveryToken);
    expect(store.acks[2]?.result.committed).not.toBeNull();
    expect(proven.block).not.toContain(HISTORY_LINE);
  });

  it('a caller that sends no confirmation keeps ack-on-arrival and is handed no token', async () => {
    const first = await turn();
    expect(first.block).toContain(HISTORY_LINE);
    expect(first.deliveryToken).toBeNull();
    expect(store.acks[0]?.confirmation).toBeUndefined();

    // Arrival alone acks: the line is suppressed although nothing was proven.
    const second = await turn();
    expect(second.block).not.toContain(HISTORY_LINE);
  });
});
