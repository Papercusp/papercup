import { describe, expect, it } from 'vitest';
import {
  evaluateWaitingCheck,
  isExcludedWaitKey,
  keyQualifies,
  planSlugFromKey,
  runWaitingCheck,
  workItemIdFromKey,
  REPEAT_AFTER_MS,
  type ExistingNotice,
  type KeyResolution,
  type WaitKeyStats,
  type WaitingCheckDeps,
} from './waiting-check';

const H = 3_600_000;
// 2026-11-09 02:07Z — the first missed alarm of the 9 November incident.
const T0 = Date.parse('2026-11-09T02:07:00Z');
const INCIDENT_KEY =
  'plan:parent-pinned-workspace-metadata-coherence-2026-11-08:metadata-source-qualified:parent-pinned-workspace-metadata-coherence-2026-11-08';

function stats(over: Partial<WaitKeyStats> & { eventKey: string }): WaitKeyStats {
  return {
    firstWaitAtMs: T0 - 1 * H,
    missedAlarms: 3,
    waiters: ['su-a', 'su-b'],
    lastActivityAtMs: T0 + 3 * H,
    workspaceId: 'ws',
    ...over,
  };
}

const incidentItem: KeyResolution = {
  item: { id: 'WI-6554700010046610', harness: 'papercusp', assignee: null, status: 'open' },
  declarer: 'su-declarer',
};

/** In-memory deps that persist notices the way the condition item does (survives a "restart"). */
function memoryDeps(input: { stats: WaitKeyStats[]; resolutions: Map<string, KeyResolution>; now: () => number }) {
  const store = new Map<string, ExistingNotice>();
  const sent: Array<{ recipient: string; action: string; title: string }> = [];
  let seq = 0;
  const deps: WaitingCheckDeps = {
    nowMs: input.now,
    loadStats: async () => input.stats,
    resolveKeys: async () => input.resolutions,
    loadExisting: async (keys) => new Map(keys.filter((k) => store.has(k)).map((k) => [k, { ...store.get(k)! }])),
    upsertNotice: async (flag) => {
      const prior = store.get(flag.conditionKey);
      if (prior) return { id: prior.conditionItemId, created: false };
      const id = `EI-${++seq}`;
      store.set(flag.conditionKey, { conditionItemId: id, firstNoticeAtMs: input.now(), repeatSentAtMs: null });
      return { id, created: true };
    },
    markRepeatSent: async (id, atMs) => {
      for (const v of store.values()) {
        if (v.conditionItemId === id && v.repeatSentAtMs == null) {
          v.repeatSentAtMs = atMs;
          return true;
        }
      }
      return false;
    },
    notify: async (flag, text) => {
      sent.push({ recipient: flag.recipient, action: flag.action, title: text.title });
    },
  };
  return { deps, store, sent };
}

describe('waiting check rule (R-2)', () => {
  it('flags at 4 hours with 3 missed alarms, not before', () => {
    const s = stats({ eventKey: INCIDENT_KEY, firstWaitAtMs: T0, lastActivityAtMs: T0 + 3.9 * H });
    expect(keyQualifies(s, T0 + 3.9 * H)).toBe(false);
    expect(keyQualifies({ ...s, lastActivityAtMs: T0 + 4 * H }, T0 + 4 * H)).toBe(true);
    expect(keyQualifies({ ...s, missedAlarms: 2, lastActivityAtMs: T0 + 5 * H }, T0 + 5 * H)).toBe(false);
  });

  it('stays quiet once nobody has waited for 6 hours', () => {
    const s = stats({ eventKey: INCIDENT_KEY, firstWaitAtMs: T0, lastActivityAtMs: T0 + 5 * H });
    expect(keyQualifies(s, T0 + 12 * H)).toBe(false);
  });

  it('excludes the two routine shared signals and self-wakes', () => {
    for (const k of ['git-sync:committed', 'resource:released:git-sync:papercusp', 'coord:inbox-wake:su-x', 'turn-end:rewake:su-x']) {
      expect(isExcludedWaitKey(k)).toBe(true);
      expect(keyQualifies(stats({ eventKey: k, missedAlarms: 50 }), T0 + 4 * H)).toBe(false);
    }
    expect(isExcludedWaitKey(INCIDENT_KEY)).toBe(false);
    expect(isExcludedWaitKey('resource:released:npm-install')).toBe(false);
  });

  it('parses item and plan keys', () => {
    expect(workItemIdFromKey('work-item:done:WI-6554700010046610')).toBe('WI-6554700010046610');
    expect(workItemIdFromKey('work-item:status:EI-12')).toBe('EI-12');
    expect(workItemIdFromKey('task:terminal:abc')).toBeNull();
    expect(planSlugFromKey(INCIDENT_KEY)).toBe('parent-pinned-workspace-metadata-coherence-2026-11-08');
    expect(planSlugFromKey('plan:acceptance:some-plan')).toBeNull();
  });

  it('groups several signals behind one item into one flag', () => {
    const resolutions = new Map([
      [INCIDENT_KEY, incidentItem],
      ['work-item:done:WI-6554700010046610', incidentItem],
    ]);
    const flags = evaluateWaitingCheck({
      stats: [
        stats({ eventKey: INCIDENT_KEY, missedAlarms: 10, waiters: ['su-a', 'su-b'] }),
        stats({ eventKey: 'work-item:done:WI-6554700010046610', missedAlarms: 5, waiters: ['su-b', 'su-c'] }),
      ],
      resolutions,
      existing: new Map(),
      nowMs: T0 + 4 * H,
    });
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({
      groupKey: 'item:WI-6554700010046610',
      missedAlarms: 15,
      waiters: ['su-a', 'su-b', 'su-c'],
      recipient: 'su-declarer',
      action: 'first-notice',
    });
  });

  it('sends the notice to the assignee, else the declarer, else the owner', () => {
    const base = { stats: [stats({ eventKey: 'k:1' })], existing: new Map(), nowMs: T0 + 4 * H };
    const assigned: KeyResolution = { item: { id: 'WI-1', harness: null, assignee: 'su-holder', status: 'wip' }, declarer: 'su-d' };
    expect(evaluateWaitingCheck({ ...base, resolutions: new Map([['k:1', assigned]]) })[0].recipient).toBe('su-holder');
    expect(evaluateWaitingCheck({ ...base, resolutions: new Map([['k:1', { item: null, declarer: 'su-d' }]]) })[0].recipient).toBe('su-d');
    expect(evaluateWaitingCheck({ ...base, resolutions: new Map() })[0].recipient).toBe('human');
  });
});

