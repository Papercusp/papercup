import { afterAll, describe, expect, it } from 'vitest';
import { getOrgPg } from '@papercusp/db-org';
import { buildGovernorStatePayload } from './governor-state';
import { GovernorStateSnapshotWriter } from '../../resource-governor/state-snapshot';

const workspaceId = `test-governor-state-${process.pid}-${Date.now()}`;

afterAll(async () => {
  const { sql } = getOrgPg();
  await sql`DELETE FROM harness_shared.derived_read_snapshots WHERE workspace_id = ${workspaceId}`;
});

describe('governor state shared snapshot', () => {
  it('round-trips one atomic snapshot through PostgreSQL into the resolver lens', async () => {
    const writer = new GovernorStateSnapshotWriter(workspaceId);
    const written = await writer.publish({
      observedAtMs: Date.now(),
      validUntilMs: Date.now() + 60_000,
      evidenceRef: 'integration:governor-state',
      queueByClass: [
        { admissionClass: 'agent', depth: 2, oldestAgeMs: 500, arrivals: 3, drained: 1, observedWindowMs: 1_000 },
      ],
      recovery: { state: 'recovering', completed: 1, total: 2, confidence: 0.9 },
    });

    const payload = await buildGovernorStatePayload(workspaceId);
    expect(payload).toMatchObject({
      snapshot: written,
      queue: { depth: 2, oldestAgeMs: 500, arrivalRatePerSec: 3, drainRatePerSec: 1 },
      recovery: { state: 'recovering', progress: 0.5 },
      freshness: { stale: false },
    });
    expect(payload.unknown).toContain('health');
    expect(payload.health).toMatchObject({ state: null });
  });
});
