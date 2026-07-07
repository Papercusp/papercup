/**
 * list-shape.test.ts — harness_docs:list payload-tier shapers
 * (context-trimming-tiers-2026-07-01 P-023; docIdRequested suppression EI-8326).
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/harness_docs/list-shape.test.ts
 */
import { describe, expect, it } from 'vitest';
import { shapeHarnessDocsList, HARNESS_DOCS_TIER_CAPS } from './list-shape';

const entry = (i: number) => ({
  docId: `doc-${i}`,
  source: 'generated',
  status: 'fresh',
  title: `Doc ${i}`,
  statusDetail: 'ok',
  subjectLabel: 'sub',
  tracked: true,
  bodyMissing: false,
  hasOverlay: false,
});

const baseData = (n: number) => ({
  ok: true,
  activePath: 'doc-1',
  entries: Array.from({ length: n }, (_, i) => entry(i)),
  files: Array.from({ length: n }, (_, i) => `doc-${i}.md`),
  content: 'body text',
  activeEntry: { ...entry(1), overlay: 'an overlay note' },
});

describe('shapeHarnessDocsList', () => {
  it('trimmed/standard cap + project the global entries list when no docId was requested', () => {
    const data = baseData(5);
    const out = shapeHarnessDocsList(data, 'trimmed') as Record<string, unknown>;
    expect(Array.isArray(out.entries)).toBe(true);
    expect((out.entries as unknown[]).length).toBe(5);
    expect(out.filesCount).toBe(5);
  });

  it('EI-8326: docIdRequested suppresses the global entries list, keeping activeEntry full', () => {
    const data = baseData(200); // large harness — the exact bloat scenario reported
    const out = shapeHarnessDocsList(data, 'standard', { docIdRequested: true }) as Record<
      string,
      unknown
    >;
    expect(out.entries).toBeUndefined();
    expect(out.entriesCount).toBe(200);
    expect(typeof out.entries_suppressed).toBe('string');
    expect(out.filesCount).toBe(200);
    const active = out.activeEntry as Record<string, unknown>;
    expect(active.docId).toBe('doc-1');
    expect(active.status).toBe('fresh');
    expect(active.overlay).toBe('an overlay note');
  });

  it('docIdRequested still respects content clipping caps per tier', () => {
    const c = HARNESS_DOCS_TIER_CAPS.trimmed;
    const data = { ...baseData(3), content: 'x'.repeat(c.content + 50) };
    const out = shapeHarnessDocsList(data, 'trimmed', { docIdRequested: true }) as Record<
      string,
      unknown
    >;
    expect(out.content_truncated).toBe(true);
    expect(out.content_full_chars).toBe(c.content + 50);
    expect((out.content as string).length).toBe(c.content);
  });

  it('no docId + full tier (called directly with no opts) is unaffected — back-compat', () => {
    const data = baseData(2);
    const out = shapeHarnessDocsList(data, 'trimmed') as Record<string, unknown>;
    expect(out.entries_suppressed).toBeUndefined();
    expect(Array.isArray(out.entries)).toBe(true);
  });

  it('non-entries data (e.g. an error payload) passes through untouched', () => {
    const data = { ok: false, reason: 'not_found' };
    expect(shapeHarnessDocsList(data, 'trimmed', { docIdRequested: true })).toBe(data);
  });
});
