/**
 * WI-4154 anchored-incremental estimator tests: every read must reflect the
 * transcript's CURRENT state — a compaction landing between reads corrects the
 * very next read (the false-alarm class this replaces), at append-delta cost.
 * Real temp files, no mocks: the anchor is seeded via the test seam (unit tests
 * have no adv_sessions row to resolve an owner through).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearContextAnchor,
  currentContextTokensSyncForOwner,
  resetContextAnchorsForTests,
  seedContextAnchorForTests,
  tokensFromFileSize,
} from './compaction-usage';

const MARKER_LINE = '{"type":"summary","isCompactSummary":true,"summary":"compacted"}\n';
/** Counting starts at the MARKER SUBSTRING, not the line start (full-scan semantics). */
const MARKER_TAIL = MARKER_LINE.length - MARKER_LINE.indexOf('"isCompactSummary"');

let dir: string;
let file: string;
let n = 0;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-test-'));
  file = path.join(dir, `${++n}.jsonl`);
});

afterEach(() => {
  resetContextAnchorsForTests();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A complete JSONL line of exactly `bytes` bytes (ASCII only). */
function line(bytes: number, fill = 'x'): string {
  const overhead = '{"t":""}\n'.length;
  return `{"t":"${fill.repeat(bytes - overhead)}"}\n`;
}

describe('anchored incremental context reads (WI-4154)', () => {
  it('seed matches the full-scan estimator on a plain transcript', async () => {
    fs.writeFileSync(file, line(400_000));
    expect(seedContextAnchorForTests('o1', file)).toBe(true);
    expect(currentContextTokensSyncForOwner('o1')).toBe(await tokensFromFileSize(file));
    expect(currentContextTokensSyncForOwner('o1')).toBe(100_000);
  });

  it('appended lines are reflected on the very next read', () => {
    fs.writeFileSync(file, line(400_000));
    seedContextAnchorForTests('o2', file);
    expect(currentContextTokensSyncForOwner('o2')).toBe(100_000);
    fs.appendFileSync(file, line(40_000));
    expect(currentContextTokensSyncForOwner('o2')).toBe(110_000);
  });

  it('a compaction landing between reads corrects the VERY NEXT read (the WI-4154 class)', async () => {
    fs.writeFileSync(file, line(1_400_000)); // pre-compaction: 350k tokens — alarm territory
    seedContextAnchorForTests('o3', file);
    expect(currentContextTokensSyncForOwner('o3')).toBe(350_000);
    fs.appendFileSync(file, MARKER_LINE + line(60_000)); // compaction + one fresh turn
    const after = currentContextTokensSyncForOwner('o3');
    // Counting restarts at the marker substring (full-scan semantics).
    expect(after).toBe(Math.floor((MARKER_TAIL + 60_000) / 4));
    expect(after).toBe(await tokensFromFileSize(file));
  });

  it('multiple compactions: the LAST marker wins, matching the full scan', async () => {
    fs.writeFileSync(file, line(600_000) + MARKER_LINE + line(300_000));
    seedContextAnchorForTests('o4', file);
    fs.appendFileSync(file, MARKER_LINE + line(20_000));
    expect(currentContextTokensSyncForOwner('o4')).toBe(await tokensFromFileSize(file));
    expect(currentContextTokensSyncForOwner('o4')).toBe(
      Math.floor((MARKER_TAIL + 20_000) / 4),
    );
  });

  it('EI-10434: a marker OUTSIDE the scan window seeds a BOUNDED estimate matching the full-scan estimator, not the raw whole-file size', async () => {
    const MB = 1024 * 1024;
    // The marker sits at the very start; well over BOUNDARY_SCAN_CAP (8MB) of
    // content follows with no further marker, so the last-8MB scan window can
    // no longer see it — the shape a long-running, many-times-compacted
    // session transcript takes over a full day (the EI-10434 20.9M/21.17M/
    // 24.3M-token garbage-reading occurrences).
    fs.writeFileSync(file, MARKER_LINE + 'a'.repeat(12 * MB));
    seedContextAnchorForTests('o-huge', file);
    const anchored = currentContextTokensSyncForOwner('o-huge');
    const fullScan = await tokensFromFileSize(file);
    expect(anchored).toBe(fullScan);
    // Bounded by the scan cap (8MB/4), never the raw ~12MB file's ≈3M-token
    // whole-file reading.
    expect(anchored).toBeLessThanOrEqual((8 * MB) / 4);
  });

  it('discounts an appended image payload to the vision cap (WI-3176 parity)', async () => {
    fs.writeFileSync(file, line(400_000));
    seedContextAnchorForTests('o5', file);
    const imageLine = `{"data":"${'A'.repeat(200_000)}"}\n`;
    fs.appendFileSync(file, imageLine);
    const got = currentContextTokensSyncForOwner('o5');
    expect(got).toBe(await tokensFromFileSize(file));
    // 100k base + line overhead/4 + 1600 (capped image), NOT +50k raw.
    expect(got).toBeLessThan(103_000);
    expect(got).toBeGreaterThanOrEqual(101_600);
  });

  it('a partial line (no newline yet) counts raw and settles once its newline lands', async () => {
    fs.writeFileSync(file, line(400_000));
    seedContextAnchorForTests('o6', file);
    fs.appendFileSync(file, '{"t":"partial'); // 13 bytes, unterminated
    expect(currentContextTokensSyncForOwner('o6')).toBe(Math.floor((400_000 + 13) / 4));
    fs.appendFileSync(file, '"}\n' + line(4_000));
    expect(currentContextTokensSyncForOwner('o6')).toBe(await tokensFromFileSize(file));
  });

  it('a marker inside a still-partial line is honored once the line completes', async () => {
    fs.writeFileSync(file, line(1_000_000));
    seedContextAnchorForTests('o7', file);
    const partial = MARKER_LINE.slice(0, MARKER_LINE.length - 1); // marker text, no newline
    fs.appendFileSync(file, partial);
    // Not yet settled: still counted raw from the old countStart (conservative).
    expect(currentContextTokensSyncForOwner('o7')).toBe(
      Math.floor((1_000_000 + partial.length) / 4),
    );
    fs.appendFileSync(file, '\n');
    expect(currentContextTokensSyncForOwner('o7')).toBe(await tokensFromFileSize(file));
    expect(currentContextTokensSyncForOwner('o7')).toBe(Math.floor(MARKER_TAIL / 4));
  });

  it('rotation/truncation returns null this read (background reseed), not a stale number', () => {
    fs.writeFileSync(file, line(400_000));
    seedContextAnchorForTests('o8', file);
    expect(currentContextTokensSyncForOwner('o8')).toBe(100_000);
    fs.writeFileSync(file, line(4_000)); // truncated (e.g. resume rotation)
    expect(currentContextTokensSyncForOwner('o8')).toBeNull();
  });

  it('an owner never seeded returns null (background seed) rather than guessing', () => {
    expect(currentContextTokensSyncForOwner('o-unknown')).toBeNull();
  });

  it('EI-12966: a carry-respawn dead predecessor file that stops growing serves the SAME frozen reading forever — advanceAnchor never notices the successor lives elsewhere', () => {
    // Simulates the pre-fix bug: the anchor is seeded on the PREDECESSOR's
    // transcript. A carry-respawn kills that process and starts a successor
    // on a DIFFERENT file, but the predecessor's file never grows again — so
    // advanceAnchor's fast path (`size === a.sizeSeen`) keeps returning 'ok'
    // with the byte-identical pre-respawn number, indefinitely, because it
    // never re-resolves which file is actually live for this owner.
    fs.writeFileSync(file, line(1_400_000)); // 350k tokens — CRITICAL-band territory
    seedContextAnchorForTests('o9', file);
    expect(currentContextTokensSyncForOwner('o9')).toBe(350_000);
    // The successor writes its OWN fresh, tiny transcript elsewhere — the
    // predecessor's `file` is never touched again.
    const successorFile = path.join(dir, 'successor.jsonl');
    fs.writeFileSync(successorFile, line(4_000)); // 1k tokens — nowhere near any limit
    // Without invalidation, every further read of the SAME owner id still
    // replays the dead predecessor's 350k — the exact "byte-identical
    // pre-compaction CRITICAL gauge" symptom.
    expect(currentContextTokensSyncForOwner('o9')).toBe(350_000);
  });

  it('EI-12966: clearContextAnchor drops the dead predecessor anchor so the next read reseeds instead of replaying it', () => {
    fs.writeFileSync(file, line(1_400_000));
    seedContextAnchorForTests('o10', file);
    expect(currentContextTokensSyncForOwner('o10')).toBe(350_000);
    clearContextAnchor('o10');
    // No anchor left to trust: this call kicks a background reseed (which has
    // no adv_sessions row to resolve in a unit test) and renders NOTHING —
    // never the stale 350k — matching the documented "never a possibly-stale
    // number" contract of the sync reader.
    expect(currentContextTokensSyncForOwner('o10')).toBeNull();
  });
});

/**
 * EI-12848: Claude Code writes each tool_result's payload into the JSONL line TWICE
 * — once in the in-context `message.content` tool_result block, and again in the
 * top-level `toolUseResult` bookkeeping field, which never enters model context.
 * Counting it at bytes/4 double-counts every tool result (~20% of a tool-heavy
 * transcript), so a fresh fleet member read 111% of its soft compaction limit right
 * after a ToolSearch schema preload — before any real work — and compact-looped on
 * the immovable duplicate. The estimator must discount the toolUseResult bytes.
 */
describe('toolUseResult double-write discount (EI-12848)', () => {
  /** A realistic tool-result JSONL line: an in-context `tool_result` block plus the
   *  out-of-context top-level `toolUseResult` duplicate (always AFTER `message`),
   *  then trailing metadata. Returns the exact bytes the estimator must discount
   *  ([key opening-quote, end-of-line), mirroring the implementation). */
  function dupToolLine(payloadBytes: number, fill = 'y'): { text: string; discountBytes: number } {
    const payload = fill.repeat(payloadBytes);
    const inCtx =
      `{"parentUuid":"u","type":"user","message":{"role":"user","content":` +
      `[{"type":"tool_result","content":"${payload}"}]},"uuid":"u2","timestamp":"t"`;
    const tail = `,"toolUseResult":"${payload}","cwd":"/x"}`;
    const text = inCtx + tail + '\n';
    const keyIdx = text.indexOf(',"toolUseResult":');
    const nlIdx = text.indexOf('\n', keyIdx);
    return { text, discountBytes: nlIdx - (keyIdx + 1) };
  }

  it('tokensFromFileSize drops the out-of-context toolUseResult duplicate', async () => {
    // ≥256KB so the scan path (not the stat-only fast path) runs; no compaction
    // marker, so the whole file is counted from offset 0.
    const { text, discountBytes } = dupToolLine(240_000);
    fs.writeFileSync(file, text);
    const size = fs.statSync(file).size;
    const est = await tokensFromFileSize(file);
    // Only the in-context bytes remain; the toolUseResult copy is gone.
    expect(est).toBe(Math.floor((size - discountBytes) / 4));
    // The buggy raw reading (whole file / 4) is ~one payload higher — the false
    // over-count that pushed a fresh member over its soft limit.
    expect(Math.floor(size / 4) - (est as number)).toBeGreaterThan(240_000 / 4 - 100);
  });

  it('the anchor path matches the full-scan estimator on a double-write line', async () => {
    const { text } = dupToolLine(240_000);
    fs.writeFileSync(file, text);
    seedContextAnchorForTests('tur-anchor', file);
    expect(currentContextTokensSyncForOwner('tur-anchor')).toBe(await tokensFromFileSize(file));
  });

  it('an appended toolUseResult turn is discounted on the very next read', async () => {
    fs.writeFileSync(file, line(400_000)); // 100k tokens of prior context
    seedContextAnchorForTests('tur-inc', file);
    expect(currentContextTokensSyncForOwner('tur-inc')).toBe(100_000);
    const { text, discountBytes } = dupToolLine(300_000); // ~600KB line, half out-of-context
    fs.appendFileSync(file, text);
    const got = currentContextTokensSyncForOwner('tur-inc') as number;
    expect(got).toBe(await tokensFromFileSize(file));
    // The ~300KB toolUseResult copy (≈75k tokens) is NOT added to the estimate.
    expect(got).toBeLessThan(100_000 + Math.ceil((text.length - discountBytes) / 4) + 10);
  });

  it('does NOT discount an escaped `toolUseResult` mention the session merely READ (WI-4608 safety)', async () => {
    // The phrase appears as DATA inside an assistant text block — JSON-escaped, so
    // the real top-level `,"toolUseResult":` key form never occurs. Nothing to drop.
    const quoted = 'z'.repeat(300_000);
    const text =
      `{"type":"assistant","message":{"content":[{"type":"text","text":` +
      `"a doc said \\"toolUseResult\\":\\"${quoted}\\" is a duplicate"}]}}\n`;
    fs.writeFileSync(file, text);
    const size = fs.statSync(file).size;
    // No discount — counted whole (the escaped mention is real in-context bytes).
    expect(await tokensFromFileSize(file)).toBe(Math.floor(size / 4));
    expect(text.includes(',"toolUseResult":')).toBe(false);
  });

  it('an image inside toolUseResult is not DOUBLE-discounted (image path unchanged)', async () => {
    // A toolUseResult carrying a base64 image: the image path keeps ~1600 tok for it
    // (conservative), and the text discount excludes those image bytes — never both.
    // ≥256KB so the scan path (not the stat-only fast path) runs.
    const img = 'A'.repeat(300_000);
    const text =
      `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"ok"}]},` +
      `"timestamp":"t","toolUseResult":{"type":"image","base64":"${img}"},"cwd":"/x"}\n`;
    fs.writeFileSync(file, text);
    const est = (await tokensFromFileSize(file)) as number;
    // Never negative / never over-discounted below zero, and small (the whole line
    // is out-of-context except the tiny in-context text block + image cap).
    expect(est).toBeGreaterThanOrEqual(0);
    expect(est).toBeLessThan(2_500); // ≈ overhead + image cap (1600), NOT +50k raw
  });
});
