import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ rendered: [] as string[] }));

vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({
    sql: ((strings: TemplateStringsArray, ...values: unknown[]) => {
      h.rendered.push(strings.reduce((acc, text, index) => acc + text + (index < values.length ? JSON.stringify(values[index] ?? null) : ''), ''));
      return Promise.resolve([]);
    }) as unknown,
  }),
}));

const { readRoutedIdeas } = await import('./routed-ledger');

const query = () => h.rendered.join('');

afterEach(() => {
  h.rendered.length = 0;
});

describe('readRoutedIdeas pot ownership scope (P-008)', () => {
  it('adds an explicit source-hive predicate for pot-local reads', async () => {
    await readRoutedIdeas({ workspaceId: 'ws-1', potSlug: 'pot-a' });
    expect(query()).toContain('AND source_hive = "pot-a"');
    expect(query()).not.toContain('AND harness_slug =');
  });

  it('keeps member-harness filtering unchanged when no pot scope is requested', async () => {
    await readRoutedIdeas({ workspaceId: 'ws-1', harnessSlug: 'member-a' });
    expect(query()).toContain('AND harness_slug = "member-a"');
    expect(query()).not.toContain('AND source_hive =');
  });

  it('composes pot and member scopes when both are explicit', async () => {
    await readRoutedIdeas({ workspaceId: 'ws-1', potSlug: 'pot-a', harnessSlug: 'member-a' });
    expect(query()).toContain('AND source_hive = "pot-a"');
    expect(query()).toContain('AND harness_slug = "member-a"');
  });
});
