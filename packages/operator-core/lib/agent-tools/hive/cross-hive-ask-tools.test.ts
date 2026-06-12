/**
 * Front-door cross-Hive tools (hive-network-surface-2026-06-11 P-003, brief B-04).
 * PG-free + swarm-free: the send composition (cross-hive-ask-send) takes injected
 * ports, and the tools resolve their boundary/store through runtime registries
 * (cross-hive-boundary-registry / a fake store) — so a fake boundary + fake store
 * exercise hive:ask / hive:request_work / hive:asks end-to-end.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  sendCrossHiveAsk,
  type SendCrossHiveAskDeps,
  type CheckOutboundGrant,
} from '../../cross-hive-ask-send';
import type { CrossHiveBoundaryWiring } from '../../cross-hive-wiring';
import type { SendResult } from '../../cross-hive-transport';
import {
  registerCrossHiveBoundary,
  __clearCrossHiveBoundaryRegistry,
} from '../../cross-hive-boundary-registry';
import { __setCrossHiveAskTestDeps } from './_cross-hive-ask-deps';
import type { CrossHiveAsksStore, CrossHiveAsk } from '../../cross-hive-asks-store-port';
import type { InsertCrossHiveAskInput, ListCrossHiveAsksFilter } from '../../cross-hive-asks-pg';

const ROOT_CTX = { isSuperuser: true, uiClientId: 'su-test', workspaceId: 'ws-1' } as never;
const parse = (r: { content: Array<{ text: string }> }): Record<string, unknown> =>
  JSON.parse(r.content[0].text);
type Tool = { handler: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }> }> };

const allowGrant: CheckOutboundGrant = async () => ({ allowed: true, reason: 'granted' });

/** A fake boundary recording sends; `delivered` toggles the queued/sent path. */
function fakeBoundary(delivered: boolean): {
  wiring: CrossHiveBoundaryWiring;
  sends: Array<{ to: string; kind: string; id?: string; subject: string; body: string }>;
} {
  const sends: Array<{ to: string; kind: string; id?: string; subject: string; body: string }> = [];
  const wiring = {
    selfHivePubkey: 'self-pub',
    async send(
      to: string,
      msg: { kind: string; subject: string; body: string; id?: string },
    ): Promise<SendResult> {
      sends.push({ to, kind: msg.kind, id: msg.id, subject: msg.subject, body: msg.body });
      return { delivered, queued: !delivered };
    },
    async reply() {
      return { delivered, queued: !delivered };
    },
    async flushOutbox() {
      return { delivered: 0, pending: 0 };
    },
    async close() {},
  } as unknown as CrossHiveBoundaryWiring;
  return { wiring, sends };
}

/** An in-memory C-1 store mirroring PgCrossHiveAsks's insert-queued / mark-sent / list. */
function fakeStore(): { store: CrossHiveAsksStore; rows: CrossHiveAsk[] } {
  const rows: CrossHiveAsk[] = [];
  const store: CrossHiveAsksStore = {
    async insertQueued(ws, slug, input: InsertCrossHiveAskInput) {
      const existing = rows.find((r) => r.correlationId === input.correlationId);
      if (existing) return existing; // idempotent on correlation_id
      const row: CrossHiveAsk = {
        id: input.correlationId,
        workspaceId: ws,
        hiveSlug: slug,
        peerPubkey: input.peerPubkey,
        direction: input.direction ?? 'out',
        kind: input.kind,
        subject: input.subject ?? '',
        body: input.body ?? '',
        correlationId: input.correlationId,
        state: 'queued',
        replyBody: null,
        replyTs: null,
        askedBy: input.askedBy ?? null,
        createdAt: '2026-06-11T00:00:00Z',
        updatedAt: '2026-06-11T00:00:00Z',
      };
      rows.push(row);
      return row;
    },
    async markSentByCorrelationId(_ws, _slug, correlationId) {
      const row = rows.find((r) => r.correlationId === correlationId);
      if (row && row.state === 'queued') row.state = 'sent';
    },
    async list(_ws, _slug, filter: ListCrossHiveAsksFilter) {
      return rows.filter(
        (r) =>
          (!filter.state || r.state === filter.state) &&
          (!filter.direction || r.direction === filter.direction) &&
          (!filter.peerPubkey || r.peerPubkey === filter.peerPubkey) &&
          (!filter.kind || r.kind === filter.kind),
      );
    },
  };
  return { store, rows };
}

