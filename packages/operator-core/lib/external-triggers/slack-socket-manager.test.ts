import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  SlackSocketManager,
  startSlackSocketManager,
  type SlackSocketLike,
} from './slack-socket-manager';
import type { ExternalTriggerSourceRow } from './source-store';

class FakeSocket extends EventEmitter implements SlackSocketLike {
  sent: string[] = [];
  send(payload: string): void { this.sent.push(payload); }
  close(): void { this.emit('close', 1000, Buffer.alloc(0)); }
}

const source: ExternalTriggerSourceRow = {
  id: '11111111-1111-4111-8111-111111111111',
  workspaceId: 'papercusp-workspace',
  kind: 'slack',
  ownerUserId: '22222222-2222-4222-8222-222222222222',
  credentialRef: 'slack-socket:owner',
  providerAccountId: 'T1',
  status: 'connecting',
  config: { installSlug: 'papercusp' },
  cursor: {},
};

describe('SlackSocketManager', () => {
  it('ACKs a burst immediately, serializes ingest, and reconnects with bounded backoff', async () => {
    let now = 1_000;
    const sockets: FakeSocket[] = [];
    let release!: () => void;
    const first = new Promise<void>((resolve) => { release = resolve; });
    const processEnvelope = vi.fn(async (_source, envelope) => {
      if (envelope.envelope_id === 'e-1') await first;
      return null;
    });
    const updateSource = vi.fn(async (_sql, _workspace, _id, input) => ({
      ...source, status: input.status, cursor: input.cursor ?? source.cursor,
    }));
    const manager = new SlackSocketManager({
      sql: {} as never,
      workspaceId: () => 'papercusp-workspace',
      now: () => now,
      listSources: vi.fn(async () => [source]),
      resolveCredentials: vi.fn(async () => ({ appToken: 'xapp-token', botToken: 'xoxb-token' })),
      reconcileHistory: vi.fn(async (value) => value),
      openUrl: vi.fn(async () => 'wss://slack.test/socket'),
      createSocket: vi.fn(() => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      }),
      processEnvelope,
      updateSource,
      log: () => {},
    });

    await manager.reconcile();
    sockets[0].emit('open');
    for (const id of ['e-1', 'e-2', 'e-3']) {
      sockets[0].emit('message', JSON.stringify({ envelope_id: id, type: 'events_api', payload: {} }));
    }
    expect(sockets[0].sent.map((payload) => JSON.parse(payload))).toEqual([
      { envelope_id: 'e-1' }, { envelope_id: 'e-2' }, { envelope_id: 'e-3' },
    ]);
    // ACK delivery is synchronous; the serialized ingest chain starts on the
    // next microtask, so none of the deliberately-blocked work has begun yet.
    expect(processEnvelope).toHaveBeenCalledTimes(0);
    release();
    await vi.waitFor(() => expect(processEnvelope).toHaveBeenCalledTimes(3));

    sockets[0].emit('close', 1006, Buffer.from('refresh'));
    await manager.reconcile();
    expect(sockets).toHaveLength(1);
    now += 1_000;
    await manager.reconcile();
    expect(sockets).toHaveLength(2);
    manager.stop();
  });

  it('opens the "Report a bug" form at once with the bot token, outside the serialized ingest chain', async () => {
    const sockets: FakeSocket[] = [];
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const processEnvelope = vi.fn(async () => { await blocked; return null; });
    const openReportBugModal = vi.fn(async () => {});
    const reportingSource: ExternalTriggerSourceRow = {
      ...source,
      config: { installSlug: 'papercusp', reportBug: { channels: { C1: { shortcut: true } } } },
    };
    const manager = new SlackSocketManager({
      sql: {} as never,
      workspaceId: () => 'papercusp-workspace',
      listSources: vi.fn(async () => [reportingSource]),
      resolveCredentials: vi.fn(async () => ({ appToken: 'xapp-token', botToken: 'xoxb-token' })),
      reconcileHistory: vi.fn(async (value) => value),
      openUrl: vi.fn(async () => 'wss://slack.test/socket'),
      createSocket: vi.fn(() => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      }),
      processEnvelope,
      openReportBugModal,
      updateSource: vi.fn(async (_sql, _workspace, _id, input) => ({ ...reportingSource, status: input.status })),
      log: () => {},
    });

    await manager.reconcile();
    sockets[0].emit('open');
    // An earlier envelope is stuck in the ingest chain…
    sockets[0].emit('message', JSON.stringify({ envelope_id: 'e-slow', type: 'events_api', payload: {} }));
    // …and the click still opens its form without waiting behind it.
    sockets[0].emit('message', JSON.stringify({
      envelope_id: 'e-click',
      type: 'interactive',
      payload: {
        type: 'message_action', callback_id: 'papercusp_report_bug', trigger_id: 'trig-9',
        user: { id: 'U4' }, channel: { id: 'C1' }, message: { ts: '1777000003.000300', text: 'broken' },
      },
    }));
    expect(sockets[0].sent.map((payload) => JSON.parse(payload))).toEqual([{ envelope_id: 'e-slow' }, { envelope_id: 'e-click' }]);
    await vi.waitFor(() => expect(openReportBugModal).toHaveBeenCalledTimes(1));
    expect(openReportBugModal).toHaveBeenCalledWith('xoxb-token', {
      triggerId: 'trig-9', channelId: 'C1', messageTs: '1777000003.000300', threadTs: null, reporterUserId: 'U4',
    });
    release();
    // The click itself never reaches ingest; only the slow envelope does.
    await vi.waitFor(() => expect(processEnvelope).toHaveBeenCalledTimes(1));
    expect(processEnvelope.mock.calls.map((call) => (call as unknown[])[1])).toEqual([
      expect.objectContaining({ envelope_id: 'e-slow' }),
    ]);
    manager.stop();
  });

  it('reuses one starter state across repeated module evaluation', async () => {
    const first = startSlackSocketManager({
      listSources: vi.fn(async () => []),
    });
    const secondListSources = vi.fn(async () => {
      throw new Error('a repeated module record must not start another manager');
    });

    try {
      vi.resetModules();
      const repeated = await import('./slack-socket-manager');
      const second = repeated.startSlackSocketManager({ listSources: secondListSources });

      expect(repeated.startSlackSocketManager).not.toBe(startSlackSocketManager);
      expect(second).toBe(first);
      expect(second.manager).toBe(first.manager);
      expect(second.timer).toBe(first.timer);
      expect(secondListSources).not.toHaveBeenCalled();
    } finally {
      first.timer.stop();
      first.manager.stop();
    }
  });
});
