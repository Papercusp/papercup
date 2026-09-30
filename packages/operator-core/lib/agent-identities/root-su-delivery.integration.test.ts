/** Root SU provider receipts from persisted mode and presence state. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgPresenceStore } from '@papercusp/coordination/presence';
import { getModes, setMode } from '../modes/store';
import { bindTurnStartIdentityOutputs } from '../turn-start-orientation';
import { bindOrientOutputResult } from '../agent-tools/coordination/tools/orient';
import type { OrgTestDb } from '../../test/_org-test-db';

const { createOrgTestDb } = await import('../../test/_org-test-db');

describe('root SU operational identity delivery', () => {
  let db: OrgTestDb;
  let presence: PgPresenceStore;
  const workspaceId = 'root-su-delivery';
  const ownerId = 'su-root-delivery';

  beforeAll(async () => {
    db = await createOrgTestDb();
    presence = new PgPresenceStore({ getSql: () => db.adminSql, ensureSchema: async () => {} });
    await presence.write(
      { ownerId, ownerLabel: 'Root SU', source: 'integration', workspaceId },
      {
        intent: 'WI-9 current task',
        currentPlanSlug: 'identity-plan',
      },
    );
    expect(
      (
        await setMode({
          workspaceId,
          ownerId,
          modeId: 'auto',
          enabled: true,
          reason: 'root SU delivery proof',
          setBy: ownerId,
          sql: db.adminSql,
        })
      ).ok,
    ).toBe(true);
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('binds one source revision while current mode and assignment outputs refresh', async () => {
    const modeRows = await getModes(workspaceId, ownerId, db.adminSql);
    const readAssignment = (id: string) => presence.get(id);
    const first = await bindTurnStartIdentityOutputs(
      {
        ownerId,
        workspaceId,
        state: { modes: modeRows } as never,
        committed: null,
        epoch: 1,
        contextTokens: null,
        block: 'CURRENT TURN',
        deliveryToken: 'first-token',
      },
      undefined,
      readAssignment,
    );
    if (!('contributions' in first.root)) throw new Error('root SU turn-start receipt was unavailable: ' + JSON.stringify(first.root));
    expect(first.root.contributions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          contributionId: 'current-mode-state',
          status: 'bound',
          producerRef: 'papercusp.mode-state@1',
        }),
        expect.objectContaining({
          contributionId: 'current-assignment',
          status: 'bound',
          producerRef: 'papercusp.current-assignment@1',
        }),
      ]),
    );

    const orientResult = { ok: true, self: { ownerId } };
    const metadata: Array<Record<string, unknown>> = [];
    expect(
      await bindOrientOutputResult(
        orientResult,
        { ownerId, workspaceId, harness: 'papercusp' },
        false,
        (entry) => metadata.push(entry),
        undefined,
        modeRows,
        readAssignment,
      ),
    ).toBe(orientResult);
    expect(metadata[0]?.rootIdentityContribution).toMatchObject({
      identityId: 'su',
      sourceRevision: first.root.sourceRevision,
      contributions: expect.arrayContaining([
        expect.objectContaining({ contributionId: 'current-mode-state', status: 'bound' }),
        expect.objectContaining({ contributionId: 'current-assignment', status: 'bound' }),
      ]),
    });

    await presence.write(
      { ownerId, ownerLabel: 'Root SU', source: 'integration', workspaceId },
      {
        intent: 'WI-10 next task',
        currentPlanSlug: 'next-plan',
      },
    );
    expect(
      (
        await setMode({
          workspaceId,
          ownerId,
          modeId: 'ideate',
          enabled: true,
          reason: 'new current mode',
          setBy: ownerId,
          sql: db.adminSql,
        })
      ).ok,
    ).toBe(true);
    const second = await bindTurnStartIdentityOutputs(
      {
        ownerId,
        workspaceId,
        state: { modes: await getModes(workspaceId, ownerId, db.adminSql) } as never,
        committed: null,
        epoch: 1,
        contextTokens: null,
        block: 'NEXT TURN',
        deliveryToken: 'second-token',
      },
      undefined,
      readAssignment,
    );
    if (!('contributions' in second.root)) throw new Error('refreshed root SU receipt was unavailable: ' + JSON.stringify(second.root));
    expect(second.root.sourceRevision).toBe(first.root.sourceRevision);
    for (const contributionId of ['current-mode-state', 'current-assignment']) {
      expect(
        second.root.contributions.find((entry) => entry.contributionId === contributionId)?.outputRevision,
      ).not.toBe(first.root.contributions.find((entry) => entry.contributionId === contributionId)?.outputRevision);
    }
  }, 120_000);
});
