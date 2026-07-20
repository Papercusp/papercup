/**
 * domains — the topical targeting axis for pack items (EI-18121672688225947).
 *
 * Contract under test: untagged items behave exactly as before the field
 * existed (seed + deliver everywhere); domain-tagged items reach only hives
 * whose `knowledge-packs:domains` declaration intersects; an undeclared hive
 * receives untagged items only (conservative, mirrors the D-008 repo-less
 * posture for shapes).
 */
import { describe, expect, it } from 'vitest';
import { filterByDomains, parseLearningFile, type LearningItem } from './pack-format';
import { runFleetLessonsDeliveryTick, type DeliveryTickDeps } from './delivery';

const item = (id: string, domains?: string[]): LearningItem => ({
  id,
  title: id,
  kind: 'feedback',
  appliesTo: ['any'],
  ...(domains ? { domains } : {}),
  text: 'body',
});

describe('parseLearningFile domains', () => {
  it('absent domains stays undefined (untagged)', () => {
    const { item: parsed } = parseLearningFile('---\ntitle: T\n---\nbody', 'x');
    expect(parsed?.domains).toBeUndefined();
  });

  it('parses, dedupes, and validates kebab-case domains', () => {
    const { item: parsed } = parseLearningFile(
      '---\ntitle: T\ndomains: [replication, replication, distributed-systems]\n---\nbody',
      'x',
    );
    expect(parsed?.domains).toEqual(['replication', 'distributed-systems']);
  });

  it('rejects non-kebab and empty domains lists', () => {
    expect(parseLearningFile('---\ntitle: T\ndomains: [Not Kebab]\n---\nbody', 'x').error).toMatch(
      /kebab-case/,
    );
    expect(parseLearningFile('---\ntitle: T\ndomains: []\n---\nbody', 'x').error).toMatch(
      /must not be empty/,
    );
  });
});

describe('filterByDomains', () => {
  const items = [item('untagged'), item('repl', ['replication']), item('ui-lore', ['design'])];

  it('undeclared hive gets untagged items only', () => {
    expect(filterByDomains(items).map((i) => i.id)).toEqual(['untagged']);
    expect(filterByDomains(items, []).map((i) => i.id)).toEqual(['untagged']);
  });

  it('declared domains admit intersecting items plus untagged', () => {
    expect(filterByDomains(items, ['replication']).map((i) => i.id)).toEqual([
      'untagged',
      'repl',
    ]);
  });
});

describe('delivery tick domain targeting', () => {
  const pack = {
    manifest: { id: 'fleet-lessons', title: 't', description: 'd', version: '0.1.0' },
    items: [item('untagged'), item('repl', ['replication'])],
  };

  const deps = (declared: Record<string, string[] | undefined>): DeliveryTickDeps & {
    planned: Record<string, string[]>;
  } => {
    const planned: Record<string, string[]> = {};
    return {
      planned,
      loadPack: async () => pack,
      listHives: async () => Object.keys(declared).map((slug) => ({ slug })),
      disabledPacks: async () => [],
      declaredDomains: async (slug) => declared[slug],
      plan: async (slug, p) => {
        planned[slug] = p.items.map((i) => i.id);
        return {
          packId: p.manifest.id,
          installedVersions: [],
          availableVersion: p.manifest.version,
          newItems: { items: p.items.map((i) => ({ item: i, verdict: 'clean' as const })), clean: p.items.length, duplicates: 0, conflicts: 0, present: 0 },
          presentRows: 0,
        } as unknown as Awaited<ReturnType<DeliveryTickDeps['plan']>>;
      },
      apply: async (_slug, _p, review) =>
        ({ installed: (review as { clean: number }).clean, skipped: 0, failed: 0 }) as Awaited<
          ReturnType<DeliveryTickDeps['apply']>
        >,
    };
  };

  it('tagged items reach only declaring hives; untagged reach everyone', async () => {
    const d = deps({ declares: ['replication'], silent: undefined });
    const res = await runFleetLessonsDeliveryTick({ workspaceId: 'ws' }, d);
    expect(d.planned['declares']).toEqual(['untagged', 'repl']);
    expect(d.planned['silent']).toEqual(['untagged']);
    expect(res.hivesDelivered).toBe(2);
  });
});