describe('waiting check runner — the 9 November incident replay', () => {
  it('raises one notice on the first day, none after a restart, and one repeat at 24 hours', async () => {
    let now = T0 + 4 * H; // ~06:07Z on 9 November
    const incident = stats({ eventKey: INCIDENT_KEY, firstWaitAtMs: T0, missedAlarms: 12, waiters: ['su-a', 'su-b', 'su-c'] });
    const live = () => ({ ...incident, lastActivityAtMs: now });
    const resolutions = new Map([[INCIDENT_KEY, incidentItem]]);
    const mem = memoryDeps({ stats: [incident], resolutions, now: () => now });
    mem.deps.loadStats = async () => [live()];

    const first = await runWaitingCheck(mem.deps);
    expect(first.firstNotices).toBe(1);
    expect(mem.sent).toHaveLength(1);
    expect(mem.sent[0].title).toContain('WI-6554700010046610');
    expect(new Date(now).toISOString().slice(0, 10)).toBe('2026-11-09');

    // Operator restart: a fresh runner over the same durable store sends nothing new.
    for (const step of [1, 6, 12, 23]) {
      now = T0 + 4 * H + step * H;
      const again = await runWaitingCheck({ ...mem.deps });
      expect(again.firstNotices + again.repeatNotices).toBe(0);
    }
    expect(mem.sent).toHaveLength(1);

    // 24 hours after the first notice: exactly one repeat, then silence.
    now = T0 + 4 * H + REPEAT_AFTER_MS;
    expect((await runWaitingCheck(mem.deps)).repeatNotices).toBe(1);
    now += 30 * H;
    expect((await runWaitingCheck(mem.deps)).repeatNotices).toBe(0);
    expect(mem.sent.map((s) => s.action)).toEqual(['first-notice', 'repeat-notice']);
  });

  it('does not message when another run already filed the condition item', async () => {
    const now = T0 + 5 * H;
    const mem = memoryDeps({ stats: [stats({ eventKey: 'k:1', lastActivityAtMs: now })], resolutions: new Map(), now: () => now });
    mem.deps.upsertNotice = async () => ({ id: 'EI-x', created: false });
    const res = await runWaitingCheck(mem.deps);
    expect(res.firstNotices).toBe(0);
    expect(mem.sent).toHaveLength(0);
  });

  it('keeps going when one notice fails', async () => {
    const now = T0 + 5 * H;
    const mem = memoryDeps({
      stats: [stats({ eventKey: 'k:1', lastActivityAtMs: now }), stats({ eventKey: 'k:2', lastActivityAtMs: now })],
      resolutions: new Map(),
      now: () => now,
    });
    const logs: string[] = [];
    const notify = mem.deps.notify;
    mem.deps.notify = async (flag, text, id) => {
      if (flag.keys[0] === 'k:1') throw new Error('boom');
      await notify(flag, text, id);
    };
    mem.deps.log = (l) => logs.push(l);
    const res = await runWaitingCheck(mem.deps);
    expect(res.firstNotices).toBe(1);
    expect(logs.join('\n')).toContain('boom');
  });
});
