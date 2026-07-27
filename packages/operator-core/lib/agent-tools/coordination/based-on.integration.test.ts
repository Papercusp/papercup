/**
 * based-on.integration.test.ts — P-008's last leg (D-084) against REAL Postgres.
 *
 * ── WHY THIS FILE EXISTS AT ALL ──────────────────────────────────────────────
 *
 * The field this replaces (`evidence`) was typed, threaded through the send
 * stamp, projected for readers and RENDERED by the pui — and never written once.
 * Every suite stayed green throughout, because every assertion was about the
 * shape of a helper rather than about a value ARRIVING. That is the fourth
 * instance of one defect class in this plan (fact
 * `required-field-collected-then-discarded`), so the rule it produced is what
 * this file applies: **after adding a field, assert it reads back from the
 * DESTINATION — the stored row — not that the writer was called.**
 *
 * So: seed the reads an agent actually made, derive, and follow the value all
 * the way onto the persisted coord envelope.
 *
 * Run: npm run test:file -- packages/operator-core/lib/agent-tools/coordination/based-on.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setupBaselineCoordFixture, type BaselineCoordFixture } from '../../_baseline-coord-fixture';
import { deriveBasedOn } from './based-on';
import { stampMessageFields, projectAuthoredFields } from './message-fields';
import { coordLog } from './log';
import { sendMessage } from './messages';
import type { AgentIdentity } from './identity';

const WS = 'based-on-ws';
const HARNESS = 'based-on-harness';
const OWNER = 'su-based-on-sender';

let fx: BaselineCoordFixture;

function ident(ownerId: string): AgentIdentity {
  return {
    ownerId,
    ownerLabel: ownerId,
    source: 'static-client',
    workspaceId: WS,
    userId: null,
  } as AgentIdentity;
}

/** One row in the invocation log — the read an agent actually made. */
async function seedRead(tool: string, args: unknown, minutesAgo: number, owner = OWNER): Promise<void> {
  await fx.admin`
    INSERT INTO harness_shared.tool_invocations
      (workspace_id, harness_slug, plugin_name, tool_name, role, spawn_id, window_key,
       invoked_at, status, args_json, coord_owner_id)
    VALUES (${WS}, ${HARNESS}, 'papercusp', ${tool}, 'su', 'test-spawn', 'w',
            now() - ${`${minutesAgo} minutes`}::interval, 'ok', ${fx.admin.json(args as never)}, ${owner})`;
}

beforeAll(async () => {
  fx = await setupBaselineCoordFixture();
});
afterAll(async () => {
  await fx.admin`DELETE FROM harness_shared.tool_invocations WHERE workspace_id = ${WS}`.catch(() => {});
  await fx.admin`DELETE FROM harness_shared.work_items WHERE workspace_id = ${WS}`.catch(() => {});
  await fx.admin`DELETE FROM harness_shared.harness_plans WHERE workspace_id = ${WS}`.catch(() => {});
  await fx.admin`TRUNCATE harness_shared.coord_event_log`.catch(() => {});
  await fx.dispose();
});
beforeEach(async () => {
  await fx.admin`DELETE FROM harness_shared.tool_invocations WHERE workspace_id = ${WS}`;
  await fx.admin`DELETE FROM harness_shared.work_items WHERE workspace_id = ${WS}`;
  await fx.admin`DELETE FROM harness_shared.harness_plans WHERE workspace_id = ${WS}`;
  await fx.admin`TRUNCATE harness_shared.coord_event_log`;
});

