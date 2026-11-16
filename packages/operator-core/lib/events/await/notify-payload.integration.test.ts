// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { setupBaselineCoordFixture, type BaselineCoordFixture } from '../../_baseline-coord-fixture';

const h = vi.hoisted(() => ({ workspaceId: 'ws-notify-payload' }));
vi.mock('../../workspace-registry', async original => ({
  ...(await original<typeof import('../../workspace-registry')>()),
  activeWorkspaceId: () => h.workspaceId,
  backgroundWorkspaceIds: () => [h.workspaceId],
}));

import { emitAwaitedEvent, setAutoPumpEnabledForTests } from './engine';
import { registerAwait } from './store';
import { subscribeEventKey } from '../../agent-tools/coordination/event-subscriptions';
import type { AgentIdentity } from '../../agent-tools/coordination/identity';
import { readInbox } from '../../agent-tools/coordination/messages';
import { boundInboxEntries } from '../../agent-tools/coordination/tools/inbox';
import readTool from '../../agent-tools/coordination/tools/read';
import { _resetForTests } from '@papercusp/db-org';

const recipient = 'su-notify-payload-reader';
const identity: AgentIdentity = {
  ownerId: recipient,
  ownerLabel: recipient,
  source: 'static-client',
  workspaceId: h.workspaceId,
  userId: null,
};

let fixture: BaselineCoordFixture | undefined;
let previousAutoPump: boolean;

beforeAll(async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  fixture = await setupBaselineCoordFixture();
  previousAutoPump = setAutoPumpEnabledForTests(false);
}, 120_000);

afterAll(async () => {
  setAutoPumpEnabledForTests(previousAutoPump);
  if (!fixture) return;
  try {
    await fixture.admin`DELETE FROM harness_shared.coord_event_log WHERE workspace_id = ${h.workspaceId}`;
    await fixture.admin`DELETE FROM harness_shared.coord_entity_subscriptions WHERE subscriber_id = ${recipient}`;
    await fixture.admin`DELETE FROM harness_shared.event_awaits WHERE workspace_id = ${h.workspaceId}`;
    await fixture.admin`DELETE FROM harness_shared.event_key_fires WHERE workspace_id = ${h.workspaceId}`;
  } finally {
    await fixture.dispose();
    vi.restoreAllMocks();
  }
});

async function subscribe(key: string, kind: 'await' | 'event-key'): Promise<void> {
  if (kind === 'await') {
    await registerAwait({ subscriberId: recipient, eventKey: key, policy: 'notify', once: false });
  } else {
    await subscribeEventKey(identity, key);
  }
}

async function recoverFromPreview(msgId: string, payload: unknown): Promise<void> {
  const entries = await readInbox(recipient);
  const entry = entries.find(message => message.msg_id === msgId);
  expect(entry).toBeDefined();
  const [preview] = boundInboxEntries([{ ...entry }], 600);
  expect(preview).toMatchObject({
    msg_id: msgId,
    body_truncated: true,
    body_full_chars: JSON.stringify(payload).length,
  });
  expect(preview!.body).toContain('coord:read');
  expect(preview!.body).toContain(msgId);

  // Follow the preview's exact message reference through the real indexed
  // resolver, rather than treating the preview as a complete JSON record.
  const result = await readTool.handler({ msg_id: preview!.msg_id as string }, {} as never);
  const recovered = result as { data: { ok: boolean; found: boolean; message: { body: string } } };
  expect(recovered.data).toMatchObject({ ok: true, found: true });
  expect(recovered.data.message.body).toBe(JSON.stringify(payload));
  expect(JSON.parse(recovered.data.message.body)).toEqual(payload);
}

describe('standing event notification payload recovery (EI-28886909140134156)', () => {
  it.each([1_999, 2_000, 2_001, 8_192])('recovers an exact %i-character JSON body from a labelled preview', async size => {
    const key = `notify-payload:boundary:${size}`;
    await subscribe(key, 'await');
    const payload = { padding: '', decisive: { id: 'record-after-padding', url: 'https://example.test/é/🦊?a=1&b=2' } };
    payload.padding = 'x'.repeat(size - JSON.stringify(payload).length);
    expect(JSON.stringify(payload)).toHaveLength(size);

    const emitted = await emitAwaitedEvent({ key, source: 'notify-payload-test', payload });
    expect(emitted.notified).toContain(recipient);
    expect(emitted.msgId).toBeTruthy();
    await recoverFromPreview(emitted.msgId!, payload);
  });

  it.each(['await', 'event-key'] as const)('preserves earlier %s notifications across repeated fires, field orders and a database reconnect', async kind => {
    const key = `notify-payload:batches:${kind}`;
    await subscribe(key, kind);
    const sent: Array<{ msgId: string; payload: unknown }> = [];
    for (let batch = 0; batch < 4; batch += 1) {
      for (let item = 0; item < 3; item += 1) {
        const decisive = { id: `record-${batch}-${item}`, path: `/records/${'完整🦊'.repeat(400)}/${batch}/${item}` };
        const padding = 'context '.repeat(350);
        const payload = item % 2 === 0 ? { padding, decisive } : { decisive, padding };
        const emitted = await emitAwaitedEvent({ key, source: 'notify-payload-test', payload });
        expect(emitted.notified).toContain(recipient);
        expect(emitted.msgId).toBeTruthy();
        sent.push({ msgId: emitted.msgId!, payload });
      }
    }

    // Drop memoized database connections before consuming older messages. A
    // newer latch value or sender-local state cannot stand in for persistence.
    await _resetForTests();
    for (const { msgId, payload } of sent.reverse()) await recoverFromPreview(msgId, payload);
  });
});
