import { describe, expect, it, vi } from 'vitest';
import { proposeAuditCitations, type AttributedAuditFile } from './audit-derived-citations';

const input = { workspaceId: 'w', harnessSlug: 'h', planSlug: 'plan', items: [
  { itemId: 'P-001', status: 'done', itemText: 'First' },
  { itemId: 'P-002', status: 'done', itemText: 'Second' },
  { itemId: 'P-003', status: 'wip', itemText: 'Third' },
] };
const row = (over: Partial<AttributedAuditFile> = {}): AttributedAuditFile => ({
  itemId: 'P-001', workItemId: 'WI-1', path: 'src/one.ts', source: 'edit', ...over,
});

describe('audit-derived citation proposals', () => {
  it('proposes only a done item’s attributed files, with measured blobs and ledger provenance', async () => {
    const readFiles = vi.fn(async () => [row(), row({ source: 'commit' }),
      row({ itemId: 'P-002', workItemId: 'WI-2', path: 'src/two.test.ts', source: 'commit' }),
      row({ itemId: 'P-003', path: 'src/unfinished.ts' })]);
    const blobSha = vi.fn(async (path: string) => `blob:${path}`);
    const result = await proposeAuditCitations(input, { readFiles, blobSha });
    expect(readFiles).toHaveBeenCalledWith(expect.objectContaining({ itemIds: ['P-001', 'P-002'] }));
    expect(result.proposals).toEqual([
      { itemId: 'P-001', citations: [{ kind: 'code', path: 'src/one.ts', blobSha: 'blob:src/one.ts',
        workItemIds: ['WI-1'], sources: ['commit', 'edit'] }] },
      { itemId: 'P-002', citations: [{ kind: 'test', path: 'src/two.test.ts', blobSha: 'blob:src/two.test.ts',
        workItemIds: ['WI-2'], sources: ['commit'] }] },
    ]);
    expect(blobSha).not.toHaveBeenCalledWith('src/unfinished.ts');
  });

  it('names deleted/unreadable paths without fabricating a blob or a citation', async () => {
    const result = await proposeAuditCitations(input, { readFiles: async () => [row()], blobSha: () => null });
    expect(result.proposals[0]!.citations).toEqual([]);
    expect(result.unresolved).toEqual([{ itemId: 'P-001', path: 'src/one.ts',
      reason: 'current file blob could not be measured' }]);
  });

  it('does not cite other items or allow unsafe recorded paths outside the repository', async () => {
    const blobSha = vi.fn(() => 'blob');
    const result = await proposeAuditCitations(input, { blobSha,
      readFiles: async () => [row({ itemId: 'P-999' }), row({ path: '../secret' })] });
    expect(blobSha).not.toHaveBeenCalled();
    expect(result.proposals.every(p => p.citations.length === 0)).toBe(true);
    expect(result.unresolved).toHaveLength(1);
  });

  it('measures a shared attributed file once, preserving each item’s own work-item link', async () => {
    const blobSha = vi.fn(() => 'blob');
    const result = await proposeAuditCitations(input, { blobSha,
      readFiles: async () => [row(), row({ itemId: 'P-002', workItemId: 'WI-2' })] });
    expect(blobSha).toHaveBeenCalledTimes(1);
    expect(result.proposals[0]!.citations[0]!.workItemIds).toEqual(['WI-1']);
    expect(result.proposals[1]!.citations[0]!.workItemIds).toEqual(['WI-2']);
  });
});
