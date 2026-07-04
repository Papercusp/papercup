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

describe('newestTranscriptUnderOwner (P-016 resume-rotation / dark-cohort fallback)', () => {
  const base = mkdtempSync(join(tmpdir(), 'compaction-owner-'));
  afterAll(() => rmSync(base, { recursive: true, force: true }));
  const OWNER = 'su-11111111-2222-3333-4444-555555555555';
  const projDir = join(base, OWNER, 'projects', '-home-x-papercusp');

  it('picks the NEWEST session *.jsonl under the owner root, ignoring history.jsonl', () => {
    mkdirSync(projDir, { recursive: true });
    const older = join(projDir, 'aaaa1111-1111-1111-1111-111111111111.jsonl');
    const newer = join(projDir, 'bbbb2222-2222-2222-2222-222222222222.jsonl');
    const hist = join(projDir, 'history.jsonl');
    writeFileSync(older, 'x');
    writeFileSync(newer, 'y');
    writeFileSync(hist, 'z'.repeat(4096)); // bigger + newest mtime, but must be excluded
    utimesSync(older, new Date(1_000_000), new Date(1_000_000));
    utimesSync(newer, new Date(2_000_000), new Date(2_000_000));
    utimesSync(hist, new Date(3_000_000), new Date(3_000_000));
    expect(newestTranscriptUnderOwner(OWNER, base)).toBe(newer);
  });

  it('returns null when the owner root holds no session transcript', () => {
    expect(newestTranscriptUnderOwner('su-99999999-0000-0000-0000-000000000000', base)).toBeNull();
  });

  it('refuses a path-escaping owner id', () => {
    expect(newestTranscriptUnderOwner('../../etc', base)).toBeNull();
    expect(newestTranscriptUnderOwner('a/b', base)).toBeNull();
  });
});
