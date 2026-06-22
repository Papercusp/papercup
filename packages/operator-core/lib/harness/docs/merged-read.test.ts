import { describe, it, expect, beforeEach, vi } from 'vitest';
import { buildMergedDocs } from './merged-read';
import { resolveHarnessDocPaths } from './harness-repo';
import { listDocBodies, readDocBody } from './doc-fs';
import { listDocRecords, type HarnessDocRecord, type DocSource } from './doc-record';

// PG/git/FS-free unit: buildMergedDocs is the UNION/merge spine of the per-harness
// docs tree (FS bodies ∪ PG records, P-007) and is otherwise exercised ONLY by the
// heavy real-PG+git e2e (won't run in unit test:affected). This pins the three
// merge-semantics branches that ARE the union: orphan-record (record, no body),
// untracked-FS (body, no record), and overlay (both) — plus the active-doc default
// pick and the empty-union short-circuit.
vi.mock('./harness-repo', () => ({ resolveHarnessDocPaths: vi.fn() }));
vi.mock('./doc-fs', async (importOriginal) => ({
  // Keep chooseDefaultDoc real (its own pick logic is the contract we lean on); mock
  // the FS-touching walk + body read.
  ...(await importOriginal<typeof import('./doc-fs')>()),
  listDocBodies: vi.fn(),
  readDocBody: vi.fn(),
}));
vi.mock('./doc-record', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./doc-record')>()),
  listDocRecords: vi.fn(),
}));
// buildMergedDocs now DERIVES the workspace from the harness (P-002/D-003); this PG-free
// unit isn't exercising registry resolution, so stub the derive to echo the (omitted) ws.
vi.mock('../workspace-for-harness', () => ({
  resolveWorkspaceForHarness: vi.fn(async (_h: string, ws?: string) => ws ?? 'test-ws'),
}));

const mockPaths = vi.mocked(resolveHarnessDocPaths);
const mockBodies = vi.mocked(listDocBodies);
const mockReadBody = vi.mocked(readDocBody);
const mockRecords = vi.mocked(listDocRecords);

const PATHS = { repoRoot: '/repo', docsRoot: '/repo/docs' };

function rec(docId: string, over: Partial<HarnessDocRecord> & { source: DocSource }): HarnessDocRecord {
  return {
    workspaceId: 'ws',
    harnessSlug: 'demo',
    docId,
    subjectRef: [],
    anchorPaths: [],
    generatedFromSha: null,
    lastVerifiedSha: null,
    lastVerifiedAt: null,
    overlay: null,
    status: 'untracked',
    statusDetail: null,
    statusCheckedAt: null,
    regenEnqueuedAt: null,
    reverifyFlaggedAt: null,
    title: null,
    createdAt: '',
    updatedAt: '',
    ...over,
  };
}
const recordMap = (...recs: HarnessDocRecord[]) => new Map(recs.map((r) => [r.docId, r]));

