/**
 * audience.test.ts — the pure audience-selector resolver
 * (coord-emit-subscription-scoping-2026-06-05, Brief 28).
 */
import { describe, it, expect } from 'vitest';
import {
  expandAudience,
  expandAudienceDetailed,
  hasAudienceSelector,
  objectSelector,
  type ActivePresence,
  type AudienceResolvers,
} from './audience';

function makeResolvers(opts: {
  /** `${kind}:${ref}` (kind = object|topic) → subscriber ownerIds. */
  subs?: Record<string, string[]>;
  presence?: ActivePresence[];
  /** `${objectKind}:${objectRef}` → topic slugs it is tagged to. */
  tagged?: Record<string, string[]>;
  /** fleet slug → live member ownerIds. */
  fleets?: Record<string, string[]>;
  /** fleet slug → leader ownerId. */
  fleetLeaders?: Record<string, string>;
  /** repo-relative path → ownerIds holding/awaiting a live file-lock on it. */
  lockAgents?: Record<string, string[]>;
  /** ownerIds absent from the roster ENTIRELY (reaped). Omit to model a host with
   *  no probe at all, which must report nothing unreachable. */
  reaped?: string[];
}): AudienceResolvers {
  return {
    async listTargetSubscribers(kind, ref) {
      return opts.subs?.[`${kind}:${ref}`] ?? [];
    },
    async listActivePresence() {
      return opts.presence ?? [];
    },
    async listTaggedTopics(kind, ref) {
      return opts.tagged?.[`${kind}:${ref}`] ?? [];
    },
    async listFleetMembers(slug) {
      return opts.fleets?.[slug] ?? [];
    },
    async listFleetLeader(slug) {
      const leader = opts.fleetLeaders?.[slug];
      return leader ? [leader] : [];
    },
    async listPathLockAgents(path) {
      return opts.lockAgents?.[path] ?? [];
    },
    ...(opts.reaped
      ? {
          async listUnreachableRecipients(ids: readonly string[]) {
            return ids.filter((id) => opts.reaped!.includes(id));
          },
        }
      : {}),
  };
}

