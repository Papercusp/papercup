/**
 * session-audit.test.ts — pure-logic + real-fs unit tests (WI-4958). No PG here
 * (see session-audit.integration.test.ts for the PG-backed assembly); the
 * clustering/friction algorithms are pure, and the transcript marker scan is
 * exercised against real temp files (the same pattern compaction-usage.test.ts
 * uses for tokensFromFileSize — a plain unit test, no testcontainers needed).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  clusterInvalidCalls,
  computeRecurringFriction,
  countCompactionMarkersInTranscript,
  normalizeErrorSignature,
  type FailedCallRow,
} from './session-audit';

describe('clusterInvalidCalls', () => {
  const base = Date.UTC(2026, 6, 16, 12, 0, 0);

  it('groups a run of same-owner same-tool failures within the gap window into one cluster', () => {
    const rows: FailedCallRow[] = [
      { ownerId: 'su-a', toolName: 'docs:get', invokedAtMs: base, errorMessage: 'boom 1' },
      { ownerId: 'su-a', toolName: 'docs:get', invokedAtMs: base + 60_000, errorMessage: 'boom 2' },
      { ownerId: 'su-a', toolName: 'docs:get', invokedAtMs: base + 120_000, errorMessage: 'boom 3' },
    ];
    const clusters = clusterInvalidCalls(rows);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toMatchObject({ ownerId: 'su-a', toolName: 'docs:get', count: 3 });
    expect(clusters[0].firstAtMs).toBe(base);
    expect(clusters[0].lastAtMs).toBe(base + 120_000);
    expect(clusters[0].sampleError).toBe('boom 1');
  });

  it('splits a run into two clusters when a gap exceeds the threshold', () => {
    const rows: FailedCallRow[] = [
      { ownerId: 'su-a', toolName: 'docs:get', invokedAtMs: base, errorMessage: 'e1' },
      { ownerId: 'su-a', toolName: 'docs:get', invokedAtMs: base + 60_000, errorMessage: 'e2' },
      { ownerId: 'su-a', toolName: 'docs:get', invokedAtMs: base + 60_000, errorMessage: 'e3' },
      // Far past the gap — a second, unrelated incident.
      { ownerId: 'su-a', toolName: 'docs:get', invokedAtMs: base + 3 * 3_600_000, errorMessage: 'e4' },
      { ownerId: 'su-a', toolName: 'docs:get', invokedAtMs: base + 3 * 3_600_000 + 60_000, errorMessage: 'e5' },
      { ownerId: 'su-a', toolName: 'docs:get', invokedAtMs: base + 3 * 3_600_000 + 120_000, errorMessage: 'e6' },
    ];
    const clusters = clusterInvalidCalls(rows);
    expect(clusters).toHaveLength(2);
    expect(clusters.map((c) => c.count).sort()).toEqual([3, 3]);
  });

  it('drops runs below minCount (isolated failures are noise, not a cluster)', () => {
    const rows: FailedCallRow[] = [
      { ownerId: 'su-a', toolName: 'docs:get', invokedAtMs: base, errorMessage: 'e1' },
      { ownerId: 'su-a', toolName: 'docs:get', invokedAtMs: base + 60_000, errorMessage: 'e2' },
    ];
    expect(clusterInvalidCalls(rows)).toEqual([]);
  });

  it('never merges DIFFERENT owners or DIFFERENT tools into one cluster', () => {
    const rows: FailedCallRow[] = [
      { ownerId: 'su-a', toolName: 'docs:get', invokedAtMs: base, errorMessage: 'e1' },
      { ownerId: 'su-a', toolName: 'docs:get', invokedAtMs: base + 60_000, errorMessage: 'e2' },
      { ownerId: 'su-a', toolName: 'docs:get', invokedAtMs: base + 120_000, errorMessage: 'e3' },
      { ownerId: 'su-b', toolName: 'docs:get', invokedAtMs: base, errorMessage: 'e1' },
      { ownerId: 'su-a', toolName: 'work_items:get', invokedAtMs: base, errorMessage: 'e1' },
    ];
    const clusters = clusterInvalidCalls(rows);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].ownerId).toBe('su-a');
    expect(clusters[0].toolName).toBe('docs:get');
  });

  it('sorts clusters by count descending', () => {
    const rows: FailedCallRow[] = [
      { ownerId: 'su-a', toolName: 'docs:get', invokedAtMs: base, errorMessage: 'e' },
      { ownerId: 'su-a', toolName: 'docs:get', invokedAtMs: base + 60_000, errorMessage: 'e' },
      { ownerId: 'su-a', toolName: 'docs:get', invokedAtMs: base + 120_000, errorMessage: 'e' },
      { ownerId: 'su-b', toolName: 'work_items:get', invokedAtMs: base, errorMessage: 'e' },
      { ownerId: 'su-b', toolName: 'work_items:get', invokedAtMs: base + 60_000, errorMessage: 'e' },
      { ownerId: 'su-b', toolName: 'work_items:get', invokedAtMs: base + 120_000, errorMessage: 'e' },
      { ownerId: 'su-b', toolName: 'work_items:get', invokedAtMs: base + 180_000, errorMessage: 'e' },
    ];
    const clusters = clusterInvalidCalls(rows);
    expect(clusters.map((c) => c.count)).toEqual([4, 3]);
  });
});

describe('normalizeErrorSignature', () => {
  it('collapses uuids, numbers, and quoted literals so the same class of failure groups together', () => {
    const a = normalizeErrorSignature('relation "harness_shared.foo_123" does not exist at row 42');
    const b = normalizeErrorSignature('relation "harness_shared.bar_999" does not exist at row 7');
    expect(a).toBe(b);
  });

  it('collapses uuids specifically (not just any hex run)', () => {
    const a = normalizeErrorSignature('work-item 3f1e6f2a-9c3b-4e7a-8f2d-1a2b3c4d5e6f not found');
    const b = normalizeErrorSignature('work-item 11111111-2222-3333-4444-555555555555 not found');
    expect(a).toBe(b);
    expect(a).toContain('<uuid>');
  });

  it('returns a stable placeholder for a missing error message', () => {
    expect(normalizeErrorSignature(null)).toBe('(no error message)');
    expect(normalizeErrorSignature(undefined)).toBe('(no error message)');
  });
});

describe('computeRecurringFriction', () => {
  const base = Date.UTC(2026, 6, 16, 12, 0, 0);

  it('surfaces a failure signature recurring across MULTIPLE distinct owners', () => {
    const rows: FailedCallRow[] = [
      { ownerId: 'su-a', toolName: 'docs:get', invokedAtMs: base, errorMessage: 'relation "foo" does not exist' },
      { ownerId: 'su-b', toolName: 'docs:get', invokedAtMs: base, errorMessage: 'relation "bar" does not exist' },
      { ownerId: 'su-c', toolName: 'docs:get', invokedAtMs: base, errorMessage: 'relation "baz" does not exist' },
    ];
    const friction = computeRecurringFriction(rows);
    expect(friction).toHaveLength(1);
    expect(friction[0]).toMatchObject({ toolName: 'docs:get', occurrences: 3, distinctOwners: 3 });
  });

  it('does NOT report a single session repeatedly hitting its own bug as recurring friction', () => {
    // Same owner, same signature, 5 times — that's an invalid-call CLUSTER
    // (clusterInvalidCalls' job), not systemic friction (needs >=2 owners).
    const rows: FailedCallRow[] = Array.from({ length: 5 }, (_, i) => ({
      ownerId: 'su-a',
      toolName: 'docs:get',
      invokedAtMs: base + i * 1000,
      errorMessage: 'boom',
    }));
    expect(computeRecurringFriction(rows)).toEqual([]);
  });

  it('does NOT report a signature below minOccurrences even across owners', () => {
    const rows: FailedCallRow[] = [
      { ownerId: 'su-a', toolName: 'docs:get', invokedAtMs: base, errorMessage: 'boom' },
      { ownerId: 'su-b', toolName: 'docs:get', invokedAtMs: base, errorMessage: 'boom' },
    ];
    expect(computeRecurringFriction(rows, { minOccurrences: 3 })).toEqual([]);
  });

  it('keeps DIFFERENT tools with the same error text as SEPARATE signatures', () => {
    const rows: FailedCallRow[] = [
      { ownerId: 'su-a', toolName: 'docs:get', invokedAtMs: base, errorMessage: 'timeout' },
      { ownerId: 'su-b', toolName: 'docs:get', invokedAtMs: base, errorMessage: 'timeout' },
      { ownerId: 'su-c', toolName: 'docs:get', invokedAtMs: base, errorMessage: 'timeout' },
      { ownerId: 'su-a', toolName: 'work_items:get', invokedAtMs: base, errorMessage: 'timeout' },
      { ownerId: 'su-b', toolName: 'work_items:get', invokedAtMs: base, errorMessage: 'timeout' },
      { ownerId: 'su-c', toolName: 'work_items:get', invokedAtMs: base, errorMessage: 'timeout' },
    ];
    const friction = computeRecurringFriction(rows);
    expect(friction).toHaveLength(2);
    expect(friction.map((f) => f.toolName).sort()).toEqual(['docs:get', 'work_items:get']);
  });
});

describe('countCompactionMarkersInTranscript', () => {
  const dir = mkdtempSync(join(tmpdir(), 'session-audit-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('counts zero markers in a transcript with none', async () => {
    const p = join(dir, 'none.jsonl');
    writeFileSync(p, '{"type":"user","text":"hi"}\n{"type":"assistant","text":"hello"}\n');
    expect(await countCompactionMarkersInTranscript(p)).toBe(0);
  });

  it('counts each RAW compaction-boundary marker line, one per real compaction', async () => {
    const p = join(dir, 'two-compactions.jsonl');
    const marker = '{"type":"user","isCompactSummary":true,"summary":"..."}\n';
    writeFileSync(p, 'a'.repeat(1000) + '\n' + marker + 'b'.repeat(1000) + '\n' + marker + 'c'.repeat(1000) + '\n');
    expect(await countCompactionMarkersInTranscript(p)).toBe(2);
  });

  it('does NOT count an ESCAPED text mention of the marker (EI-6410 discipline)', async () => {
    const p = join(dir, 'mention.jsonl');
    const escapedMention = '{"content":"discussing \\"isCompactSummary\\":true in prose"}\n';
    writeFileSync(p, escapedMention);
    expect(await countCompactionMarkersInTranscript(p)).toBe(0);
  });

  it('streams a large file correctly (exercises the >2MB streaming path, not just the slurp path)', async () => {
    const p = join(dir, 'large.jsonl');
    const marker = '{"type":"user","isCompactSummary":true,"summary":"..."}\n';
    const filler = 'x'.repeat(200_000) + '\n';
    let content = '';
    for (let i = 0; i < 15; i++) content += filler; // ~3MB, past the 2MB threshold
    content += marker;
    for (let i = 0; i < 5; i++) content += filler;
    content += marker;
    writeFileSync(p, content);
    expect(await countCompactionMarkersInTranscript(p)).toBe(2);
  });

  it('returns null (not 0) for a missing/unreadable file — absent evidence is never a clean bill of health', async () => {
    expect(await countCompactionMarkersInTranscript(join(dir, 'does-not-exist.jsonl'))).toBeNull();
  });
});
