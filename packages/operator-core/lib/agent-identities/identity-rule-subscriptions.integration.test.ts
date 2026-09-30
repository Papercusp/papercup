/**
 * P-018 (D-027 §2, D-029 §1/§3/§4/§6) against a real, fully migrated Postgres:
 * worn async-rule subscriptions follow the applied artifact, and one identity
 * reaction's receipt, wearer read and stale-row cancel behave as the unit tests
 * assume. The class/pot/ceiling lookups and the dispatch are injected here; the
 * DBOS round trip (enqueue → workflow → SIGKILL recovery) is the DBOS suite's.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { pinPackageInput, resolveBlueprint } from '@papercusp/orchestrator/blueprint';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { compileBlueprintWithPackages } from '../blueprint/compile-packages';

const pg = vi.hoisted(() => ({ sql: null as Sql | null }));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: pg.sql }),
}));

import {
  IDENTITY_RULE_SUBSCRIPTION_KIND,
  identityRevisionTag,
  parseIdentityRuleSubscriberId,
} from './identity-async-rules';
import {
  cancelIdentityRuleSubscription,
  IDENTITY_RULE_DELIVERY_MODE,
  replaceIdentityRuleSubscriptions,
} from './identity-rule-subscriptions';
import {
  executeIdentityReaction,
  planIdentityReactions,
  type IdentityReactionDeps,
} from '../events/identity-reaction';

const WS = 'identity-subs-ws';
const TARGET = { classId: 'demo.tasks', classVersion: '1.2.0', classRef: 'demo.tasks@1.2.0', verb: 'create' };

const asyncRule = (id: string, on: string) => pinPackageInput({
  packageKind: 'rule', ref: id, revision: '1.0.0', files: [{ path: 'rule.json', bytes: id }],
  value: { id, title: id, description: `${id} rule`, version: '1.0.0', delivery: 'async', on,
    fire: 'class:demo.tasks@1.2.0#create', args: { title: id } },
});
const RULES = {
  'file-task': asyncRule('file-task', 'demo.fired'),
  'note-it': asyncRule('note-it', 'demo.other'),
  'no-rm': pinPackageInput({
    packageKind: 'rule', ref: 'no-rm', revision: '1.0.0', files: [{ path: 'rule.json', bytes: 'no-rm' }],
    value: { id: 'no-rm', title: 'no-rm', description: 'no-rm guard', version: '1.0.0', delivery: 'sync',
      sink: 'pre-tool', tools: ['capability:bash'], guard: { deny: { 'input.command': { matches: 'rm -rf' } } } },
  }),
};

type Artifact = Awaited<ReturnType<typeof compileBlueprintWithPackages>>;

async function compile(id: string, refs: Array<keyof typeof RULES>): Promise<Artifact> {
  const source = resolveBlueprint({ id, bundles: refs.map((ref) => ({ kind: 'rule', ref })),
    workItem: { kind: 'feature' }, spine: { edges: { DONE: { to: 'done' } } } });
  return compileBlueprintWithPackages(source, { workspaceId: WS, harnessSlug: 'identity-subs',
    resolvePackage: async ({ ref }) => RULES[ref as keyof typeof RULES] ?? null });
}

describe('identity rule subscriptions + reaction receipts (real migrated PG)', () => {
  let db: OrgTestDb;
  let both: Artifact;
  let fileOnly: Artifact;
  let syncOnly: Artifact;
  let nextSessionId = 9700;

  const replace = (ownerId: string, artifact: Artifact) =>
    db.adminSql.begin((tx) => replaceIdentityRuleSubscriptions(tx, { ownerId, workspaceId: WS, artifact }));

  const activeRows = (ownerId: string) => db.adminSql<Array<{
    id: number; subscriber_id: string; target_kind: string; target_ref: string; delivery_mode: string;
    derived_from_kind: string; derived_from_ref: string;
  }>>`
    SELECT id, subscriber_id, target_kind, target_ref, delivery_mode, derived_from_kind, derived_from_ref
      FROM harness_shared.coord_entity_subscriptions
     WHERE workspace_id = ${WS} AND derived_from_ref = ${ownerId} AND cancelled_at IS NULL
     ORDER BY target_ref`;

  /** Make `ownerId` wear `artifact` (launch record + applied control anchor), and apply its subscriptions. */
  async function wear(ownerId: string, artifact: Artifact) {
    const revision = { specificationRevision: artifact.specificationRevision, stateRevision: `state-${ownerId}` };
    await db.adminSql`INSERT INTO harness_shared.adv_sessions (id,workspace_id,mode,coord_owner_id,session_id,started_at,launch_spec)
      VALUES (${nextSessionId++},${WS},'console',${ownerId},${`native-${ownerId}-${nextSessionId}`},now(),
        ${JSON.stringify({ ...revision, specificationArtifact: artifact })}::text::jsonb)`;
    await db.adminSql`
      INSERT INTO harness_shared.session_briefs (owner_id, workspace_id, control_generation, control_state)
      VALUES (${ownerId}, ${WS}, 1, ${db.adminSql.json({ activation: { applied: revision }, scope: { harness: 'identity-subs' } })})
      ON CONFLICT (owner_id) DO UPDATE SET control_state = EXCLUDED.control_state`;
    await replace(ownerId, artifact);
  }

  beforeAll(async () => {
    db = await createOrgTestDb();
    pg.sql = db.adminSql;
    both = await compile('two-async', ['file-task', 'note-it', 'no-rm']);
    fileOnly = await compile('one-async', ['file-task']);
    syncOnly = await compile('sync-only', ['no-rm']);
  }, 180_000);

  afterAll(async () => {
    pg.sql = null;
    await db?.cleanup();
  });

  describe('replaceIdentityRuleSubscriptions', () => {
    it('writes one muted event row per worn async rule, addressed by owner, revision and pin', async () => {
      await expect(replace('owner-a', both)).resolves.toEqual({ subscribed: 2, cancelled: 0 });
      const rows = await activeRows('owner-a');
      expect(rows.map((r) => r.target_ref)).toEqual(['demo.fired', 'demo.other']);
      const tag = identityRevisionTag(both.specificationRevision);
      for (const row of rows) {
        expect(row).toMatchObject({
          target_kind: 'event', delivery_mode: IDENTITY_RULE_DELIVERY_MODE,
          derived_from_kind: IDENTITY_RULE_SUBSCRIPTION_KIND, derived_from_ref: 'owner-a',
        });
        expect(parseIdentityRuleSubscriberId(row.subscriber_id, 'owner-a')?.revisionTag).toBe(tag);
      }
    });

    it('is idempotent for the same artifact: no churn, the same rows', async () => {
      const before = await activeRows('owner-a');
      await expect(replace('owner-a', both)).resolves.toEqual({ subscribed: 0, cancelled: 0 });
      expect((await activeRows('owner-a')).map((r) => r.id)).toEqual(before.map((r) => r.id));
    });

    it('re-addresses every row when the specification revision changes', async () => {
      await expect(replace('owner-a', fileOnly)).resolves.toEqual({ subscribed: 1, cancelled: 2 });
      const rows = await activeRows('owner-a');
      expect(rows.map((r) => r.target_ref)).toEqual(['demo.fired']);
      expect(parseIdentityRuleSubscriberId(rows[0]!.subscriber_id, 'owner-a')?.revisionTag)
        .toBe(identityRevisionTag(fileOnly.specificationRevision));
    });

    it('gives two wearers of one revision separate rows, and a detach cancels only its own', async () => {
      await replace('owner-b', fileOnly);
      expect(await activeRows('owner-b')).toHaveLength(1);
      await expect(replace('owner-a', syncOnly)).resolves.toEqual({ subscribed: 0, cancelled: 1 });
      expect(await activeRows('owner-a')).toEqual([]);
      expect(await activeRows('owner-b')).toHaveLength(1);
    });

    it('cancelIdentityRuleSubscription cancels exactly the named row', async () => {
      await replace('owner-c', both);
      const [fired, other] = await activeRows('owner-c');
      await cancelIdentityRuleSubscription(db.adminSql, {
        workspaceId: WS, ownerId: 'owner-c', subscriberId: fired!.subscriber_id, eventKey: fired!.target_ref,
      });
      expect((await activeRows('owner-c')).map((r) => r.id)).toEqual([other!.id]);
    });
  });

  describe('executeIdentityReaction on a real receipt table and a real wearer read', () => {
    const dispatch = vi.fn(async (_input: Parameters<IdentityReactionDeps['dispatch']>[0]) => ({ ok: true }) as { ok: boolean; error?: string });
    const deps: Partial<IdentityReactionDeps> = {
      resolvePot: async () => 'pot-a',
      validateFire: async () => ({ ok: true, target: TARGET, capability: 'tasks:create' }),
      resolveFire: async () => ({ status: 'resolved', target: TARGET, tool: 'tasks:create', providerPackage: 'demo', providerVersion: '1.2.0' }),
      readCeiling: async () => ({ potSlug: 'pot-a', ceilings: [], protectedAdditions: [] }),
      isRegisteredTool: () => true,
      dispatch,
    };
    let fireSeq = 0;

    async function fire(ownerId: string, eventKey = 'demo.fired') {
      const rows = await db.adminSql<Array<{ subscriber_id: string; delivery_mode: string; derived_from_kind: string; derived_from_ref: string }>>`
        SELECT subscriber_id, delivery_mode, derived_from_kind, derived_from_ref
          FROM harness_shared.coord_entity_subscriptions
         WHERE workspace_id = ${WS} AND derived_from_ref = ${ownerId} AND target_ref = ${eventKey}
           AND cancelled_at IS NULL`;
      return planIdentityReactions({
        workspaceId: WS, eventKey, fireId: `${eventKey}@1790000000000000#${++fireSeq}`, payload: { kind: 'bug' }, rows,
      }).payloads;
    }
    const receipt = (id: string) => db.adminSql<Array<{
      status: string; error_message: string | null; fire: string; contributor: string | null; rule_id: string; trigger_tool: string;
    }>>`SELECT status, error_message, fire, contributor, rule_id, trigger_tool FROM harness_shared.event_reactions WHERE dedup_id = ${id}`
      .then((rows) => rows[0]);

    beforeEach(() => dispatch.mockClear());

    it('authorizes the live wearer, dispatches once, records fired, and a replay dispatches nothing', async () => {
      await wear('wearer-1', fileOnly);
      const [payload] = await fire('wearer-1');
      expect(payload).toBeDefined();
      await expect(executeIdentityReaction(payload!, deps)).resolves.toEqual({ status: 'fired', tool: 'tasks:create' });
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(dispatch.mock.calls[0]![0]).toMatchObject({ ownerId: 'wearer-1', role: 'su', harnessSlug: 'identity-subs' });
      expect(await receipt(payload!.receiptId)).toMatchObject({
        status: 'fired', error_message: null, fire: 'class:demo.tasks@1.2.0#create', rule_id: 'file-task', trigger_tool: 'event:demo.fired',
      });
      expect((await receipt(payload!.receiptId))?.contributor).toMatch(/^identity:/);
      await expect(executeIdentityReaction(payload!, deps)).resolves.toEqual({ status: 'replayed', prior: 'fired' });
      expect(dispatch).toHaveBeenCalledTimes(1);
    });

    it('refuses a reaction queued before an upgrade, and cancels the stale subscription row', async () => {
      await wear('wearer-2', fileOnly);
      const [queued] = await fire('wearer-2');
      // The wearer upgrades before the queued reaction runs; the activation re-addresses the row.
      await wear('wearer-2', both);
      await expect(executeIdentityReaction(queued!, deps)).resolves.toMatchObject({ status: 'refused', code: 'attachment-changed' });
      expect(dispatch).not.toHaveBeenCalled();
      expect(await receipt(queued!.receiptId)).toMatchObject({ status: 'refused', error_message: expect.stringMatching(/^attachment-changed: /) });
      const live = await activeRows('wearer-2');
      expect(live.map((r) => r.subscriber_id)).not.toContain(queued!.subscriberId);
      expect(live).toHaveLength(2);
    });

    it('refuses a reaction whose wearer detached, with zero dispatch', async () => {
      await wear('wearer-3', fileOnly);
      const [queued] = await fire('wearer-3');
      await db.adminSql`UPDATE harness_shared.session_briefs SET control_state = control_state - 'activation' WHERE owner_id = 'wearer-3'`;
      await expect(executeIdentityReaction(queued!, deps)).resolves.toMatchObject({ status: 'refused', code: 'detached' });
      expect(dispatch).not.toHaveBeenCalled();
      expect(await activeRows('wearer-3')).toEqual([]);
    });

    it('two wearers of one fire get two receipts and two dispatches, each as themselves', async () => {
      await wear('wearer-4', fileOnly);
      await wear('wearer-5', fileOnly);
      const payloads = [...await fire('wearer-4'), ...await fire('wearer-5')];
      for (const payload of payloads) await executeIdentityReaction(payload, deps);
      expect(dispatch.mock.calls.map(([input]) => input.ownerId)).toEqual(['wearer-4', 'wearer-5']);
      for (const payload of payloads) expect((await receipt(payload.receiptId))?.status).toBe('fired');
    });
  });
});
