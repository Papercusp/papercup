import { describe, it, expect } from 'vitest';
import {
  notifyQueenDraftRouted,
  notifyQueenRevised,
  type QueenNotifyMessage,
  type QueenNotifyPorts,
} from './queen-notify';
import type { RevisionOutcome } from './revise';

/**
 * WI-37625: the durable co-address is a PORT now, not a hardcoded `@role:mug`. It
 * defaults to the legacy slot here so every pre-existing assertion below keeps its
 * original meaning — those cases are the CALIBRATION for the retirement gate: they prove
 * the legacy park is still produced when the ladder resolves a deliverable Mug, so the
 * new routing tests cannot pass merely because the module stopped addressing anything.
 */
function recorder(durable: string[] = ['@role:mug']) {
  const sent: QueenNotifyMessage[] = [];
  const send = async (msg: QueenNotifyMessage) => {
    sent.push(msg);
  };
  const resolveDurableCoAddress = async () => durable;
  return { sent, send, resolveDurableCoAddress };
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
  it('pings the resolved Queen owner AND the durable @role:mug slot (WI-963)', async () => {
    const { sent, send, resolveDurableCoAddress } = recorder();
    const ports: QueenNotifyPorts = {
      resolveQueenOwner: async () => 'queen-owner-9',
      send,
      resolveDurableCoAddress,
    };
    const res = await notifyQueenDraftRouted(ports, {
      slug: 'scout-foo-2026-06-20',
      title: 'Foo',
      scoutOwner: 'scout:papercusp',
    });
    expect(res).toEqual({ notified: true, recipient: 'queen-owner-9' });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual(['queen-owner-9', '@role:mug']);
    expect(sent[0].planSlug).toBe('scout-foo-2026-06-20');
    expect(sent[0].summary).toMatch(/routed a new draft/i);
    expect(sent[0].body).toContain('scout:papercusp'); // the feedback address
  });

  it('still notifies via the durable @role:mug slot when there is no recent Queen session (WI-963)', async () => {
    const { sent, send, resolveDurableCoAddress } = recorder();
    const ports: QueenNotifyPorts = {
      resolveQueenOwner: async () => null,
      send,
      resolveDurableCoAddress,
    };
    const res = await notifyQueenDraftRouted(ports, { slug: 's-1', title: 'T', scoutOwner: 'scout:h' });
    expect(res).toEqual({ notified: true, recipient: null });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual(['@role:mug']);
  });

  it('still notifies via the durable @role:mug slot when resolve throws (never throws itself)', async () => {
    const { sent, send, resolveDurableCoAddress } = recorder();
    const ports: QueenNotifyPorts = {
      resolveQueenOwner: async () => {
        throw new Error('pg down');
      },
      send,
      resolveDurableCoAddress,
    };
    const res = await notifyQueenDraftRouted(ports, { slug: 's-1', title: 'T', scoutOwner: 'scout:h' });
    expect(res).toEqual({ notified: true, recipient: null });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual(['@role:mug']);
  });

  it('co-addresses the RESOLVED durable address, not a hardcoded @role:mug (WI-37625)', async () => {
    const { sent, send, resolveDurableCoAddress } = recorder(['su-live-7']);
    const ports: QueenNotifyPorts = {
      resolveQueenOwner: async () => 'queen-owner-9',
      send,
      resolveDurableCoAddress,
    };
    await notifyQueenDraftRouted(ports, { slug: 's-1', title: 'T', scoutOwner: 'scout:h' });
    expect(sent[0].to).toEqual(['queen-owner-9', 'su-live-7']);
    expect(sent[0].to).not.toContain('@role:mug');
  });

  /**
   * The failure this whole item exists to close: no Queen session AND a durable slot
   * nothing drains meant `to` was `['@role:mug']` alone — a notice addressed exclusively
   * to a slot with no reader, i.e. silently lost. It must never end up with no recipient.
   */
  it('escalates to the owner rather than sending into the void (WI-37625)', async () => {
    const { sent, send, resolveDurableCoAddress } = recorder([]);
    const ports: QueenNotifyPorts = {
      resolveQueenOwner: async () => null,
      send,
      resolveDurableCoAddress,
    };
    const res = await notifyQueenDraftRouted(ports, { slug: 's-1', title: 'T', scoutOwner: 'scout:h' });
    expect(res.notified).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual(['human']);
    expect(sent[0].to).not.toContain('@role:mug');
  });

  it('a durable-address resolution failure never throws or drops the ping (WI-37625)', async () => {
    const { sent, send } = recorder();
    const ports: QueenNotifyPorts = {
      resolveQueenOwner: async () => 'queen-owner-9',
      send,
      resolveDurableCoAddress: async () => {
        throw new Error('presence lookup down');
      },
    };
    const res = await notifyQueenDraftRouted(ports, { slug: 's-1', title: 'T', scoutOwner: 'scout:h' });
    expect(res.notified).toBe(true);
    expect(sent[0].to).toEqual(['queen-owner-9']);
  });

  it('returns notified:false but keeps recipient when send throws (best-effort)', async () => {
    const ports: QueenNotifyPorts = {
      resolveQueenOwner: async () => 'queen-1',
      send: async () => {
        throw new Error('coord down');
      },
      resolveDurableCoAddress: recorder().resolveDurableCoAddress,
    };
    const res = await notifyQueenDraftRouted(ports, { slug: 's-1', title: 'T', scoutOwner: 'scout:h' });
    expect(res).toEqual({ notified: false, recipient: 'queen-1' });
  });
});

describe('notifyQueenRevised (D-001 step 3 — continue the loop)', () => {
  it('pings each outcome back to the owner that sent the feedback, status-aware', async () => {
    const { sent, send, resolveDurableCoAddress } = recorder();
    const res = await notifyQueenRevised({ send, resolveDurableCoAddress }, [
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

  it('co-addresses the RESOLVED durable address, not a hardcoded @role:mug (WI-37625)', async () => {
    const { sent, send, resolveDurableCoAddress } = recorder(['su-live-7']);
    const res = await notifyQueenRevised({ send, resolveDurableCoAddress }, [
      outcome({ fromOwnerId: 'q-a' }),
    ]);
    expect(res.delivered).toBe(1);
    expect(sent[0].to).toEqual(['q-a', 'su-live-7']);
    expect(sent[0].to).not.toContain('@role:mug');
  });

  it('degrades to the threaded owner alone when nothing durable resolves (WI-37625)', async () => {
    const { sent, send, resolveDurableCoAddress } = recorder([]);
    const res = await notifyQueenRevised({ send, resolveDurableCoAddress }, [
      outcome({ fromOwnerId: 'q-a' }),
    ]);
    expect(res.delivered).toBe(1);
    expect(sent[0].to).toEqual(['q-a']);
  });

  it('skips outcomes with no recipient', async () => {
    const { sent, send, resolveDurableCoAddress } = recorder();
    const res = await notifyQueenRevised({ send, resolveDurableCoAddress }, [outcome({ fromOwnerId: '' })]);
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
    const res = await notifyQueenRevised({ send, resolveDurableCoAddress: async () => ['@role:mug'] }, [
      outcome({ fromOwnerId: 'q-1' }),
      outcome({ fromOwnerId: 'q-2' }),
    ]);
    expect(res.delivered).toBe(1);
    expect(sent).toEqual(['q-2']);
  });
});
