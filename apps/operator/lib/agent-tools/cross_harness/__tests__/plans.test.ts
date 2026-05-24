/**
 * cross_harness:plans_* tool wrapper tests (P-013 of
 * per-harness-plans-and-docs-2026-05-23).
 *
 * Covers the operator-side glue: per-harness plans-dir resolution,
 * unknown-slug error envelope, workspaceId passthrough, and the
 * format pass-through. The parsing/search engine is exercised by
 * plans/__tests__/*.test.ts; these tests verify the routing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

let tmpDir: string;

const MAKE_CTX = (over: Record<string, unknown> = {}) =>
  ({
    log: vi.fn(),
    signal: new AbortController().signal,
    metadata: vi.fn(),
    workspaceId: 'default',
    role: 'operator' as const,
    runId: 'run_T',
    spawnId: 'spw_T',
    ...over,
  } as never);

function parsePayload(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0].text);
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cross-harness-plans-test-'));
  // Non-papercup harness convention: <harness.path>/docs/plans/
  await fs.mkdir(path.join(tmpDir, 'docs', 'plans'), { recursive: true });
  await fs.writeFile(
    path.join(tmpDir, 'docs', 'plans', 'sheets-feature-x-2026-05-24.md'),
    `---
title: Sheets feature X
slug: sheets-feature-x-2026-05-24
status: active
created: 2026-05-24
updated: 2026-05-24
owner: someone@example.com
---

## Now

**State:** kickoff
**Next:** finish phase 1

## Phase 1 — kickoff

- **P-001** \`todo\` Build the thing.
`,
    'utf-8',
  );
  vi.resetModules();
});

afterEach(async () => {
  vi.doUnmock('@/lib/harness-registry');
  vi.doUnmock('@/lib/harness/register-papercup');
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function mockRegistry(projects: Array<{ slug: string; path: string }>) {
  vi.doMock('@/lib/harness-registry', () => ({
    loadHarnessRegistry: vi.fn(async () => ({ projects })),
  }));
}

function mockPapercupDetection(detected: string | null) {
  vi.doMock('@/lib/harness/register-papercup', () => ({
    PAPERCUP_HARNESS_SLUG: 'papercup',
    detectPapercupRoot: vi.fn(() => detected),
  }));
}

describe('cross_harness:plans_list', () => {
  it('throws when the harness is not registered', async () => {
    mockRegistry([]);
    mockPapercupDetection(null);
    const tool = (await import('../plans_list')).default;
    await expect(tool.handler({ harnessSlug: 'missing' }, MAKE_CTX())).rejects.toThrow(
      /harness 'missing' not registered/,
    );
  });

  it('lists plans for a registered harness', async () => {
    mockRegistry([{ slug: 'sheets', path: tmpDir }]);
    mockPapercupDetection(null);
    const tool = (await import('../plans_list')).default;
    const result = await tool.handler({ harnessSlug: 'sheets' }, MAKE_CTX());
    const payload = parsePayload(result);
    expect(payload.harnessSlug).toBe('sheets');
    const plans = payload.plans as Array<{ slug: string; title: string }>;
    expect(plans).toHaveLength(1);
    expect(plans[0].slug).toBe('sheets-feature-x-2026-05-24');
    expect(plans[0].title).toBe('Sheets feature X');
  });

  it('forwards workspaceId to loadHarnessRegistry', async () => {
    const reg = vi.fn(async () => ({ projects: [{ slug: 'sheets', path: tmpDir }] }));
    vi.doMock('@/lib/harness-registry', () => ({ loadHarnessRegistry: reg }));
    mockPapercupDetection(null);
    const tool = (await import('../plans_list')).default;
    await tool.handler({ harnessSlug: 'sheets', workspaceId: 'other-ws' }, MAKE_CTX());
    expect(reg).toHaveBeenCalledWith('other-ws');
  });
});

describe('cross_harness:plans_get', () => {
  it('returns not_found when the plan slug is unknown', async () => {
    mockRegistry([{ slug: 'sheets', path: tmpDir }]);
    mockPapercupDetection(null);
    const tool = (await import('../plans_get')).default;
    const result = await tool.handler(
      { harnessSlug: 'sheets', slug: 'does-not-exist' },
      MAKE_CTX(),
    );
    expect(result.isError).toBe(true);
    const payload = parsePayload(result);
    expect(payload.error).toBe('not_found');
    expect(payload.harnessSlug).toBe('sheets');
  });

  it('returns the parsed plan when slug is known', async () => {
    mockRegistry([{ slug: 'sheets', path: tmpDir }]);
    mockPapercupDetection(null);
    const tool = (await import('../plans_get')).default;
    const result = await tool.handler(
      { harnessSlug: 'sheets', slug: 'sheets-feature-x-2026-05-24' },
      MAKE_CTX(),
    );
    const payload = parsePayload(result);
    expect(payload.harnessSlug).toBe('sheets');
    expect(payload.legacy).toBe(false);
    const frontmatter = payload.frontmatter as { title: string };
    expect(frontmatter.title).toBe('Sheets feature X');
    const items = payload.items as Array<{ id: string }>;
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('P-001');
  });
});

describe('cross_harness:plans_search', () => {
  it('finds the plan by title keyword', async () => {
    mockRegistry([{ slug: 'sheets', path: tmpDir }]);
    mockPapercupDetection(null);
    const tool = (await import('../plans_search')).default;
    const result = await tool.handler(
      { harnessSlug: 'sheets', query: 'sheets' },
      MAKE_CTX(),
    );
    const payload = parsePayload(result);
    expect(payload.harnessSlug).toBe('sheets');
    const hits = payload.hits as Array<{ plan: string; score: number }>;
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].plan).toBe('sheets-feature-x-2026-05-24');
  });

  it('finds by item-text keyword', async () => {
    mockRegistry([{ slug: 'sheets', path: tmpDir }]);
    mockPapercupDetection(null);
    const tool = (await import('../plans_search')).default;
    const result = await tool.handler(
      { harnessSlug: 'sheets', query: 'thing', scope: ['items'] },
      MAKE_CTX(),
    );
    const payload = parsePayload(result);
    const hits = payload.hits as Array<{ plan: string; matches: Array<{ scope: string }> }>;
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].matches[0].scope).toBe('items');
  });

  it('empty query → empty hits', async () => {
    mockRegistry([{ slug: 'sheets', path: tmpDir }]);
    mockPapercupDetection(null);
    const tool = (await import('../plans_search')).default;
    const result = await tool.handler(
      { harnessSlug: 'sheets', query: '   ' },
      MAKE_CTX(),
    );
    const payload = parsePayload(result);
    expect(payload.hits).toEqual([]);
  });
});
