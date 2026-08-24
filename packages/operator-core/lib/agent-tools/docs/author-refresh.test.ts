import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocPageRefresh } from '../../search/doc-embed-sync';

const h = vi.hoisted(() => {
  const order: string[] = [];
  return {
    order,
    existsSync: vi.fn(() => false),
    mkdir: vi.fn(async () => undefined),
    writeFile: vi.fn(async () => undefined),
    resolveHarnessDocPaths: vi.fn(async () => ({ docsRoot: '/tmp/docs-author-refresh-test' })),
    safeJoinUnderRoot: vi.fn((_root: string, docId: string) => `/tmp/docs-author-refresh-test/${docId}`),
    anchorManualDoc: vi.fn(async (_args: { content: string }) => ({
      ok: true,
      anchored: true,
      record: { status: 'active' },
      subjectRef: [],
    })),
    applyProjectionBanner: vi.fn((content: string) => content),
    getAuthoredDocContent: vi.fn<() => Promise<string | null>>(async () => null),
    engineeringAdapter: { name: 'engineering-adapter-test-double' },
    invalidateEngineeringAdapter: vi.fn(() => {
      order.push('invalidate');
    }),
    refreshDocPageSections: vi.fn<() => Promise<DocPageRefresh>>(async () => {
      order.push('refresh');
      return { ok: true, sections: 1, unchanged: false };
    }),
  };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: h.existsSync,
    promises: { ...actual.promises, mkdir: h.mkdir, writeFile: h.writeFile },
  };
});
vi.mock('../../harness/docs/harness-repo', () => ({ resolveHarnessDocPaths: h.resolveHarnessDocPaths }));
vi.mock('../../harness/docs/doc-fs', () => ({ safeJoinUnderRoot: h.safeJoinUnderRoot }));
vi.mock('../../harness/docs/manual-anchor', () => ({ anchorManualDoc: h.anchorManualDoc }));
vi.mock('../../harness/docs/authored-doc-projection', () => ({ applyProjectionBanner: h.applyProjectionBanner }));
vi.mock('../../harness/docs/doc-record', () => ({ getAuthoredDocContent: h.getAuthoredDocContent }));
vi.mock('./_engineering-adapter', () => ({
  engineeringAdapter: h.engineeringAdapter,
  invalidateEngineeringAdapter: h.invalidateEngineeringAdapter,
}));
vi.mock('../../search/doc-embed-sync', () => ({ refreshDocPageSections: h.refreshDocPageSections }));

import authorTool from './author';

type HandlerResult = { content: Array<{ text: string }>; isError?: boolean };
type AuthorHandler = (args: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<HandlerResult>;

const callAuthor = (args: Record<string, unknown>) =>
  (authorTool as unknown as { handler: AuthorHandler }).handler(args, { isSuperuser: true });

const baseArgs = {
  slug: 'current-refresh',
  section: 'agent-insights',
  title: 'Current refresh coverage',
  description: 'Direct handler refresh coverage.',
  body: '# Current refresh coverage\n\nBody.',
  documents: ['packages/operator-core/lib/agent-tools/docs/author.ts'],
  harness: 'engineering',
};

beforeEach(() => {
  h.order.length = 0;
  vi.clearAllMocks();
  h.existsSync.mockImplementation(() => false);
  h.getAuthoredDocContent.mockResolvedValue(null);
});

describe('docs:author search refresh', () => {
  it('rejects MDX-invalid prose before the canonical write', async () => {
    const result = await callAuthor({
      ...baseArgs,
      slug: 'invalid-mdx-before-write',
      body: '# Invalid MDX\n\nA list<plan-ref> appears in prose.\n',
    });
    const payload = JSON.parse(result.content[0].text) as { ok: boolean; error?: string };

    expect(result.isError).toBe(true);
    expect(payload.ok).toBe(false);
    expect(payload.error).toContain('invalid_mdx');
    expect(payload.error).toContain('Expected a closing tag');
    expect(h.anchorManualDoc).not.toHaveBeenCalled();
    expect(h.writeFile).not.toHaveBeenCalled();
    expect(h.invalidateEngineeringAdapter).not.toHaveBeenCalled();
    expect(h.refreshDocPageSections).not.toHaveBeenCalled();
  });

  it('invalidates the engineering adapter before refreshing the authored page', async () => {
    const result = await callAuthor(baseArgs);
    const payload = JSON.parse(result.content[0].text) as { ok: boolean };

    expect(result.isError).not.toBe(true);
    expect(payload.ok).toBe(true);
    expect(h.invalidateEngineeringAdapter).toHaveBeenCalledTimes(1);
    expect(h.refreshDocPageSections).toHaveBeenCalledWith(h.engineeringAdapter, 'agent-insights/current-refresh');
    expect(h.order).toEqual(['invalidate', 'refresh']);
  });

  it('keeps author success but surfaces a refresh failure as a warning', async () => {
    h.refreshDocPageSections.mockResolvedValueOnce({
      ok: false,
      reason: 'page_not_found:agent-insights/current-refresh',
    });

    const result = await callAuthor(baseArgs);
    const payload = JSON.parse(result.content[0].text) as { ok: boolean; warnings?: string[] };

    expect(result.isError).not.toBe(true);
    expect(payload.ok).toBe(true);
    expect(payload.warnings?.some((warning) => warning.includes('page_not_found:agent-insights/current-refresh'))).toBe(
      true,
    );
  });

  it('preserves an over-limit legacy description when an overwrite omits description', async () => {
    const legacyDescription = 'x'.repeat(1_945);
    h.existsSync.mockReturnValue(true);
    h.getAuthoredDocContent.mockResolvedValue(`---
title: "Legacy insight"
description: "${legacyDescription}"
---

# Legacy insight
`);
    const { description: _unusedDescription, ...overwriteWithoutDescription } = baseArgs;

    const result = await callAuthor({
      ...overwriteWithoutDescription,
      slug: 'legacy-description-overwrite',
      title: 'Updated legacy insight',
      overwrite: true,
    });
    const payload = JSON.parse(result.content[0].text) as { ok: boolean; warnings?: string[] };

    expect(result.isError).not.toBe(true);
    expect(payload.ok).toBe(true);
    expect(payload.warnings?.some((warning) => warning.includes(String(legacyDescription.length)))).toBe(true);
    const anchorArgs = h.anchorManualDoc.mock.calls[0]?.[0] as { content: string } | undefined;
    expect(anchorArgs?.content).toContain(`description: "${legacyDescription}"`);
  });

  it('still requires description when creating a new doc', async () => {
    const { description: _unusedDescription, ...createWithoutDescription } = baseArgs;
    const result = await callAuthor({
      ...createWithoutDescription,
      slug: 'missing-description',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('description_required');
    expect(h.anchorManualDoc).not.toHaveBeenCalled();
  });
});