describe('sendCrossHiveAsk (composition)', () => {
  const baseInput = {
    workspaceId: 'ws-1',
    hiveSlug: 'home',
    peerPubkey: 'peer-pub',
    kind: 'ask' as const,
    subject: 's',
    body: 'b',
  };

  it('delivered: records queued→sent, sends with correlationId as the envelope id, returns the await keys', async () => {
    const fb = fakeBoundary(true);
    const fs = fakeStore();
    const deps: SendCrossHiveAskDeps = {
      resolveBoundary: () => fb.wiring,
      checkOutboundGrant: allowGrant,
      store: fs.store,
      newId: () => 'corr-1',
    };
    const res = await sendCrossHiveAsk(baseInput, deps);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.correlationId).toBe('corr-1');
    expect(res.state).toBe('sent');
    expect(res.delivered).toBe(true);
    expect(res.answeredEvent).toBe('cross-hive:answered:corr-1');
    expect(res.declinedEvent).toBe('cross-hive:declined:corr-1');
    // envelope id === correlation id (so the peer reply correlates back)
    expect(fb.sends).toEqual([{ to: 'peer-pub', kind: 'ask', id: 'corr-1', subject: 's', body: 'b' }]);
    expect(fs.rows).toHaveLength(1);
    expect(fs.rows[0]).toMatchObject({ correlationId: 'corr-1', direction: 'out', kind: 'ask', state: 'sent' });
  });

  it('peer offline: row stays queued (durable outbox retries)', async () => {
    const fb = fakeBoundary(false);
    const fs = fakeStore();
    const res = await sendCrossHiveAsk(baseInput, {
      resolveBoundary: () => fb.wiring,
      checkOutboundGrant: allowGrant,
      store: fs.store,
      newId: () => 'corr-2',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.state).toBe('queued');
    expect(res.delivered).toBe(false);
    expect(fs.rows[0]).toMatchObject({ state: 'queued' });
  });

  it('outbound grant denied: no send, no ledger row', async () => {
    const fb = fakeBoundary(true);
    const fs = fakeStore();
    const res = await sendCrossHiveAsk(baseInput, {
      resolveBoundary: () => fb.wiring,
      checkOutboundGrant: async () => ({ allowed: false, reason: 'no outbound grant for peer' }),
      store: fs.store,
      newId: () => 'corr-3',
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toMatch(/no outbound grant/);
    expect(fb.sends).toHaveLength(0);
    expect(fs.rows).toHaveLength(0);
  });

  it('boundary not live: clear error, nothing sent or recorded', async () => {
    const fs = fakeStore();
    const insertSpy = vi.spyOn(fs.store, 'insertQueued');
    const res = await sendCrossHiveAsk(baseInput, {
      resolveBoundary: () => undefined,
      checkOutboundGrant: allowGrant,
      store: fs.store,
      newId: () => 'corr-4',
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toMatch(/not live/);
    expect(insertSpy).not.toHaveBeenCalled();
    expect(fs.rows).toHaveLength(0);
  });

  it('work-request kind flows through unchanged', async () => {
    const fb = fakeBoundary(true);
    const fs = fakeStore();
    const res = await sendCrossHiveAsk(
      { ...baseInput, kind: 'work-request' },
      { resolveBoundary: () => fb.wiring, checkOutboundGrant: allowGrant, store: fs.store, newId: () => 'corr-5' },
    );
    expect(res.ok).toBe(true);
    expect(fb.sends[0]?.kind).toBe('work-request');
    expect(fs.rows[0]).toMatchObject({ kind: 'work-request', direction: 'out' });
  });
});

/**
 * Tool-level: register a fake boundary in the real registry (so the tool→registry
 * path is exercised) and substitute the store/grant ports via the deps test seam.
 */
describe('hive:ask / hive:request_work / hive:asks (tools)', () => {
  let fb: ReturnType<typeof fakeBoundary>;
  let fs: ReturnType<typeof fakeStore>;

  beforeEach(() => {
    __clearCrossHiveBoundaryRegistry();
    fb = fakeBoundary(true);
    fs = fakeStore();
    registerCrossHiveBoundary('ws-1', 'home', fb.wiring);
    __setCrossHiveAskTestDeps({ store: fs.store, checkOutboundGrant: allowGrant });
  });
  afterEach(() => {
    __setCrossHiveAskTestDeps(null);
    __clearCrossHiveBoundaryRegistry();
  });

  it('hive:ask resolves the registered boundary + store and returns the await key', async () => {
    const tool = (await import('./ask')).default as unknown as Tool;
    const res = parse(
      await tool.handler({ hive: 'home', peerHivePubkey: 'peer-pub', subject: 's', body: 'b', workspace: 'ws-1' }, ROOT_CTX),
    );
    expect(res.ok).toBe(true);
    expect((res.answeredEvent as string).startsWith('cross-hive:answered:')).toBe(true);
    expect(fb.sends[0]).toMatchObject({ to: 'peer-pub', kind: 'ask' });
    expect(fs.rows[0]).toMatchObject({ kind: 'ask', direction: 'out', state: 'sent' });
  });

  it('hive:request_work sends a work-request envelope', async () => {
    const tool = (await import('./request_work')).default as unknown as Tool;
    const res = parse(
      await tool.handler({ hive: 'home', peerHivePubkey: 'peer-pub', subject: 's', body: 'b', workspace: 'ws-1' }, ROOT_CTX),
    );
    expect(res.ok).toBe(true);
    expect(fb.sends[0]).toMatchObject({ kind: 'work-request' });
    expect(fs.rows[0]).toMatchObject({ kind: 'work-request' });
  });

  it('hive:ask surfaces a clear error when the Hive has no live boundary', async () => {
    __clearCrossHiveBoundaryRegistry(); // home is now dark
    const tool = (await import('./ask')).default as unknown as Tool;
    const res = parse(
      await tool.handler({ hive: 'home', peerHivePubkey: 'peer-pub', subject: 's', body: 'b', workspace: 'ws-1' }, ROOT_CTX),
    );
    expect(res.ok).toBe(false);
    expect(res.reason as string).toMatch(/not live/);
  });

  it('hive:asks lists + filters the ledger', async () => {
    const askTool = (await import('./ask')).default as unknown as Tool;
    await askTool.handler({ hive: 'home', peerHivePubkey: 'peer-a', subject: 's1', body: 'b', workspace: 'ws-1' }, ROOT_CTX);
    await askTool.handler({ hive: 'home', peerHivePubkey: 'peer-b', subject: 's2', body: 'b', workspace: 'ws-1' }, ROOT_CTX);

    const asksTool = (await import('./asks')).default as unknown as Tool;
    const all = parse(await asksTool.handler({ hive: 'home', workspace: 'ws-1' }, ROOT_CTX));
    expect(all.count).toBe(2);

    const onePeer = parse(await asksTool.handler({ hive: 'home', peerHivePubkey: 'peer-a', workspace: 'ws-1' }, ROOT_CTX));
    expect(onePeer.count).toBe(1);
    expect((onePeer.asks as CrossHiveAsk[])[0]?.peerPubkey).toBe('peer-a');

    const sent = parse(await asksTool.handler({ hive: 'home', state: 'sent', workspace: 'ws-1' }, ROOT_CTX));
    expect(sent.count).toBe(2);
  });
});
