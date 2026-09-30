/**
 * Alerts about how a connected app uses its access
 * (external-app-access-to-workspaces-2026-09-29 P-011, D-028).
 *
 *   R-28  the first call from a new connected app raises an alert.
 *   R-42  the first call from a new network location for a connected app raises an alert.
 *
 * Driven through `onAppKeyUsed` — the path principal.ts runs for every valid key — with the use
 * write and the attention rail injected, so the test sees exactly what reaches the owner.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ReplaySafeAttentionNotifyInput } from '../attention-notify';
import { alertNotification, networkOf, onAppKeyUsed, type AppKeyUseOutcome } from './alerts';

// Copy-out mutation-probe seam: scripts/mutation-probe.sh points this at a mutated copy in its repo
// mirror, so the shared tree is never mutated. Unset, the real module loads.
vi.mock('./alerts', async (importOriginal) => {
  const probe = process.env.PAPERCUSP_ALERTS_PROBE;
  return probe ? await import(/* @vite-ignore */ probe) : await importOriginal();
});

const APP = { id: 'b'.repeat(16), workspace_id: 'ws-1', kind: 'app', label: 'phone shortcut' };

/** A fake key store: first use and seen networks, like recordAppKeyUse over the real tables. */
function harness() {
  let used = false;
  const networks = new Set<string>();
  const sent: ReplaySafeAttentionNotifyInput[] = [];
  const deps = {
    recordUse: async (_id: string, address: string | null): Promise<AppKeyUseOutcome> => {
      const firstUse = !used;
      used = true;
      const net = networkOf(address);
      const newNetwork = net && !networks.has(net) ? net : null;
      if (net) networks.add(net);
      return { firstUse, newNetwork };
    },
    notify: async (input: ReplaySafeAttentionNotifyInput) => { sent.push(input); },
  };
  return { sent, use: (address: string | null) => onAppKeyUsed(APP, address, deps) };
}

describe('R-28: a new app’s first call raises an alert', () => {
  it('the first call raises exactly one new-app alert to the owner', async () => {
    const h = harness();
    await h.use('203.0.113.7');
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({
      kind: 'intervention',
      workspaceId: 'ws-1',
      dedupeKey: `connected-app:new-app:${APP.id}`,
      data: { source: 'connected-app', alert: 'new-app', appId: APP.id },
    });
    expect(h.sent[0].title).toContain('phone shortcut');
    expect(h.sent[0].body).toContain('203.0.113.0/24');
  });

  it('a first call with no reported address still alerts', async () => {
    const h = harness();
    await h.use(null);
    expect(h.sent.map((n) => n.data?.alert)).toEqual(['new-app']);
  });

  it('later calls from the same network raise nothing', async () => {
    const h = harness();
    await h.use('203.0.113.7');
    await h.use('203.0.113.99');
    await h.use('203.0.113.7');
    expect(h.sent).toHaveLength(1);
  });

  it('a failed use write raises nothing and never throws into the request', async () => {
    const sent: ReplaySafeAttentionNotifyInput[] = [];
    const result = await onAppKeyUsed(APP, '203.0.113.7', {
      recordUse: async () => { throw new Error('db down'); },
      notify: async (n) => { sent.push(n); },
    });
    expect(result).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('a failed delivery is logged and swallowed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(onAppKeyUsed(APP, null, {
      recordUse: async () => ({ firstUse: true, newNetwork: null }),
      notify: async () => { throw new Error('push down'); },
    })).resolves.toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('new-app alert'), 'push down');
    warn.mockRestore();
  });
});

describe('R-42: a call from a new network location raises an alert', () => {
  it('the first call from a new network raises a new-location alert naming it', async () => {
    const h = harness();
    await h.use('203.0.113.7');
    await h.use('198.51.100.20');
    expect(h.sent.map((n) => n.data?.alert)).toEqual(['new-app', 'new-location']);
    expect(h.sent[1].dedupeKey).toBe(`connected-app:new-location:${APP.id}:198.51.100.0/24`);
    expect(h.sent[1].body).toContain('198.51.100.0/24');
  });

  it('each new network alerts once; returning to a known one does not', async () => {
    const h = harness();
    await h.use('203.0.113.7');
    await h.use('2001:db8:aa:1::5');
    await h.use('2001:db8:aa:ffff::9');
    await h.use('203.0.113.8');
    expect(h.sent.map((n) => n.data?.alert)).toEqual(['new-app', 'new-location']);
    expect(h.sent[1].dedupeKey).toBe(`connected-app:new-location:${APP.id}:2001:db8:aa::/48`);
  });
});

describe('networkOf', () => {
  it('groups addresses into the networks a location is judged by', () => {
    expect(networkOf('203.0.113.7')).toBe('203.0.113.0/24');
    expect(networkOf('::ffff:203.0.113.7')).toBe('203.0.113.0/24');
    expect(networkOf('2001:0db8:00aa:0001::5')).toBe('2001:db8:aa::/48');
    expect(networkOf('::1')).toBe('0:0:0::/48');
    expect(networkOf('  ')).toBeNull();
    expect(networkOf(null)).toBeNull();
    expect(networkOf('Proxy-Name')).toBe('proxy-name');
  });
});

describe('alertNotification', () => {
  it('a cap-reached alert is high importance and keyed to its window', () => {
    const n = alertNotification({ kind: 'spend-cap-reached', app: APP, spentCents: 500, capCents: 500, windowStartMs: 1000 });
    expect(n).toMatchObject({ importance: 'high', dedupeKey: `connected-app:spend-cap-reached:${APP.id}:1000` });
    expect(n.body).toContain('$5.00');
  });
});
