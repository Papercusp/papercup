// @vitest-environment node
/** Exercise the completion-event consumer inside a real DBOS workflow. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DBOS as DBOSType } from '@dbos-inc/dbos-sdk';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import type { WorkItem } from '../work-items';
import type { KeyFireRow } from '../events/await/types';
import { awaitWorkItemCompletionEvent } from './work-item-event-await';

let db: OrgTestDb;
let DBOS: typeof DBOSType;
let workflow: (itemId: string, deadlineAt: string) => Promise<unknown>;
let reads = 0;

beforeAll(async () => {
  db = await createOrgTestDb();
  ({ DBOS } = await import('@dbos-inc/dbos-sdk'));
  DBOS.setConfig({
    name: 'work-item-event-consumer-test',
    systemDatabaseUrl: db.adminDsn,
    systemDatabaseSchemaName: 'dbos',
    applicationVersion: 'work-item-event-consumer-v1',
    runAdminServer: false,
  });
  workflow = DBOS.registerWorkflow(async (itemId: string, deadlineAt: string) =>
    awaitWorkItemCompletionEvent({
      itemId, harnessSlug: 'papercusp', workspaceId: 'papercusp-workspace',
      deadlineAt, pollMs: 100,
    }, {
      readItem: async () => {
        reads++;
        return {
          id: itemId, harness: 'papercusp', state: reads === 1 ? 'wip' : 'done',
          completionAuthority: reads === 1 ? null : 'committed',
          payload: { _completionEventIntentId: 'cycle-1' },
        } as WorkItem;
      },
      readLatch: async () => ({ lastPayload: { completionIntentId: 'cycle-1' } } as KeyFireRow),
    }), { name: 'testWorkItemCompletionConsumer', maxRecoveryAttempts: 2 });
  await DBOS.launch();
}, 120_000);

afterAll(async () => {
  await DBOS?.shutdown();
  await db?.cleanup();
});

describe('DBOS work-item event consumer', () => {
  it('durably sleeps, then resumes from the canonical event and current terminal state', async () => {
    const id = `test-work-item-event-consumer:${Date.now()}`;
    await DBOS.startWorkflow(workflow, { workflowID: id })('WI-123', new Date(Date.now() + 10_000).toISOString());
    const result = await DBOS.getResult(id, 20);
    expect(result).toMatchObject({
      kind: 'settled', itemId: 'WI-123', state: 'done', successful: true,
      source: 'completion-event', completionIntentId: 'cycle-1',
    });
    expect(reads).toBeGreaterThanOrEqual(3);
  }, 30_000);
});
