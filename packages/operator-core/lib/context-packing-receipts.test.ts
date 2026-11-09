import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { packContextCandidates } from './context-doors';
import { loadContextPackingReceipt, pageContextPackingReceipt, saveContextPackingReceipt, type ContextPackingScope } from './context-packing-receipts';

const { artifacts, indexes } = vi.hoisted(() => ({ artifacts: new Map<string, string>(), indexes: new Map<string, string>() }));
vi.mock('./workspace-registry', () => ({ activeWorkspaceId: () => 'workspace-a' }));
vi.mock('./text-artifacts', () => ({
  saveImmutableTextArtifact: async (harness: string, content: string) => {
    const sha256 = createHash('sha256').update(content).digest('hex');
    artifacts.set(`${harness}/${sha256}`, content); return { sha256, relPath: `immutable/sha256/${sha256}.json` };
  },
  loadImmutableTextArtifact: async (harness: string, sha256: string) => artifacts.get(`${harness}/${sha256}`) ?? null,
  claimImmutableTextArtifact: async (harness: string, path: string, content: string) => {
    const key = `${harness}/${path}`;
    if (indexes.has(key)) {
      if (indexes.get(key) !== content) throw new Error('text_artifact_immutable_claim_conflict');
      return false;
    }
    indexes.set(key, content); return true;
  },
  loadImmutableTextArtifactClaim: async (harness: string, path: string) => indexes.get(`${harness}/${path}`) ?? null,
}));
const scope: ContextPackingScope = { ownerId: 'owner-a', workspaceId: 'workspace-a', harness: 'papercusp', port: 'turn-start', client: 'codex' };
const packed = () => packContextCandidates({ attemptId: 'attempt-1', budgetBytes: 0, candidates: [
  { sourceRef: 'control:1', revision: 'r1', class: 'control', required: true, text: '⟦CTRL⟧' },
] }).receipt;

beforeEach(() => { artifacts.clear(); indexes.clear(); });
describe('context packing evidence', () => {
  it('retains a mandatory-overflow receipt keyed by attempt independently of zero context bytes', async () => {
    const receipt = packed();
    const ref = await saveContextPackingReceipt(scope, receipt);
    expect(ref.path).toMatch(/^immutable\/claims\/[a-f0-9]{64}\.json$/);
    expect((await loadContextPackingReceipt(scope, receipt.attemptId))?.receipt).toEqual(receipt);
    expect(await saveContextPackingReceipt(scope, receipt)).toEqual(ref);
    await expect(saveContextPackingReceipt(scope, { ...receipt, budgetBytes: 1 })).rejects.toThrow('attempt_conflict');
    expect((await loadContextPackingReceipt(scope, receipt.attemptId))?.receipt.budgetBytes).toBe(0);
  });

  it('separates recipients and rejects a workspace outside the authenticated context', async () => {
    await saveContextPackingReceipt(scope, packed());
    expect(await loadContextPackingReceipt({ ...scope, ownerId: 'other' }, 'attempt-1')).toBeNull();
    await expect(loadContextPackingReceipt({ ...scope, workspaceId: 'foreign' }, 'attempt-1')).rejects.toThrow('scope_invalid');
  });

  it.each([512, 5999, 6000])('pages the complete ledger including long multibyte identities within D=%i', maxBytes => {
    const receipt = packed();
    receipt.candidates = Array.from({ length: 8 }, (_, index) => ({ ...receipt.candidates[0], index,
      sourceRef: `source-${index}-` + '字'.repeat(2100) }));
    const stored = { scope, receipt };
    const chunks: Buffer[] = [];
    let offset: number | null = 0;
    do {
      const pageText = pageContextPackingReceipt(stored, offset, maxBytes);
      expect(Buffer.byteLength(pageText)).toBeLessThanOrEqual(maxBytes);
      const page = JSON.parse(pageText);
      expect(page.offset).toBe(offset);
      chunks.push(Buffer.from(page.data, 'base64'));
      if (page.nextOffset !== null) expect(page.nextOffset).toBeGreaterThan(offset!);
      offset = page.nextOffset;
    } while (offset !== null);
    expect(JSON.parse(Buffer.concat(chunks).toString('utf8'))).toEqual(stored);
  });
});