describe('deriveBasedOn against the real invocation log', () => {
  it('derives the refs the sender READ, most-recent first, with no authoring at all', async () => {
    await seedRead('plans:get', { slug: 'a-plan', harness: HARNESS }, 9);
    await seedRead('work_items:get', { ids: ['WI-9001', 'WI-9002'], harness: HARNESS }, 4);

    const out = await deriveBasedOn({ ownerId: OWNER, workspaceId: WS, harness: HARNESS });

    expect(out.map((e) => e.ref)).toEqual(['work-item:WI-9001', 'work-item:WI-9002', 'plan:a-plan']);
    expect(out[0]!.via).toBe('work_items:get');
    expect(Date.parse(out[0]!.readAt)).toBeLessThan(Date.now());
  });

  it('versions a ref that resolves, and leaves one that does not UNVERSIONED (never guessed)', async () => {
    await fx.admin`
      INSERT INTO harness_shared.work_items (workspace_id, harness_slug, feature_id, status, updated_ts)
      VALUES (${WS}, ${HARNESS}, 'WI-9001', 'open', 1750000000000)`;
    await seedRead('work_items:get', { id: 'WI-9001' }, 2);
    await seedRead('work_items:get', { id: 'WI-DOES-NOT-EXIST' }, 3);

    const out = await deriveBasedOn({ ownerId: OWNER, workspaceId: WS, harness: HARNESS });
    const byRef = new Map(out.map((e) => [e.ref, e]));

    expect(byRef.get('work-item:WI-9001')!.versionAtSend).toBe('open@1750000000000');
    // The read HAPPENED — it stays in the trace. Only the token is withheld,
    // because an unresolvable ref must never be reported as a version.
    expect(byRef.has('work-item:WI-DOES-NOT-EXIST')).toBe(true);
    expect(byRef.get('work-item:WI-DOES-NOT-EXIST')!.versionAtSend).toBeUndefined();
  });

  it('versions a plan read off the version the plan store already maintains', async () => {
    await fx.admin`
      INSERT INTO harness_shared.harness_plans (workspace_id, harness_slug, plan_slug, title, version)
      VALUES (${WS}, ${HARNESS}, 'a-plan', 'A plan', 42)`;
    await seedRead('plans:get', { slug: 'a-plan' }, 1);

    const [entry] = await deriveBasedOn({ ownerId: OWNER, workspaceId: WS, harness: HARNESS });
    expect(entry).toMatchObject({ ref: 'plan:a-plan', via: 'plans:get', versionAtSend: 'v42' });
  });

  it('is scoped to THIS sender and THIS window — never a peer’s reads, never yesterday’s', async () => {
    await seedRead('work_items:get', { id: 'WI-PEER' }, 1, 'su-someone-else');
    await seedRead('work_items:get', { id: 'WI-STALE' }, 90);
    await seedRead('work_items:get', { id: 'WI-MINE' }, 2);

    const out = await deriveBasedOn({ ownerId: OWNER, workspaceId: WS, harness: HARNESS });
    expect(out.map((e) => e.ref)).toEqual(['work-item:WI-MINE']);
  });

  it('returns [] — not a partial claim — when the sender read nothing traceable', async () => {
    await seedRead('coord:send', { to: ['x'] }, 1);
    await seedRead('facts:list', { scope: 'harness', scopeRef: HARNESS }, 1);
    expect(await deriveBasedOn({ ownerId: OWNER, workspaceId: WS, harness: HARNESS })).toEqual([]);
  });
});

describe('the value LANDS on the persisted envelope (the destination, not the writer)', () => {
  it('rides the stored coord row and reads back through projectAuthoredFields', async () => {
    await fx.admin`
      INSERT INTO harness_shared.harness_plans (workspace_id, harness_slug, plan_slug, title, version)
      VALUES (${WS}, ${HARNESS}, 'a-plan', 'A plan', 7)`;
    await seedRead('plans:get', { slug: 'a-plan' }, 1);

    const basedOn = await deriveBasedOn({ ownerId: OWNER, workspaceId: WS, harness: HARNESS });
    const stamp = stampMessageFields({ body: 'the claim', basedOn });
    const sent = await sendMessage(ident(OWNER), {
      to: ['su-recipient'],
      summary: 'p-008 basedOn',
      body: 'the claim',
      extra: { ...(stamp.basedOn ? { basedOn: stamp.basedOn } : {}) },
    });

    const stored = (await coordLog.readLines('messages')).find((e) => e.msg_id === sent.msg_id);
    expect(stored, 'the sent message must be readable back off the messages surface').toBeTruthy();

    // THE assertion this file exists for: the derived value is on the ROW.
    const rowBasedOn = (stored as unknown as Record<string, unknown>).basedOn;
    expect(rowBasedOn).toEqual([
      expect.objectContaining({ ref: 'plan:a-plan', via: 'plans:get', versionAtSend: 'v7' }),
    ]);

    // …and every reader surface sees it through the one shared projection.
    const projected = projectAuthoredFields(stored as unknown as Record<string, unknown>);
    expect(projected?.basedOn?.[0]?.ref).toBe('plan:a-plan');
  });

  it('a message with NO traceable reads carries no `basedOn` key at all', async () => {
    const basedOn = await deriveBasedOn({ ownerId: OWNER, workspaceId: WS, harness: HARNESS });
    const stamp = stampMessageFields({ body: 'nothing read', basedOn });
    const sent = await sendMessage(ident(OWNER), {
      to: ['su-recipient'],
      summary: 'no trace',
      body: 'nothing read',
      extra: { ...(stamp.basedOn ? { basedOn: stamp.basedOn } : {}) },
    });

    const stored = (await coordLog.readLines('messages')).find((e) => e.msg_id === sent.msg_id);
    expect(stored).toBeTruthy();
    expect(stored as object).not.toHaveProperty('basedOn');
  });
});
