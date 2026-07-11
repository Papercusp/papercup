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
  currentContextTokensSyncForOwner,
  resetContextAnchorsForTests,
  seedContextAnchorForTests,
  tokensFromFileSize,
} from './compaction-usage';

const MARKER_LINE = '{"type":"summary","isCompactSummary":true,"summary":"compacted"}\n';

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
  it('seed matches the full-scan estimator on a plain transcript', () => {
    fs.writeFileSync(file, line(400_000));
    expect(seedContextAnchorForTests('o1', file)).toBe(true);
    expect(currentContextTokensSyncForOwner('o1')).toBe(tokensFromFileSize(file));
    expect(currentContextTokensSyncForOwner('o1')).toBe(100_000);
  });

  it('appended lines are reflected on the very next read', () => {
    fs.writeFileSync(file, line(400_000));
    seedContextAnchorForTests('o2', file);
    expect(currentContextTokensSyncForOwner('o2')).toBe(100_000);
    fs.appendFileSync(file, line(40_000));
    expect(currentContextTokensSyncForOwner('o2')).toBe(110_000);
  });

  it('a compaction landing between reads corrects the VERY NEXT read (the WI-4154 class)', () => {
    fs.writeFileSync(file, line(1_400_000)); // pre-compaction: 350k tokens — alarm territory
    seedContextAnchorForTests('o3', file);
    expect(currentContextTokensSyncForOwner('o3')).toBe(350_000);
    fs.appendFileSync(file, MARKER_LINE + line(60_000)); // compaction + one fresh turn
    const after = currentContextTokensSyncForOwner('o3');
    // Counting restarts at the marker START (full-scan semantics): marker line + 60k line.
    expect(after).toBe(Math.floor((MARKER_LINE.length + 60_000) / 4));
    expect(after).toBe(tokensFromFileSize(file));
  });

  it('multiple compactions: the LAST marker wins, matching the full scan', () => {
    fs.writeFileSync(file, line(600_000) + MARKER_LINE + line(300_000));
    seedContextAnchorForTests('o4', file);
    fs.appendFileSync(file, MARKER_LINE + line(20_000));
    expect(currentContextTokensSyncForOwner('o4')).toBe(tokensFromFileSize(file));
    expect(currentContextTokensSyncForOwner('o4')).toBe(
      Math.floor((MARKER_LINE.length + 20_000) / 4),
    );
  });

  it('discounts an appended image payload to the vision cap (WI-3176 parity)', () => {
    fs.writeFileSync(file, line(400_000));
    seedContextAnchorForTests('o5', file);
    const imageLine = `{"data":"${'A'.repeat(200_000)}"}\n`;
    fs.appendFileSync(file, imageLine);
    const got = currentContextTokensSyncForOwner('o5');
    expect(got).toBe(tokensFromFileSize(file));
    // 100k base + line overhead/4 + 1600 (capped image), NOT +50k raw.
    expect(got).toBeLessThan(103_000);
    expect(got).toBeGreaterThanOrEqual(101_600);
  });

  it('a partial line (no newline yet) counts raw and settles once its newline lands', () => {
    fs.writeFileSync(file, line(400_000));
    seedContextAnchorForTests('o6', file);
    fs.appendFileSync(file, '{"t":"partial'); // 13 bytes, unterminated
    expect(currentContextTokensSyncForOwner('o6')).toBe(Math.floor((400_000 + 13) / 4));
    fs.appendFileSync(file, '"}\n' + line(4_000));
    expect(currentContextTokensSyncForOwner('o6')).toBe(tokensFromFileSize(file));
  });

  it('a marker inside a still-partial line is honored once the line completes', () => {
    fs.writeFileSync(file, line(1_000_000));
    seedContextAnchorForTests('o7', file);
    const partial = MARKER_LINE.slice(0, MARKER_LINE.length - 1); // marker text, no newline
    fs.appendFileSync(file, partial);
    // Not yet settled: still counted raw from the old countStart (conservative).
    expect(currentContextTokensSyncForOwner('o7')).toBe(
      Math.floor((1_000_000 + partial.length) / 4),
    );
    fs.appendFileSync(file, '\n');
    expect(currentContextTokensSyncForOwner('o7')).toBe(tokensFromFileSize(file));
    expect(currentContextTokensSyncForOwner('o7')).toBe(Math.floor(MARKER_LINE.length / 4));
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
});
