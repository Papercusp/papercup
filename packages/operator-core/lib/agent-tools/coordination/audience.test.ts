/**
 * audience.test.ts — the pure audience-selector resolver
 * (coord-emit-subscription-scoping-2026-06-05, Brief 28).
 */
import { describe, it, expect } from 'vitest';
import {
  expandAudience,
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

  it('@file = active presence editing that file', async () => {
    const r = makeResolvers({
      presence: [
        { ownerId: 'editor', planSlug: null, files: ['apps/tui/src/app.rs', 'x'] },
        { ownerId: 'other', planSlug: null, files: ['y'] },
      ],
    });
    expect(await expandAudience(['@file:apps/tui/src/app.rs'], r)).toEqual(['editor']);
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
