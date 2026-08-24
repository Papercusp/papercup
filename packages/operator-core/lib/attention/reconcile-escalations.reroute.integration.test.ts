/**
 * EI-21282340787786271 — reroute an escalation that only survives in the
 * materialized open-escalation projection.
 *
 * The production failure crossed two storage surfaces: the original
 * escalation can be absent from coord_event_log after retention while still
 * being open in coord_open_escalations, and coord:send rejects a
 * related_msg_id that is not a messages-surface row. Keep this test on the
 * real listEscalations + sendMessage seams so both boundaries stay covered.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FLAGS } from '@papercusp/flags';
import { setFlagOverridesForTest } from '@papercusp/flags/test';
import { setupBaselineCoordFixture, type BaselineCoordFixture } from '../_baseline-coord-fixture';
import { coordWorkspaceId } from '../agent-tools/coordination/log';
import { listEscalations } from '../agent-tools/coordination/escalations';
import { rerouteUnackedEscalationsOnce } from './reconcile-escalations';

let fx: BaselineCoordFixture;

const NOW = Date.parse('2026-08-24T00:00:00.000Z');
const ORIGINAL_MSG_ID = 'mqlfq7me-0000-18f69a47da0046dd85a61f17ff88f87f';
const NOTICE_MSG_ID = `escalation-sla-reroute:${ORIGINAL_MSG_ID}`;

beforeAll(async () => {
  fx = await setupBaselineCoordFixture();
});

afterAll(async () => {
  setFlagOverridesForTest(null);
  await fx.admin`TRUNCATE harness_shared.coord_event_log`.catch(() => {});
  await fx.admin`TRUNCATE harness_shared.coord_open_escalations`.catch(() => {});
  await fx.dispose();
});

beforeEach(async () => {
  setFlagOverridesForTest({ [FLAGS.COORD_OPEN_ESCALATIONS_PROJECTION]: true });
  await fx.admin`TRUNCATE harness_shared.coord_event_log`;
  await fx.admin`TRUNCATE harness_shared.coord_open_escalations`;

  const workspaceId = coordWorkspaceId();
  const escalation = {
    ts: new Date(NOW - 60 * 60 * 1000).toISOString(),
    msg_id: ORIGINAL_MSG_ID,
    from: 'su-author',
    to: ['human'],
    kind: 'escalation',
    severity: 'question',
    summary: 'projection-only reroute regression',
    plan_slug: 'plan-a',
    harness_slug: 'pot-a',
    resolved: null,
  };

  await fx.admin`
    INSERT INTO harness_shared.coord_open_escalations (workspace_id, msg_id, ts, body)
    VALUES (${workspaceId}, ${ORIGINAL_MSG_ID}, ${escalation.ts}, ${fx.admin.json(escalation)})
  `;
});

describe('rerouteUnackedEscalationsOnce projection boundary (EI-21282340787786271)', () => {
  it('sends through the real coord seam and suppresses a second reroute from its persisted marker', async () => {
    const workspaceId = coordWorkspaceId();
    const listPresenceFn = vi.fn(async () => [
      {
        ownerId: 'su-author',
        agentRole: 'su',
        currentPlanSlug: 'plan-a',
        potSlug: 'pot-a',
        heartbeatAt: new Date(NOW).toISOString(),
        stale: false,
        host: '',
        pid: null,
        source: 'omp-hook-session',
      },
      {
        ownerId: 'su-driver',
        agentRole: 'su',
        currentPlanSlug: 'plan-a',
        potSlug: 'pot-a',
        heartbeatAt: new Date(NOW).toISOString(),
        stale: false,
        host: '',
        pid: null,
        source: 'omp-hook-session',
      },
    ]);
    const resolveSessionStatesFn = vi.fn(async () =>
      new Map([
        ['su-author', { sessionState: 'parked' }],
        ['su-driver', { sessionState: 'live' }],
      ]),
    );
    const wakeRecipientsFn = vi.fn(async () => ({ woken: 1 }));

    const beforeEvents = await fx.admin`
      SELECT msg_id FROM harness_shared.coord_event_log
       WHERE workspace_id = ${workspaceId} AND msg_id = ${ORIGINAL_MSG_ID}
    `;
    expect(beforeEvents).toHaveLength(0);

    const projectionRows = await listEscalations({ status: 'open' });
    expect(projectionRows.map((row) => row.msg_id)).toEqual([ORIGINAL_MSG_ID]);

    const first = await rerouteUnackedEscalationsOnce({
      nowMs: NOW,
      slaMs: 30 * 60 * 1000,
      workspaceId,
      listPresenceFn: listPresenceFn as never,
      resolveSessionStatesFn: resolveSessionStatesFn as never,
      fetchPresenceFleetFn: vi.fn(async () => new Map()) as never,
      getFleetFn: vi.fn(async () => null) as never,
      wakeRecipientsFn: wakeRecipientsFn as never,
    });

    expect(first).toMatchObject({ scanned: 1, selected: 1, rerouted: 1, failed: 0 });
    expect(wakeRecipientsFn).toHaveBeenCalledWith(
      ['su-driver'],
      expect.objectContaining({
        source: 'system:escalation-sla-reroute',
        workspaceId,
        payload: { escalationMsgId: ORIGINAL_MSG_ID, noticeMsgId: NOTICE_MSG_ID },
      }),
    );

    const [notice] = await fx.admin<{ body: Record<string, unknown> }[]>`
      SELECT body FROM harness_shared.coord_event_log
       WHERE workspace_id = ${workspaceId}
         AND surface = 'messages'
         AND msg_id = ${NOTICE_MSG_ID}
    `;
    expect(notice?.body).toMatchObject({
      msg_id: NOTICE_MSG_ID,
      from: 'system:escalation-sla-reroute',
      to: ['su-driver'],
      escalationRerouteOf: ORIGINAL_MSG_ID,
    });
    expect(notice?.body.related_msg_id).toBeUndefined();

    const stillOpen = await listEscalations({ status: 'open' });
    expect(stillOpen.map((row) => row.msg_id)).toEqual([ORIGINAL_MSG_ID]);

    const second = await rerouteUnackedEscalationsOnce({
      nowMs: NOW,
      slaMs: 30 * 60 * 1000,
      workspaceId,
      listPresenceFn: listPresenceFn as never,
      resolveSessionStatesFn: resolveSessionStatesFn as never,
      fetchPresenceFleetFn: vi.fn(async () => new Map()) as never,
      getFleetFn: vi.fn(async () => null) as never,
      wakeRecipientsFn: wakeRecipientsFn as never,
    });

    expect(second).toMatchObject({ scanned: 1, selected: 0, rerouted: 0, failed: 0 });
    expect(listPresenceFn).toHaveBeenCalledTimes(1);
    expect(resolveSessionStatesFn).toHaveBeenCalledTimes(1);
    expect(wakeRecipientsFn).toHaveBeenCalledTimes(1);

    const notices = await fx.admin`
      SELECT msg_id FROM harness_shared.coord_event_log
       WHERE workspace_id = ${workspaceId}
         AND surface = 'messages'
         AND msg_id = ${NOTICE_MSG_ID}
    `;
    expect(notices).toHaveLength(1);
  });
});
