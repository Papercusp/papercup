import { describe, it, expect } from 'vitest';
import {
  notifyQueenDraftRouted,
  notifyQueenRevised,
  type QueenNotifyMessage,
  type QueenNotifyPorts,
} from './queen-notify';
import type { RevisionOutcome } from './revise';

function recorder() {
  const sent: QueenNotifyMessage[] = [];
  const send = async (msg: QueenNotifyMessage) => {
    sent.push(msg);
  };
  return { sent, send };
}

const outcome = (over: Partial<RevisionOutcome>): RevisionOutcome => ({
  planSlug: 'scout-x-2026-06-20',
  fromOwnerId: 'queen-1',
  msgId: 'm-1',
  status: 'revised',
  costUsd: 0.01,
  note: 'revised to address feedback',
  ...over,
});

describe('notifyQueenDraftRouted (D-003 #1 — start the loop)', () => {
  it('pings the resolved Queen owner with the plan slug', async () => {
    const { sent, send } = recorder();
    const ports: QueenNotifyPorts = { resolveQueenOwner: async () => 'queen-owner-9', send };
    const res = await notifyQueenDraftRouted(ports, {
      slug: 'scout-foo-2026-06-20',
      title: 'Foo',
      scoutOwner: 'scout:papercusp',
    });
    expect(res).toEqual({ notified: true, recipient: 'queen-owner-9' });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual(['queen-owner-9']);
    expect(sent[0].planSlug).toBe('scout-foo-2026-06-20');
    expect(sent[0].summary).toMatch(/routed a new draft/i);
    expect(sent[0].body).toContain('scout:papercusp'); // the feedback address
  });

  it('skips (no send) when there is no recent Queen session', async () => {
    const { sent, send } = recorder();
    const ports: QueenNotifyPorts = { resolveQueenOwner: async () => null, send };
    const res = await notifyQueenDraftRouted(ports, { slug: 's-1', title: 'T', scoutOwner: 'scout:h' });
    expect(res).toEqual({ notified: false, recipient: null, reason: 'no-queen-session' });
    expect(sent).toHaveLength(0);
  });

  it('degrades to not-notified when resolve throws (never throws)', async () => {
    const { sent, send } = recorder();
    const ports: QueenNotifyPorts = {
      resolveQueenOwner: async () => {
        throw new Error('pg down');
      },
      send,
    };
    const res = await notifyQueenDraftRouted(ports, { slug: 's-1', title: 'T', scoutOwner: 'scout:h' });
    expect(res.notified).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('returns notified:false but keeps recipient when send throws (best-effort)', async () => {
    const ports: QueenNotifyPorts = {
      resolveQueenOwner: async () => 'queen-1',
      send: async () => {
        throw new Error('coord down');
      },
    };
    const res = await notifyQueenDraftRouted(ports, { slug: 's-1', title: 'T', scoutOwner: 'scout:h' });
    expect(res).toEqual({ notified: false, recipient: 'queen-1' });
  });
});

describe('notifyQueenRevised (D-001 step 3 — continue the loop)', () => {
  it('pings each outcome back to the owner that sent the feedback, status-aware', async () => {
    const { sent, send } = recorder();
    const res = await notifyQueenRevised({ send }, [
      outcome({ planSlug: 'a', fromOwnerId: 'q-a', status: 'revised' }),
      outcome({ planSlug: 'b', fromOwnerId: 'q-b', status: 'missing', note: 'gone' }),
    ]);
    expect(res.delivered).toBe(2);
    expect(sent.map((s) => s.to[0]).sort()).toEqual(['q-a', 'q-b']);
    const revised = sent.find((s) => s.planSlug === 'a')!;
    expect(revised.summary).toMatch(/re-review/i);
    const missing = sent.find((s) => s.planSlug === 'b')!;
    expect(missing.summary).toMatch(/no longer exists/i);
  });

  it('skips outcomes with no recipient', async () => {
    const { sent, send } = recorder();
    const res = await notifyQueenRevised({ send }, [outcome({ fromOwnerId: '' })]);
    expect(res.delivered).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it('one failed send does not stop the rest', async () => {
    const sent: string[] = [];
    let n = 0;
    const send = async (m: QueenNotifyMessage) => {
      n += 1;
      if (n === 1) throw new Error('first fails');
      sent.push(m.to[0]);
    };
    const res = await notifyQueenRevised({ send }, [
      outcome({ fromOwnerId: 'q-1' }),
      outcome({ fromOwnerId: 'q-2' }),
    ]);
    expect(res.delivered).toBe(1);
    expect(sent).toEqual(['q-2']);
  });
});