describe('expandAudience', () => {
  it('passes plain ids, * and human through untouched', async () => {
    const r = makeResolvers({});
    expect(await expandAudience(['agent-1', '*', 'human'], r)).toEqual(['agent-1', '*', 'human']);
  });

  it('@plan = plan subscribers ∪ presence-on-plan ∪ tagged-topic subscribers', async () => {
    const r = makeResolvers({
      subs: { 'object:plan:my-plan': ['sub-1'], 'topic:area-x': ['topic-watcher'] },
      tagged: { 'plan:my-plan': ['area-x'] },
      presence: [
        { ownerId: 'on-plan', planSlug: 'my-plan', files: [] },
        { ownerId: 'elsewhere', planSlug: 'other', files: [] },
      ],
    });
    const out = await expandAudience(['@plan:my-plan'], r);
    expect(new Set(out)).toEqual(new Set(['sub-1', 'topic-watcher', 'on-plan']));
    expect(out).not.toContain('elsewhere');
  });

  it('@topic = topic subscribers', async () => {
    const r = makeResolvers({ subs: { 'topic:federation': ['a', 'b'] } });
    expect(new Set(await expandAudience(['@topic:federation'], r))).toEqual(new Set(['a', 'b']));
  });

  it('@object = object subscribers ∪ its tagged-topic subscribers', async () => {
    const r = makeResolvers({
      subs: { 'object:feature:h#F-1': ['owner-a'], 'topic:t1': ['topic-a'] },
      tagged: { 'feature:h#F-1': ['t1'] },
    });
    const out = await expandAudience([objectSelector({ kind: 'feature', ref: 'h#F-1' })], r);
    expect(new Set(out)).toEqual(new Set(['owner-a', 'topic-a']));
  });

  it('@object matches issue refs that contain no extra colon', async () => {
    const r = makeResolvers({ subs: { 'object:issue:ISS-1': ['issue-watcher'] } });
    const out = await expandAudience([objectSelector({ kind: 'issue', ref: 'ISS-1' })], r);
    expect(out).toEqual(['issue-watcher']);
  });

  it('@object work_item/work-item aliases resolve canonical issue subscriptions', async () => {
    const r = makeResolvers({
      subs: {
        // Keep a legacy row in the fixture too: compatibility must not strand it
        // while adding the canonical family-owned lookup.
        'object:work_item:WI-1': ['legacy-underscore'],
        'object:work-item:WI-1': ['legacy-hyphen'],
        'object:issue:WI-1': ['canonical-issue'],
      },
    });

    expect(await expandAudience(['@object:work_item:WI-1'], r)).toEqual([
      'legacy-underscore',
      'canonical-issue',
    ]);
    expect(await expandAudience(['@object:work-item:WI-1'], r)).toEqual([
      'legacy-hyphen',
      'canonical-issue',
    ]);
  });

  it('@object work-item aliases use a harness-qualified feature ref without crossing into issue refs', async () => {
    const r = makeResolvers({
      subs: {
        'object:feature:demo#WI-1': ['feature-watcher'],
        // A same-text issue ref must not be reached by a feature-shaped alias.
        'object:issue:demo#WI-1': ['wrong-family'],
      },
      tagged: { 'feature:demo#WI-1': ['feature-topic'] },
    });

    expect(await expandAudience(['@object:work_item:demo#WI-1'], r)).toEqual(['feature-watcher']);
    expect(await expandAudience(['@object:work-item:demo#WI-1'], r)).toEqual(['feature-watcher']);
  });

  it('@object work-item aliases do not broaden a bare id to every feature harness', async () => {
    const r = makeResolvers({
      subs: {
        'object:issue:WI-1': ['issue-watcher'],
        'object:feature:demo#WI-1': ['feature-watcher'],
      },
    });

    expect(await expandAudience(['@object:work_item:WI-1'], r)).toEqual(['issue-watcher']);
  });

  it('@file = active presence editing that file', async () => {
    const r = makeResolvers({
      presence: [
        { ownerId: 'editor', planSlug: null, files: ['apps/tui/src/app.rs', 'x'] },
        { ownerId: 'other', planSlug: null, files: ['y'] },
      ],
    });
    expect(await expandAudience(['@file:apps/tui/src/app.rs'], r)).toEqual(['editor']);
  });

  // EI-18772330418885814 — the recurrence guard. `@file:` used to read ONLY
  // presence.current_files, which is opt-in and reset to [] by every
  // coord:declare-intent that omits it (live: 119 presence rows, 0 with files). So
  // it answered "reached NOBODY live" while a peer held a lock on that exact path,
  // and that answer reads as a clearance to edit. If any of these four regress,
  // `@file:` is back to being unable to see a lock-holder.
  describe('@file: must see the LOCK plane, not just declared presence', () => {
    const PATH = 'apps/operator-vite/src/components/adv/LearningTab.tsx';

    it('resolves to a live lock-HOLDER even when NO agent declared the file', async () => {
      const r = makeResolvers({
        presence: [{ ownerId: 'someone-else', planSlug: null, files: [] }],
        lockAgents: { [PATH]: ['su-29fe4'] },
      });
      expect(await expandAudience([`@file:${PATH}`], r)).toEqual(['su-29fe4']);
    });

    it('resolves to an agent QUEUED on the path — a waiter is trying to edit it too', async () => {
      const r = makeResolvers({ lockAgents: { [PATH]: ['waiting-agent'] } });
      expect(await expandAudience([`@file:${PATH}`], r)).toEqual(['waiting-agent']);
    });

    it('UNIONS the declared-presence and lock halves, deduping an agent in both', async () => {
      const r = makeResolvers({
        presence: [
          { ownerId: 'declarer', planSlug: null, files: [PATH] },
          { ownerId: 'both', planSlug: null, files: [PATH] },
        ],
        lockAgents: { [PATH]: ['holder', 'both'] },
      });
      const out = await expandAudience([`@file:${PATH}`], r);
      expect(new Set(out)).toEqual(new Set(['declarer', 'both', 'holder']));
      expect(out).toHaveLength(3);
    });

    it('still resolves to empty — never a * fallback — when nobody is on the file', async () => {
      const r = makeResolvers({ lockAgents: { 'some/other/file.ts': ['elsewhere'] } });
      expect(await expandAudience([`@file:${PATH}`], r)).toEqual([]);
    });
  });

  it('@fleet = the live members of that named fleet', async () => {
    const r = makeResolvers({ fleets: { backend: ['alice', 'bob'] } });
    expect(new Set(await expandAudience(['@fleet:backend'], r))).toEqual(new Set(['alice', 'bob']));
  });

  it('@fleet with no live members resolves to empty — never a * fallback', async () => {
    const r = makeResolvers({ fleets: {} });
    expect(await expandAudience(['@fleet:paused-fleet'], r)).toEqual([]);
  });

  it('@fleet-leader = just the fleet leader (distinct from @fleet members)', async () => {
    const r = makeResolvers({
      fleets: { backend: ['alice', 'bob'] },
      fleetLeaders: { backend: 'alice' },
    });
    expect(await expandAudience(['@fleet-leader:backend'], r)).toEqual(['alice']);
    // @fleet-leader does NOT pull the whole roster.
    expect(await expandAudience(['@fleet-leader:backend'], r)).not.toContain('bob');
  });

  it('@fleet-leader with no leader set resolves to no one', async () => {
    const r = makeResolvers({ fleets: { backend: ['alice'] } });
    expect(await expandAudience(['@fleet-leader:backend'], r)).toEqual([]);
  });

  it('detailed expansion preserves an unresolved selector beside valid recipients', async () => {
    const r = makeResolvers({ fleets: { backend: ['alice'] } });
    await expect(
      expandAudienceDetailed(['@fleet-leader:backend', 'alice'], r),
    ).resolves.toEqual({
      resolved: ['alice'],
      unresolvedSelectors: ['@fleet-leader:backend'],
      unreachableSelectors: [],
    });
  });

  // EI-22180848452883121. The registry leader pointer is deliberately NOT
  // liveness-gated, so a REAPED leader resolves to exactly one id — cardinality 1,
  // which every cardinality-zero miss-signal is structurally blind to. Before this,
  // the caller got the full success shape for a message nobody would ever read.
  describe('reaped recipients (EI-22180848452883121)', () => {
    it('flags a @fleet-leader selector that resolved ONLY to a reaped session', async () => {
      const r = makeResolvers({
        fleets: { backend: ['bob'] },
        fleetLeaders: { backend: 'ghost' },
        reaped: ['ghost'],
      });
      const out = await expandAudienceDetailed(['@fleet-leader:backend'], r);
      // Delivery is UNCHANGED — this is a diagnostic, not a filter.
      expect(out.resolved).toEqual(['ghost']);
      // ...and critically NOT reported as unresolved: it did resolve, to a corpse.
      expect(out.unresolvedSelectors).toEqual([]);
      expect(out.unreachableSelectors).toEqual([
        { selector: '@fleet-leader:backend', ownerIds: ['ghost'] },
      ]);
    });

    it('does NOT flag a leader who is merely offline but still in the roster', async () => {
      // The distinction the whole fix rests on: an ended-but-recorded session still
      // owns a durable inbox, which is exactly what liveness-independent resolution
      // is FOR. Only a reaped id owns nothing.
      const r = makeResolvers({
        fleetLeaders: { backend: 'offline-but-recorded' },
        reaped: ['some-other-corpse'],
      });
      const out = await expandAudienceDetailed(['@fleet-leader:backend'], r);
      expect(out.resolved).toEqual(['offline-but-recorded']);
      expect(out.unreachableSelectors).toEqual([]);
    });

    it('does NOT flag a selector that reached at least one live recipient', async () => {
      // A partial fleet loss is explainFleetAudience's job; folding it in here would
      // make one field mean two different things.
      const r = makeResolvers({ fleets: { backend: ['alive', 'ghost'] }, reaped: ['ghost'] });
      const out = await expandAudienceDetailed(['@fleet:backend'], r);
      expect(out.unreachableSelectors).toEqual([]);
    });

    it('reports nothing unreachable when the host has no probe at all', async () => {
      // Fail-soft contract: absent means UNKNOWN, never "everyone is reachable".
      const r = makeResolvers({ fleetLeaders: { backend: 'ghost' } });
      expect(r.listUnreachableRecipients).toBeUndefined();
      const out = await expandAudienceDetailed(['@fleet-leader:backend'], r);
      expect(out.unreachableSelectors).toEqual([]);
    });

    it('reports nothing unreachable when the probe THROWS, and never fails the send', async () => {
      const r: AudienceResolvers = {
        ...makeResolvers({ fleetLeaders: { backend: 'ghost' } }),
        async listUnreachableRecipients() {
          throw new Error('roster read exploded');
        },
      };
      const out = await expandAudienceDetailed(['@fleet-leader:backend'], r);
      expect(out.resolved).toEqual(['ghost']);
      expect(out.unreachableSelectors).toEqual([]);
    });

    it('never probes * or human — they are channels, not sessions', async () => {
      const probed: string[][] = [];
      const r: AudienceResolvers = {
        ...makeResolvers({}),
        async listUnreachableRecipients(ids) {
          probed.push([...ids]);
          return [...ids];
        },
      };
      // Broadcast mode collapses every selector to '*'; probing it would report the
      // kill-switch itself as unreachable.
      const out = await expandAudienceDetailed(['@fleet-leader:backend'], r, 'broadcast');
      expect(out.resolved).toEqual(['*']);
      expect(out.unreachableSelectors).toEqual([]);
      expect(probed.flat()).not.toContain('*');
    });

    it('does not flag a plain ownerId the caller typed — that path has its own refusal', async () => {
      // A literal reaped id is already refused with unknown_recipient by the roster
      // check; double-reporting it here would blur which addressing form failed.
      const r = makeResolvers({ reaped: ['ghost'] });
      const out = await expandAudienceDetailed(['ghost'], r);
      expect(out.resolved).toEqual(['ghost']);
      expect(out.unreachableSelectors).toEqual([]);
    });
  });

  it('@fleet and @fleet-leader compose with other selectors and dedup', async () => {
    const r = makeResolvers({
      fleets: { backend: ['alice', 'bob'] },
      fleetLeaders: { backend: 'alice' },
      subs: { 'topic:t': ['carol'] },
    });
    const out = await expandAudience(['@fleet:backend', '@fleet-leader:backend', '@topic:t', 'alice'], r);
    expect(new Set(out)).toEqual(new Set(['alice', 'bob', 'carol']));
    expect(out.filter((x) => x === 'alice')).toHaveLength(1);
  });

  it('broadcast mode collapses @fleet to * (the kill-switch widens, never narrows)', async () => {
    const r = makeResolvers({ fleets: { backend: ['alice'] } });
    expect(await expandAudience(['@fleet:backend'], r, 'broadcast')).toEqual(['*']);
  });

  it('an empty @fleet / @fleet-leader body resolves to no one', async () => {
    const r = makeResolvers({ fleets: { '': ['x'] }, fleetLeaders: { '': 'y' } });
    expect(await expandAudience(['@fleet:', '@fleet-leader:'], r)).toEqual([]);
  });

  it('dedups across selectors and plain ids', async () => {
    const r = makeResolvers({ subs: { 'object:plan:p': ['dup'], 'topic:t': ['dup', 'uniq'] } });
    const out = await expandAudience(['dup', '@plan:p', '@topic:t'], r);
    expect(out.filter((x) => x === 'dup')).toHaveLength(1);
    expect(new Set(out)).toEqual(new Set(['dup', 'uniq']));
  });

  it('broadcast mode collapses every selector to * (the kill-switch)', async () => {
    const r = makeResolvers({ subs: { 'object:plan:p': ['sub'] } });
    expect(await expandAudience(['@plan:p', 'agent-9'], r, 'broadcast')).toEqual(['*', 'agent-9']);
  });

  it('an unknown selector resolves to no one (never * on a typo)', async () => {
    const r = makeResolvers({});
    expect(await expandAudience(['@bogus:x'], r)).toEqual([]);
  });

  it('a selector with no watchers resolves to empty — never a * fallback', async () => {
    const r = makeResolvers({});
    expect(await expandAudience(['@plan:ghost'], r)).toEqual([]);
  });

  it('an empty selector body resolves to no one (never a broadcast — the guard fires before any resolver call)', async () => {
    const r = makeResolvers({
      subs: { 'topic:': ['x'], 'object:': ['y'] }, // would match only if the empty-body guard failed
      presence: [{ ownerId: 'p', planSlug: null, files: [''] }],
    });
    expect(await expandAudience(['@plan:', '@topic:', '@object:', '@file:'], r)).toEqual([]);
  });

  it('trims surrounding whitespace in a selector body before resolving', async () => {
    const r = makeResolvers({ subs: { 'topic:federation': ['a'] } });
    expect(await expandAudience(['@topic:  federation  '], r)).toEqual(['a']);
  });

  it('@object with a ref containing NO colon resolves direct subscribers only (no tagged-topic lookup)', async () => {
    let taggedCalls = 0;
    const r: AudienceResolvers = {
      async listTargetSubscribers(kind, ref) {
        return kind === 'object' && ref === 'plainref' ? ['direct'] : [];
      },
      async listActivePresence() {
        return [];
      },
      async listTaggedTopics() {
        taggedCalls += 1;
        return [];
      },
      async listFleetMembers() {
        return [];
      },
      async listFleetLeader() {
        return [];
      },
      async listPathLockAgents() {
        return [];
      },
    };
    expect(await expandAudience(['@object:plainref'], r)).toEqual(['direct']);
    expect(taggedCalls).toBe(0); // colon <= 0 → the tagged-topic branch is skipped
  });

  it('calls listActivePresence at most once across multiple presence selectors', async () => {
    let calls = 0;
    const r: AudienceResolvers = {
      async listTargetSubscribers() {
        return [];
      },
      async listActivePresence() {
        calls += 1;
        return [{ ownerId: 'p', planSlug: 'plan-a', files: ['f'] }];
      },
      async listTaggedTopics() {
        return [];
      },
      async listFleetMembers() {
        return [];
      },
      async listFleetLeader() {
        return [];
      },
      async listPathLockAgents() {
        return [];
      },
    };
    await expandAudience(['@plan:plan-a', '@file:f'], r);
    expect(calls).toBe(1);
  });
});

describe('hasAudienceSelector', () => {
  it('detects @-selectors and ignores plain recipients', () => {
    expect(hasAudienceSelector(['a', '@plan:x'])).toBe(true);
    expect(hasAudienceSelector(['a', '*', 'human'])).toBe(false);
    expect(hasAudienceSelector([])).toBe(false);
  });
});

describe('objectSelector', () => {
  it('builds the canonical @object:<kind>:<ref> selector', () => {
    expect(objectSelector({ kind: 'feature', ref: 'h#F-1' })).toBe('@object:feature:h#F-1');
    expect(objectSelector({ kind: 'issue', ref: 'ISS-1' })).toBe('@object:issue:ISS-1');
  });
});
