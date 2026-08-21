/**
 * Regression coverage for EI-19447621925540921: optional index-list filters
 * must not mint a new PostgreSQL statement shape for every combination.
 *
 * This uses a tiny postgres.js-compatible tag seam so the test can inspect the
 * final flattened SQL and bind list without needing a live database.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Fragment = {
  __fragment: true;
  strings: readonly string[];
  values: unknown[];
};

type Flattened = { text: string; values: unknown[] };

const H = vi.hoisted(() => {
  const statements: Flattened[] = [];

  const isFragment = (value: unknown): value is Fragment =>
    !!value && typeof value === 'object' && (value as { __fragment?: unknown }).__fragment === true;

  const flatten = (fragment: Fragment): Flattened => {
    let text = '';
    const values: unknown[] = [];
    for (let i = 0; i < fragment.strings.length; i += 1) {
      text += fragment.strings[i] ?? '';
      if (i >= fragment.values.length) continue;
      const value = fragment.values[i];
      if (isFragment(value)) {
        const nested = flatten(value);
        text += nested.text;
        values.push(...nested.values);
      } else {
        values.push(value);
        text += `$${values.length}`;
      }
    }
    return { text, values };
  };

  const tx = (strings: TemplateStringsArray, ...values: unknown[]): Fragment => ({
    __fragment: true,
    strings: [...strings],
    values,
  });

  const withWorkspace = async (_workspaceId: string, run: (sql: typeof tx) => unknown) => {
    const result = await run(tx);
    if (!isFragment(result)) throw new Error('test SQL seam received a non-fragment result');
    statements.push(flatten(result));
    return [];
  };

  return { statements, withWorkspace };
});

vi.mock('@papercusp/db-org', async (original) => {
  const actual = await original<typeof import('@papercusp/db-org')>();
  return { ...actual, withWorkspace: H.withWorkspace };
});

vi.mock('../../../hive-federation', async (original) => {
  const actual = await original<typeof import('../../../hive-federation')>();
  return {
    ...actual,
    potHomeSlugForHarness: vi.fn(async (_workspaceId: string, harnessSlug: string) => harnessSlug),
  };
});

import { listPlanIndexRows, listPlanIndexRowsForWorkspace } from '../source';

beforeEach(() => {
  H.statements.length = 0;
});

function queryWithoutPlaceholderNumbers(sql: string): string {
  return sql.replace(/\$\d+/g, '$N');
}

describe('harness_plans index-list query shape', () => {
  it('keeps the per-harness statement shape stable across optional filters', async () => {
    const scope = { harnessSlug: 'shape-harness', workspaceId: 'shape-workspace' };
    await listPlanIndexRows({ ...scope, order: 'updated', includeItems: false, heavyFields: true });
    await listPlanIndexRows({
      ...scope,
      includeArchived: true,
      status: 'active',
      includeInstances: true,
      template: 'rubric',
      templateSlug: 'rubric-root',
      createdSince: '2026-08-01T00:00:00.000Z',
      updatedSince: '2026-08-02T00:00:00.000Z',
      order: 'updated',
      limit: 5,
      includeItems: false,
      heavyFields: true,
    });

    expect(H.statements).toHaveLength(2);
    expect(queryWithoutPlaceholderNumbers(H.statements[1]!.text)).toBe(
      queryWithoutPlaceholderNumbers(H.statements[0]!.text),
    );
    expect(H.statements[1]!.values).toHaveLength(H.statements[0]!.values.length);
    expect(H.statements[0]!.text).toContain('LIMIT $');
    expect(H.statements[0]!.text).toContain('status = $');
    expect(H.statements[0]!.text).toContain('created_at >= $');
    expect(H.statements[0]!.text).toContain('forced_past');
  });

  it('keeps the workspace-wide statement shape stable across optional filters', async () => {
    await listPlanIndexRowsForWorkspace({
      workspaceId: 'shape-workspace',
      order: 'created',
      includeItems: false,
      heavyFields: true,
    });
    await listPlanIndexRowsForWorkspace({
      workspaceId: 'shape-workspace',
      includeArchived: true,
      status: 'active',
      includeInstances: true,
      template: 'rubric',
      templateSlug: 'rubric-root',
      createdSince: '2026-08-01T00:00:00.000Z',
      updatedSince: '2026-08-02T00:00:00.000Z',
      order: 'created',
      limit: 5,
      includeItems: false,
      heavyFields: true,
    });

    expect(H.statements).toHaveLength(2);
    expect(queryWithoutPlaceholderNumbers(H.statements[1]!.text)).toBe(
      queryWithoutPlaceholderNumbers(H.statements[0]!.text),
    );
    expect(H.statements[1]!.values).toHaveLength(H.statements[0]!.values.length);
    expect(H.statements[0]!.text).toContain('forced_past');
  });
});
