/**
 * topics-handlers.test.ts — handler-level projection tests for the topics:* tool
 * surfaces (topics:list / topics:merge). The PG-wired layer
 * (`../topics`) is mocked at the module seam; identity is faked; the handler +
 * its zod schema run REAL. Pins the projection logic each handler owns:
 *   • topics:list — `subscribed` Set keyed off the subscription target_ref,
 *     `merged_into` surfaced, includeMerged passed through to listTopics.
 *   • topics:merge — `subscribers_moved` taken from the core result's `moved`.
 *
 * `topics:subscribe` was RETIRED 2026-08-09 (coordination-spec-adoption-2026-08-03
 * D-102) — the named sugar for `watch:create { targetKind:'topic', wake:false }`,
 * zero calls in 30 days despite being prescribed by name in seven role prompts.
 * Its handler test moved with it to `_retired/topics-subscribe/`. The `../topics`
 * `subscribeTopic` seam stays mocked here because `topics:list` reads the rows the
 * hysteresis machine and `watch:create` still write.
 * (No handler test existed for these — BRIEF target T4.)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubscriptionRow, TopicRow } from '@papercusp/coordination/capabilities';

// ── module-seam mocks (arrow-deref so the hoisted factory sees them) ──────────
const listTopics = vi.fn<(o?: { includeMerged?: boolean }) => Promise<TopicRow[]>>();
const listMyTopicSubscriptions = vi.fn<() => Promise<SubscriptionRow[]>>();
const subscribeTopic =
  vi.fn<(...a: unknown[]) => Promise<SubscriptionRow>>();
const mergeTopics = vi.fn<(...a: unknown[]) => Promise<{ moved: number }>>();
vi.mock('../topics', () => ({
  listTopics: (...a: unknown[]) => listTopics(...(a as [])),
  listMyTopicSubscriptions: (...a: unknown[]) => listMyTopicSubscriptions(...(a as [])),
  subscribeTopic: (...a: unknown[]) => subscribeTopic(...(a as [])),
  mergeTopics: (...a: unknown[]) => mergeTopics(...(a as [])),
}));

const resolveAgentIdentity = vi.fn(() => ({ ownerId: 'su-test', ownerLabel: 'su · test' }));
vi.mock('../identity', () => ({
  resolveAgentIdentity: (...a: unknown[]) => resolveAgentIdentity(...(a as [])),
}));

// SUT imported AFTER the seams are wired.
import topicsListTool from './topics-list';
import topicsMergeTool from './topics-merge';

type Tool = {
  args: { parse: (x: unknown) => unknown };
  handler: (a: unknown, c: unknown) => Promise<{ content?: Array<{ text: string }>; data?: unknown }>;
};
const listTool = topicsListTool as unknown as Tool;
const mergeTool = topicsMergeTool as unknown as Tool;
const ctx = {} as never;
const parse = (t: Tool, x: unknown) => t.args.parse(x);
// topics:list / topics:merge are NOT bulk — they still return a raw { content } ToolResult.
const raw = (r: { content?: Array<{ text: string }> }): Record<string, unknown> =>
  JSON.parse(r.content![0].text);

const topic = (slug: string, over: Partial<TopicRow> = {}): TopicRow => ({
  slug,
  title: slug,
  description: `${slug} desc`,
  created_by: 'system',
  merged_into: null,
  created_ts: '2026-06-04T00:00:00.000Z',
  ...over,
});
const sub = (target_ref: string, over: Partial<SubscriptionRow> = {}): SubscriptionRow => ({
  id: 1,
  subscriber_id: 'su-test',
  target_kind: 'topic',
  target_ref,
  delivery_mode: 'full',
  created_ts: '2026-06-04T00:00:00.000Z',
  expires_ts: null,
  ...over,
});

beforeEach(() => {
  listTopics.mockResolvedValue([]);
  listMyTopicSubscriptions.mockResolvedValue([]);
});
afterEach(() => vi.clearAllMocks());

describe('topics:list handler projection', () => {
  it('marks `subscribed` per topic from the subscription set and surfaces merged_into', async () => {
    listTopics.mockResolvedValue([
      topic('coord-dx'),
      topic('db-tooling'),
      topic('old-area', { merged_into: 'coord-dx' }),
    ]);
    listMyTopicSubscriptions.mockResolvedValue([
      sub('coord-dx', { delivery_mode: 'digest', expires_ts: '2027-01-01T00:00:00.000Z' }),
    ]);

    const res = raw(await listTool.handler(parse(listTool, { includeMerged: true }), ctx));
    expect(res.ok).toBe(true);
    const topics = res.topics as Array<Record<string, unknown>>;
    const bySlug = Object.fromEntries(topics.map((t) => [t.slug, t]));
    // subscribed flips ONLY for the followed slug.
    expect(bySlug['coord-dx'].subscribed).toBe(true);
    expect(bySlug['db-tooling'].subscribed).toBe(false);
    expect(bySlug['old-area'].subscribed).toBe(false);
    // merged_into rides through.
    expect(bySlug['old-area'].merged_into).toBe('coord-dx');
    expect(bySlug['coord-dx'].merged_into).toBeNull();
    // my_subscriptions projects topic/mode/expires.
    expect(res.my_subscriptions).toEqual([
      { topic: 'coord-dx', mode: 'digest', expires_ts: '2027-01-01T00:00:00.000Z' },
    ]);
  });

  it('passes includeMerged through to listTopics (default omitted → undefined)', async () => {
    await listTool.handler(parse(listTool, {}), ctx);
    expect(listTopics).toHaveBeenCalledWith({ includeMerged: undefined });

    await listTool.handler(parse(listTool, { includeMerged: true }), ctx);
    expect(listTopics).toHaveBeenLastCalledWith({ includeMerged: true });
  });
});

describe('topics:merge handler projection', () => {
  it('returns subscribers_moved from the core moved count + echoes from/into', async () => {
    mergeTopics.mockResolvedValue({ moved: 3 });
    const res = raw(await mergeTool.handler(parse(mergeTool, { from: 'fed', into: 'federation' }), ctx));
    expect(res).toMatchObject({ ok: true, from: 'fed', into: 'federation', subscribers_moved: 3 });
    expect(mergeTopics).toHaveBeenCalledWith(
      { ownerId: 'su-test', ownerLabel: 'su · test' },
      'fed',
      'federation',
    );
  });
});