describe('buildMergedDocs merge spine (P-007)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPaths.mockResolvedValue(PATHS);
    mockReadBody.mockResolvedValue('# body\n');
  });

  it('unknown harness → { ok:false, reason:"unknown_harness" } and reads neither FS nor PG', async () => {
    mockPaths.mockResolvedValue(null);
    const res = await buildMergedDocs('nope');
    expect(res).toMatchObject({ ok: false, reason: 'unknown_harness', files: [], entries: [], activePath: null });
    expect(mockBodies).not.toHaveBeenCalled();
    expect(mockRecords).not.toHaveBeenCalled();
  });

  it('(a) record-only id (orphan) → bodyMissing:true, tracked:true; active content:null (no body)', async () => {
    mockBodies.mockResolvedValue([]); // body deleted
    mockRecords.mockResolvedValue(recordMap(rec('features/F-1.md', { source: 'generated', status: 'fresh', generatedFromSha: 'sha' })));

    const res = await buildMergedDocs('demo', { activePath: 'features/F-1.md' });
    expect(res.ok).toBe(true);
    expect(res.files).toEqual(['features/F-1.md']);
    const e = res.entries[0];
    expect(e).toMatchObject({ docId: 'features/F-1.md', source: 'generated', tracked: true, bodyMissing: true });
    // Active doc has no FS body → content null, readDocBody never called.
    expect(res.activePath).toBe('features/F-1.md');
    expect(res.content).toBeNull();
    expect(mockReadBody).not.toHaveBeenCalled();
    // overlay only fetched for the active doc; orphan has none.
    expect(res.activeEntry).toMatchObject({ bodyMissing: true, overlay: null });
  });

  it('(b) FS-only id (untracked) → tracked:false, status:"untracked", bodyMissing:false, body read', async () => {
    mockBodies.mockResolvedValue(['orphan.md']);
    mockRecords.mockResolvedValue(new Map());

    const res = await buildMergedDocs('demo', { activePath: 'orphan.md' });
    expect(res.files).toEqual(['orphan.md']);
    const e = res.entries[0];
    expect(e).toMatchObject({
      docId: 'orphan.md',
      source: 'manual',
      status: 'untracked',
      statusDetail: 'not drift-tracked',
      tracked: false,
      bodyMissing: false,
      hasOverlay: false,
    });
    expect(mockReadBody).toHaveBeenCalledWith('/repo/docs', 'orphan.md');
    expect(res.content).toBe('# body\n');
  });

  it('(c) both present with an overlay → merged record, hasOverlay:true, overlay surfaced on active', async () => {
    mockBodies.mockResolvedValue(['features/F-1.md']);
    mockRecords.mockResolvedValue(
      recordMap(rec('features/F-1.md', { source: 'augmented', status: 'fresh', overlay: 'Why: login fast-path.', generatedFromSha: 'sha' })),
    );

    const res = await buildMergedDocs('demo', { activePath: 'features/F-1.md' });
    const e = res.entries[0];
    expect(e).toMatchObject({ source: 'augmented', tracked: true, bodyMissing: false, hasOverlay: true });
    expect(res.activeEntry).toMatchObject({ overlay: 'Why: login fast-path.', hasOverlay: true });
    expect(res.content).toBe('# body\n');
  });

  it('hasOverlay is false for a whitespace-only overlay (treated as empty)', async () => {
    mockBodies.mockResolvedValue(['features/F-1.md']);
    mockRecords.mockResolvedValue(recordMap(rec('features/F-1.md', { source: 'generated', overlay: '   \n  ' })));
    const res = await buildMergedDocs('demo');
    expect(res.entries[0].hasOverlay).toBe(false);
  });

  it('union: orphan-record + untracked-FS + overlay coexist, sorted by docId', async () => {
    mockBodies.mockResolvedValue(['guides/setup.md', 'untracked.md']); // setup also has a record; untracked has none
    mockRecords.mockResolvedValue(
      recordMap(
        rec('features/F-1.md', { source: 'generated', status: 'fresh' }), // orphan: record, no body
        rec('guides/setup.md', { source: 'augmented', overlay: 'why', status: 'fresh' }), // overlay: both
      ),
    );
    const res = await buildMergedDocs('demo');
    expect(res.files).toEqual(['features/F-1.md', 'guides/setup.md', 'untracked.md']);
    const byId = Object.fromEntries(res.entries.map((e) => [e.docId, e]));
    expect(byId['features/F-1.md']).toMatchObject({ tracked: true, bodyMissing: true });
    expect(byId['guides/setup.md']).toMatchObject({ tracked: true, bodyMissing: false, hasOverlay: true });
    expect(byId['untracked.md']).toMatchObject({ tracked: false, bodyMissing: false, status: 'untracked' });
  });

  it('(d) requested activePath not in the union → falls back to chooseDefaultDoc (index/README/first)', async () => {
    mockBodies.mockResolvedValue(['README.md', 'zeta.md']);
    mockRecords.mockResolvedValue(new Map());
    const res = await buildMergedDocs('demo', { activePath: 'does/not/exist.md' });
    // chooseDefaultDoc prefers README over first-sorted (README.md sorts before zeta.md anyway,
    // but the point is the bogus activePath is dropped, not honored).
    expect(res.activePath).toBe('README.md');
    expect(res.files).not.toContain('does/not/exist.md'); // sanity: the bogus path is NOT in the union
  });

  it('default pick honors index over README over first', async () => {
    mockBodies.mockResolvedValue(['README.md', 'aaa.md', 'index.md']);
    mockRecords.mockResolvedValue(new Map());
    const res = await buildMergedDocs('demo'); // no activePath
    expect(res.activePath).toBe('index.md');
  });

  it('(e) empty union (no FS bodies, no records) → ok:true, reason:"empty", null active', async () => {
    mockBodies.mockResolvedValue([]);
    mockRecords.mockResolvedValue(new Map());
    const res = await buildMergedDocs('demo', { activePath: 'whatever.md' });
    expect(res).toMatchObject({
      ok: true,
      reason: 'empty',
      projectPath: '/repo',
      docsRoot: '/repo/docs',
      files: [],
      entries: [],
      activePath: null,
      content: null,
      activeEntry: null,
    });
    expect(mockReadBody).not.toHaveBeenCalled();
  });
});
