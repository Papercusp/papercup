import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ingestHarnessDocs } from './migrate-fs-docs';
import { resolveHarnessDocPaths } from './harness-repo';
import { listDocBodies, readDocBody } from './doc-fs';
import { anchorManualDoc } from './manual-anchor';
import type { AnchorResult } from './manual-anchor';

// PG-free + FS-free unit: the path resolver, FS walk, and the anchor path each
// have their own suites; this pins ingestHarnessDocs's branching (P-010) — the
// unknown-harness guard, verifyAtHead propagation, anchor-failed → skipped, and
// body-null → skipped — and asserts the scanned/anchored/skipped tallies stay
// exhaustive + disjoint. (harness-docs-integration-2026-06-05 Gap 10.)
vi.mock('./harness-repo', () => ({ resolveHarnessDocPaths: vi.fn() }));
vi.mock('./doc-fs', () => ({ listDocBodies: vi.fn(), readDocBody: vi.fn() }));
// Keep the pure subject-detection helpers (frontmatterDocuments / inferSubjectFromBody —
// own suite in manual-anchor.test.ts) real; only the PG/git-touching anchorManualDoc is mocked.
vi.mock('./manual-anchor', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./manual-anchor')>()),
  anchorManualDoc: vi.fn(),
}));

const mockPaths = vi.mocked(resolveHarnessDocPaths);
const mockList = vi.mocked(listDocBodies);
const mockReadBody = vi.mocked(readDocBody);
const mockAnchor = vi.mocked(anchorManualDoc);

const PATHS = { repoRoot: '/repo', docsRoot: '/repo/docs' };
// A body that declares a subject via `documents:` frontmatter → has a subject.
const ANCHORABLE = '---\ntitle: T\ndocuments: src/x.ts\n---\n# body';
// A body with no frontmatter subject and no path-like inline code → no subject.
const NO_SUBJECT = '# just prose, no path-like `words` here';

type AnchorOk = Extract<AnchorResult, { ok: true }>;
function anchorOk(anchored = true): AnchorOk {
  return {
    ok: true,
    anchored,
    subjectRef: [{ kind: 'path', globs: ['src/x.ts'] }],
    record: {} as AnchorOk['record'],
  };
}

describe('ingestHarnessDocs branches (P-010)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPaths.mockResolvedValue(PATHS);
  });

  it('(a) unknown harness → { ok:false, error:"unknown_harness" } with zeroed tallies', async () => {
    mockPaths.mockResolvedValue(null);
    const res = await ingestHarnessDocs('nope');
    expect(res).toEqual({ ok: false, error: 'unknown_harness', scanned: 0, anchored: [], skipped: [] });
    expect(mockList).not.toHaveBeenCalled();
    expect(mockAnchor).not.toHaveBeenCalled();
  });

  it('(b) verifyAtHead:false propagates to anchorManualDoc', async () => {
    mockList.mockResolvedValue(['guides/setup.md']);
    mockReadBody.mockResolvedValue(ANCHORABLE);
    mockAnchor.mockResolvedValue(anchorOk());
    await ingestHarnessDocs('demo', { verifyAtHead: false });
    expect(mockAnchor).toHaveBeenCalledWith(expect.objectContaining({ verify: false }));
  });

  it('verifyAtHead defaults to true when omitted', async () => {
    mockList.mockResolvedValue(['guides/setup.md']);
    mockReadBody.mockResolvedValue(ANCHORABLE);
    mockAnchor.mockResolvedValue(anchorOk());
    await ingestHarnessDocs('demo');
    expect(mockAnchor).toHaveBeenCalledWith(expect.objectContaining({ verify: true }));
  });

  it('(c) anchorManualDoc returns !ok → docId in skipped, not anchored', async () => {
    mockList.mockResolvedValue(['guides/setup.md']);
    mockReadBody.mockResolvedValue(ANCHORABLE);
    mockAnchor.mockResolvedValue({ ok: false, error: 'unknown_harness' });
    const res = await ingestHarnessDocs('demo');
    expect(res.anchored).not.toContain('guides/setup.md');
    expect(res.skipped).toContain('guides/setup.md');
  });

  it('anchorManualDoc ok but anchored:false → skipped (no subject resolved at anchor time)', async () => {
    mockList.mockResolvedValue(['guides/setup.md']);
    mockReadBody.mockResolvedValue(ANCHORABLE);
    mockAnchor.mockResolvedValue(anchorOk(false));
    const res = await ingestHarnessDocs('demo');
    expect(res.anchored).not.toContain('guides/setup.md');
    expect(res.skipped).toContain('guides/setup.md');
  });

  it('(d) body null → skipped (never anchored)', async () => {
    mockList.mockResolvedValue(['gone.md']);
    mockReadBody.mockResolvedValue(null);
    const res = await ingestHarnessDocs('demo');
    expect(res.skipped).toContain('gone.md');
    expect(res.anchored).toEqual([]);
    expect(mockAnchor).not.toHaveBeenCalled();
  });

  it('no inferable subject → skipped without calling anchorManualDoc', async () => {
    mockList.mockResolvedValue(['orphan.md']);
    mockReadBody.mockResolvedValue(NO_SUBJECT);
    const res = await ingestHarnessDocs('demo');
    expect(res.skipped).toContain('orphan.md');
    expect(mockAnchor).not.toHaveBeenCalled();
  });

  it('tallies are exhaustive + disjoint across a mixed batch', async () => {
    mockList.mockResolvedValue(['ok.md', 'fail.md', 'gone.md', 'orphan.md']);
    mockReadBody.mockImplementation(async (_root, id) => {
      if (id === 'gone.md') return null;
      if (id === 'orphan.md') return NO_SUBJECT;
      return ANCHORABLE; // ok.md + fail.md both declare a subject
    });
    mockAnchor.mockImplementation(async ({ docId }) =>
      docId === 'ok.md' ? anchorOk() : { ok: false, error: 'unknown_harness' },
    );

    const res = await ingestHarnessDocs('demo');
    expect(res.ok).toBe(true);
    expect(res.scanned).toBe(4);
    expect(res.anchored).toEqual(['ok.md']);
    expect(res.skipped.sort()).toEqual(['fail.md', 'gone.md', 'orphan.md']);
    // Exhaustive: every scanned doc lands in exactly one bucket.
    expect(res.anchored.length + res.skipped.length).toBe(res.scanned);
    // Disjoint: no doc appears in both buckets.
    const overlap = res.anchored.filter((d) => res.skipped.includes(d));
    expect(overlap).toEqual([]);
  });
});
