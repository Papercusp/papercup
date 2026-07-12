/**
 * compaction-usage — the per-session context-size estimator's backend gating +
 * graceful degradation (agent-managed-compaction-2026-07-01 P-007/P-009). The
 * transcript-size path is exercised by integration; here we pin the pure guards:
 * unresolvable / non-Claude sessions must degrade to null, never throw.
 */
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
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

  it('EI-10434: a marker OUTSIDE the scan window stays BOUNDED at the scan cap — never the raw (unboundedly-growing) whole-file size', () => {
    const p = join(dir, 'huge-no-marker-in-window.jsonl');
    // A real compaction marker sits near the START of a file that has since
    // grown well past BOUNDARY_SCAN_CAP (8MB) — the LAST-8MB scan window no
    // longer contains ANY marker, even though one genuinely exists earlier in
    // the file. This is the shape a long-running, many-times-compacted
    // session transcript takes over a full day (EI-10434: readings like
    // 20.9M/21.17M/24.3M tokens, monotonically growing across the day).
    const marker = '{"type":"user","isCompactSummary":true,"summary":"..."}\n';
    writeFileSync(p, marker + 'a'.repeat(12 * MB));
    const tokens = tokensFromFileSize(p)!;
    // Bounded by the scan window (BOUNDARY_SCAN_CAP=8MB / 4 = 2,097,152 tokens)
    // — NOT the raw ~12MB file's ≈3M-token whole-file reading, and must NEVER
    // be allowed to grow without bound as the file keeps growing (the
    // garbage-reading signature).
    expect(tokens).toBeLessThanOrEqual(8 * MB / 4);

    // Append 5MB more with still no marker in the new scan window — a
    // regression here means the estimate keeps climbing forever even though
    // nothing about "how much is unaccounted-for within the scan window" has
    // changed. That unbounded climb IS the EI-10434 bug signature.
    const before = tokens;
    appendFileSync(p, 'b'.repeat(5 * MB));
    const after = tokensFromFileSize(p)!;
    expect(after).toBeLessThanOrEqual(before + 10_000);
  });
});

describe('tokensFromFileSize (WI-3176 base64-image discount)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'compaction-usage-img-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const MB = 1024 * 1024;
  const b64 = (n: number) => 'iVBORw0KGgoAAAANSUhEUg'.repeat(Math.ceil(n / 23)).slice(0, n);

  it('counts an image payload at ~1600 tokens, not byte-weight', () => {
    const p = join(dir, 'screenshot.jsonl');
    const marker = '{"type":"user","isCompactSummary":true,"summary":"..."}\n';
    // 2MB pre-compaction, then 100KB of text + one 2MB screenshot since.
    const img = `{"type":"image","source":{"type":"base64","media_type":"image/png","data":"${b64(2 * MB)}"}}\n`;
    writeFileSync(p, 'a'.repeat(2 * MB) + marker + 'b'.repeat(100_000) + img);
    const tokens = tokensFromFileSize(p)!;
    // ≈ 100KB/4 + 1600 ≈ 27k — NOT the undiscounted (100KB + 2MB)/4 ≈ 550k.
    expect(tokens).toBeLessThan(40_000);
    expect(tokens).toBeGreaterThan(20_000);
  });

  it('discounts the toolUseResult duplicate ("base64" key) too', () => {
    const p = join(dir, 'tooluseresult.jsonl');
    const marker = '{"type":"user","isCompactSummary":true,"summary":"..."}\n';
    const dup = `{"toolUseResult":{"type":"image","file":{"base64":"${b64(1 * MB)}","media_type":"image/png"}}}\n`;
    writeFileSync(p, 'a'.repeat(2 * MB) + marker + 'b'.repeat(100_000) + dup);
    const tokens = tokensFromFileSize(p)!;
    expect(tokens).toBeLessThan(40_000);
  });

  it('a long base64-alphabet run NOT under an image key keeps full weight', () => {
    const p = join(dir, 'hexdump.jsonl');
    const marker = '{"type":"user","isCompactSummary":true,"summary":"..."}\n';
    // e.g. a hex dump / minified blob inside ordinary tool-result text.
    writeFileSync(p, 'a'.repeat(2 * MB) + marker + `{"content":"${b64(1 * MB)}"}\n`);
    // Full weight ≈ 1MB/4 ≈ 262k — no discount.
    expect(tokensFromFileSize(p)!).toBeGreaterThan(250_000);
  });

  it('a sub-1MB screenshot-carrying file is scanned (fast path lowered to 256KB)', () => {
    const p = join(dir, 'small-with-image.jsonl');
    const img = `{"type":"image","source":{"type":"base64","media_type":"image/png","data":"${b64(700_000)}"}}\n`;
    writeFileSync(p, 'b'.repeat(50_000) + img);
    const tokens = tokensFromFileSize(p)!;
    // Old fast path would have read ~187k (750KB/4) — enough to trip a
    // 200k-window force threshold; discounted it is ~12.5k + 1600.
    expect(tokens).toBeLessThan(30_000);
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
