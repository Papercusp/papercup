/**
 * compaction-usage — the per-session context-size estimator's backend gating +
 * graceful degradation (agent-managed-compaction-2026-07-01 P-007/P-009). The
 * transcript-size path is exercised by integration; here we pin the pure guards:
 * unresolvable / non-Claude sessions must degrade to null, never throw.
 */
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { estimateContextTokens, newestTranscriptUnderOwner, tokensFromFileSize } from './compaction-usage';

describe('estimateContextTokens (backend gating + degradation)', () => {
  it('returns null for a null sessionId', async () => {
    expect(await estimateContextTokens({ agent: 'claude', sessionId: null })).toBeNull();
  });

  it('returns null for OMP (self-compacts natively — no v1 signal)', async () => {
    expect(await estimateContextTokens({ agent: 'omp', sessionId: 'omp-thread-123' })).toBeNull();
  });

  it('returns null for Codex (no compaction)', async () => {
    expect(await estimateContextTokens({ agent: 'codex', sessionId: 'codex-rollout-123' })).toBeNull();
  });

  it('returns null for an unresolvable Claude session (no transcript on disk)', async () => {
    const est = await estimateContextTokens({ agent: 'claude', sessionId: 'nonexistent-session-9999' });
    expect(est).toBeNull();
  });
});

describe('tokensFromFileSize (EI-6410 compaction-boundary discount)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'compaction-usage-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const MB = 1024 * 1024;

  it('a small file stays whole-file/4 (no scan)', () => {
    const p = join(dir, 'small.jsonl');
    writeFileSync(p, 'x'.repeat(40_000));
    expect(tokensFromFileSize(p)).toBe(10_000);
  });

  it('counts only bytes AFTER the last raw compaction marker', () => {
    const p = join(dir, 'compacted.jsonl');
    // 2MB of pre-compaction history, a compaction-summary entry, 400KB since.
    const marker = '{"type":"user","isCompactSummary":true,"summary":"..."}\n';
    writeFileSync(p, 'a'.repeat(2 * MB) + marker + 'b'.repeat(400_000));
    const tokens = tokensFromFileSize(p)!;
    // ≈ (marker + 400KB)/4 — nowhere near the whole-file 2.4MB/4 ≈ 630k.
    expect(tokens).toBeLessThan(120_000);
    expect(tokens).toBeGreaterThan(90_000);
  });

  it('an ESCAPED text mention of the marker does not reset the count', () => {
    const p = join(dir, 'mention.jsonl');
    const escapedMention = '{"content":"discussing \\"isCompactSummary\\":true in prose"}\n';
    writeFileSync(p, 'a'.repeat(2 * MB) + escapedMention + 'b'.repeat(100_000));
    // No RAW marker anywhere → whole-file count (the conservative old behavior).
    expect(tokensFromFileSize(p)!).toBeGreaterThan(500_000);
  });

  it('missing file → null', () => {
    expect(tokensFromFileSize(join(dir, 'nope.jsonl'))).toBeNull();
  });
});
