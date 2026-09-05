/**
 * topics-list.test.ts — regression coverage for topics:list discovery.
 *
 * coord_topics is a curated registry, but work-item/issue writers create live
 * topic-tag edges in coord_links without first registering the slug. The
 * production read must merge both populations, keep registered metadata, and
 * preserve includeMerged filtering.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TopicRow } from '@papercusp/coordination/capabilities';

type SqlFragment = { kind: 'fragment'; text: string };
type SqlMock = ReturnType<typeof vi.fn>;

const scope = { value: 'ws-alpha' };
let registry: TopicRow[] = [];
let taggedLive: Array<{ slug: string; created_at: string }> = [];
let taggedIncludingMerged: Array<{ slug: string; created_at: string }> = [];

function topic(slug: string, over: Partial<TopicRow> = {}): TopicRow {
  return {
    slug,
    title: slug,
    description: `${slug} curated`,
    created_by: 'system',
    merged_into: null,
    created_ts: '2026-06-04T00:00:00.000Z',
    ...over,
  };
}

async function loadTopics(): Promise<{ listTopics: typeof import('./topics').listTopics; sql: SqlMock }> {
  vi.resetModules();
  const sql = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('');
    if (text.includes('coord_links')) {
      const includeMerged = values.some(
        (value): value is SqlFragment => Boolean(value && typeof value === 'object' && (value as SqlFragment).text === 'TRUE'),
      );
      return Promise.resolve(includeMerged ? taggedIncludingMerged : taggedLive);
    }
    return { kind: 'fragment', text } satisfies SqlFragment;
  });

  vi.doMock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql }) }));
  vi.doMock('@papercusp/coordination/capabilities', () => ({
    PgTopicStore: class {
      constructor(public readonly opts: { getWorkspaceId: () => string }) {}
      async list(opts: { includeMerged?: boolean } = {}): Promise<TopicRow[]> {
        return registry.filter((row) => opts.includeMerged || row.merged_into == null);
      }
    },
    PgEntitySubscriptionStore: class {},
  }));
  vi.doMock('./log', () => ({
    coordLog: {},
    coordScopeReady: vi.fn(async () => {}),
    coordScopeWorkspace: () => scope.value,
  }));
  vi.doMock('./topics-core', () => ({
    NEW_TOPIC: 'new_topic',
    ensureBuiltinTopics: vi.fn(async () => {}),
    createTopicCore: vi.fn(),
    mergeTopicsCore: vi.fn(),
  }));

  const mod = await import('./topics');
  return { listTopics: mod.listTopics, sql };
}

beforeEach(() => {
  registry = [];
  taggedLive = [];
  taggedIncludingMerged = [];
  scope.value = 'ws-alpha';
  vi.clearAllMocks();
});

describe('listTopics live tag discovery', () => {
  it('merges unregistered tagged slugs, keeps curated metadata, and preserves includeMerged', async () => {
    registry = [
      topic('curated', { description: 'human description' }),
      topic('merged', { merged_into: 'curated' }),
    ];
    taggedLive = [
      { slug: 'curated', created_at: '2026-06-05T00:00:00.000Z' },
      { slug: 'live-only', created_at: '2026-06-06T00:00:00.000Z' },
      // The LEFT JOIN + merged filter excludes this registered alias by default.
    ];
    taggedIncludingMerged = [
      ...taggedLive,
      { slug: 'merged', created_at: '2026-06-07T00:00:00.000Z' },
    ];

    const { listTopics } = await loadTopics();
    const liveOnly = await listTopics();
    expect(liveOnly.map((row) => row.slug)).toEqual(['curated', 'live-only']);
    expect(liveOnly.find((row) => row.slug === 'curated')).toMatchObject({
      title: 'curated',
      description: 'human description',
    });
    expect(liveOnly.find((row) => row.slug === 'live-only')).toMatchObject({
      title: 'Live tagged topic',
      description: expect.stringContaining('topics:create'),
      created_by: null,
      merged_into: null,
      created_ts: '2026-06-06T00:00:00.000Z',
    });

    const includingMerged = await listTopics({ includeMerged: true });
    expect(includingMerged.map((row) => row.slug)).toEqual(['curated', 'merged', 'live-only']);
    expect(includingMerged.find((row) => row.slug === 'merged')).toMatchObject({
      merged_into: 'curated',
      description: 'merged curated',
    });
  });

  it('uses the active coordination workspace for both registry and tagged-edge reads', async () => {
    registry = [topic('alpha')];
    taggedLive = [{ slug: 'alpha', created_at: '2026-06-05T00:00:00.000Z' }];
    taggedIncludingMerged = taggedLive;

    const { listTopics, sql } = await loadTopics();
    await listTopics();
    scope.value = 'ws-beta';
    await listTopics();

    const edgeQueries = sql.mock.calls.filter(([strings]) => strings.join('').includes('coord_links'));
    expect(edgeQueries).toHaveLength(2);
    expect(edgeQueries[0]![1]).toBe('ws-alpha');
    expect(edgeQueries[1]![1]).toBe('ws-beta');
  });
});
