/**
 * EI-23747373965813124 — recurrence guard for the `prompt_snapshot` double-count.
 *
 * Claude Code writes a `"type":"prompt_snapshot"` JSONL line per turn holding the
 * ENTIRE assembled prompt. Those tokens are already counted by the ordinary message
 * lines the snapshot duplicates, so counting the snapshot too inflates the estimate by
 * roughly one whole context PER TURN — and because the snapshot scales with
 * SYSTEM-PROMPT size rather than with work done, the inflation is a fixed per-turn
 * constant that no amount of careful working can avoid.
 *
 * Measured on a live su transcript before the fix: 3 snapshots = 1,890,243 of
 * 2,350,316 bytes (80.4% of the file); consecutive turns moved the gauge +213,592 and
 * +214,759 tokens while their real payloads were ~5KB and ~180KB — near-identical
 * jumps, i.e. not content-proportional. A session at a real ~115k read 578,187 (231%
 * of a 250k limit) and was force-compacted twice on the fabricated number.
 *
 * This is the third member of the family already guarded in compaction-usage.ts:
 * WI-3176 (base64 image double-write) and EI-12848 (`toolUseResult` double-write).
 * The tests below pin BOTH directions: snapshot bytes must not be counted, and the
 * pre-existing discounts must not fire twice on bytes inside a snapshot line (a double
 * discount UNDER-counts, the one direction that risks a real context death).
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  currentContextTokensSyncForOwner,
  resetContextAnchorsForTests,
  seedContextAnchorForTests,
  tokensFromFileSize,
} from './compaction-usage';

/** Files below 256KB take the stat-only fast path, which never reaches the discount
 *  logic — every fixture here must clear it or the test would assert nothing. */
const BOUNDARY_SCAN_MIN = 256 * 1024;

function writeTranscript(lines: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-snap-'));
  const p = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(p, lines.join('\n') + '\n', 'latin1');
  return p;
}

/** An ordinary in-context line. Must not contain the snapshot marker. */
function ordinaryLine(i: number, filler = 2000): string {
  return JSON.stringify({
    parentUuid: `p${i}`,
    type: i % 2 === 0 ? 'user' : 'assistant',
    message: { role: i % 2 === 0 ? 'user' : 'assistant', content: 'x'.repeat(filler) },
  });
}

/** A prompt_snapshot line — wholly out-of-context bookkeeping. */
function snapshotLine(i: number, filler = 200_000, extra = ''): string {
  return `{"parentUuid":"s${i}","type":"prompt_snapshot","snapshot":"${'y'.repeat(filler)}"${extra}}`;
}

/** Exactly what tokensFromFileSize should return: every byte in the file except the
 *  prompt_snapshot lines themselves (their trailing newline still counts, matching the
 *  half-open [lineStart, newlineIndex) range the implementation discounts). */
function expectedTokens(lines: string[]): number {
  const total = lines.join('\n').length + 1; // + trailing newline
  const snapBytes = lines
    .filter((l) => l.includes('"type":"prompt_snapshot"'))
    .reduce((n, l) => n + l.length, 0);
  return Math.floor((total - snapBytes) / 4);
}

describe('tokensFromFileSize — prompt_snapshot discount (EI-23747373965813124)', () => {
  it('does NOT count prompt_snapshot lines, which dominate a real su transcript', async () => {
    const lines: string[] = [];
    for (let i = 0; i < 60; i++) lines.push(ordinaryLine(i));
    for (let i = 0; i < 3; i++) lines.push(snapshotLine(i));

    const p = writeTranscript(lines);
    const size = fs.statSync(p).size;
    expect(size).toBeGreaterThan(BOUNDARY_SCAN_MIN); // the fixture reaches the scan path

    const got = await tokensFromFileSize(p);
    expect(got).toBe(expectedTokens(lines));

    // Falsifiability control: without the discount this is what the gauge reported.
    // The snapshots are ~83% of this fixture, mirroring the 80.4% measured live, so a
    // regression is not a rounding difference — it is a >5x over-report.
    const wholeFile = Math.floor(size / 4);
    expect(got!).toBeLessThan(wholeFile / 5);
  });

  it('leaves a transcript with no prompt_snapshot lines byte-identical to whole-file/4', async () => {
    const lines: string[] = [];
    for (let i = 0; i < 160; i++) lines.push(ordinaryLine(i));

    const p = writeTranscript(lines);
    const size = fs.statSync(p).size;
    expect(size).toBeGreaterThan(BOUNDARY_SCAN_MIN);

    expect(await tokensFromFileSize(p)).toBe(Math.floor(size / 4));
  });

  it('does not discount a toolUseResult inside a snapshot line twice (no under-count)', async () => {
    const lines: string[] = [];
    for (let i = 0; i < 60; i++) lines.push(ordinaryLine(i));
    // A snapshot whose serialised body happens to carry the EI-12848 key. Discounting
    // the line AND the key would subtract those bytes twice.
    lines.push(snapshotLine(0, 200_000, `,"toolUseResult":"${'z'.repeat(50_000)}"`));
    lines.push(snapshotLine(1));

    const p = writeTranscript(lines);
    expect(fs.statSync(p).size).toBeGreaterThan(BOUNDARY_SCAN_MIN);
    expect(await tokensFromFileSize(p)).toBe(expectedTokens(lines));
  });

  it('discounts a line carrying several snapshot markers exactly once', async () => {
    const lines: string[] = [];
    for (let i = 0; i < 60; i++) lines.push(ordinaryLine(i));
    // Two raw markers on one physical line — a naive per-hit accumulator would
    // subtract the line twice and drive the estimate below the real context.
    lines.push(snapshotLine(0, 200_000, `,"nested":{"type":"prompt_snapshot"}`));

    const p = writeTranscript(lines);
    expect(fs.statSync(p).size).toBeGreaterThan(BOUNDARY_SCAN_MIN);
    expect(await tokensFromFileSize(p)).toBe(expectedTokens(lines));
  });

  it('still counts a line that merely MENTIONS the marker in escaped string content', async () => {
    const lines: string[] = [];
    // 160 lines: this fixture has no big snapshot line to carry it over the scan
    // minimum, so the ordinary lines must clear it alone — below it the stat-only
    // fast path returns size/4 and the assertion would pass without exercising the
    // discount logic at all.
    for (let i = 0; i < 160; i++) lines.push(ordinaryLine(i));
    // An agent reading this very source file puts the marker in context ESCAPED, so it
    // is real context and must keep full weight (the WI-4608 false-positive class).
    lines.push(
      JSON.stringify({
        parentUuid: 'mention',
        type: 'assistant',
        message: { role: 'assistant', content: `the marker is "type":"prompt_snapshot" ${'q'.repeat(5000)}` },
      }),
    );

    const p = writeTranscript(lines);
    const size = fs.statSync(p).size;
    expect(size).toBeGreaterThan(BOUNDARY_SCAN_MIN);
    // No line is discounted: JSON.stringify escaped the quotes, so the raw byte form
    // never appears and the whole file counts.
    expect(await tokensFromFileSize(p)).toBe(Math.floor(size / 4));
  });
});

/**
 * EI-23760035638533818 — the same discount on the ANCHORED path.
 *
 * EI-23747373965813124 fixed `tokensFromFileSize` (the full-scan estimator) but not the
 * anchored incremental reader, which is what actually renders the live PostToolUse gauge
 * (inbox.ts:1475 → currentContextTokensForOwner → anchorTokens). The anchor therefore kept
 * counting whole snapshot lines, and since Claude Code appends one per prompt change the
 * gauge advanced in discrete ~200k steps that no tool result explains.
 *
 * Measured on a live su transcript 2026-09-20 (session e90cfa6e): one 807,442-byte
 * prompt_snapshot line moved the gauge 128,671 → 338,204 in a single turn whose tool
 * results totalled a few KB. 807,442/4 = 201,860 — the step, exactly.
 *
 * Parity with `tokensFromFileSize` is the contract these assert, because that is already
 * the invariant compaction-usage.anchor.test.ts holds the anchored path to on a plain
 * transcript; snapshots are simply where it silently stopped holding.
 */
describe('anchored reads — prompt_snapshot discount (EI-23760035638533818)', () => {
  afterEach(() => resetContextAnchorsForTests());

  it('a snapshot appended BETWEEN reads does not step the gauge (the reported symptom)', async () => {
    const lines: string[] = [];
    for (let i = 0; i < 160; i++) lines.push(ordinaryLine(i));
    const p = writeTranscript(lines);
    expect(fs.statSync(p).size).toBeGreaterThan(BOUNDARY_SCAN_MIN);

    expect(seedContextAnchorForTests('anchor-step', p)).toBe(true);
    const before = currentContextTokensSyncForOwner('anchor-step');
    expect(before).toBe(await tokensFromFileSize(p));

    // The live shape: one turn appends one whole system-prompt snapshot.
    const snap = snapshotLine(0, 200_000);
    fs.appendFileSync(p, snap + '\n', 'latin1');
    const after = currentContextTokensSyncForOwner('anchor-step');

    // Only the snapshot's trailing newline is real growth, so the reading must not move.
    expect(after).toBe(await tokensFromFileSize(p));
    expect(after! - before!).toBeLessThanOrEqual(1);

    // Falsifiability control: before this fix the anchor added the whole line, i.e.
    // ~50,000 tokens for this fixture. Anything near that is the regression returning.
    expect(after!).toBeLessThan(before! + 1_000);
  });

  it('a snapshot present AT SEED time is discounted too (seedAnchorFromFile branch)', async () => {
    const lines: string[] = [];
    for (let i = 0; i < 60; i++) lines.push(ordinaryLine(i));
    for (let i = 0; i < 3; i++) lines.push(snapshotLine(i));
    const p = writeTranscript(lines);
    const size = fs.statSync(p).size;
    expect(size).toBeGreaterThan(BOUNDARY_SCAN_MIN);

    expect(seedContextAnchorForTests('anchor-seed', p)).toBe(true);
    const got = currentContextTokensSyncForOwner('anchor-seed');
    expect(got).toBe(expectedTokens(lines));
    expect(got).toBe(await tokensFromFileSize(p));
    // Snapshots are ~83% of this fixture — a regression is a >5x over-report, not rounding.
    expect(got!).toBeLessThan(Math.floor(size / 4) / 5);
  });

  it('a snapshot after a compaction marker is discounted (advanceAnchor marker branch)', async () => {
    const lines: string[] = [];
    for (let i = 0; i < 160; i++) lines.push(ordinaryLine(i));
    const p = writeTranscript(lines);
    expect(seedContextAnchorForTests('anchor-marker', p)).toBe(true);
    currentContextTokensSyncForOwner('anchor-marker');

    // A compaction lands, then the very next turn writes its fresh snapshot. Counting
    // restarts at the marker, so this exercises the OTHER advanceAnchor branch.
    fs.appendFileSync(
      p,
      '{"type":"summary","isCompactSummary":true,"summary":"compacted"}\n' +
        ordinaryLine(999, 3000) + '\n' +
        snapshotLine(7, 200_000) + '\n',
      'latin1',
    );

    const after = currentContextTokensSyncForOwner('anchor-marker');
    expect(after).toBe(await tokensFromFileSize(p));
    // Post-compaction the real context is one small turn, NOT one system prompt.
    expect(after!).toBeLessThan(5_000);
  });

  it('does not double-discount a toolUseResult inside a snapshot on the anchored path', () => {
    const lines: string[] = [];
    for (let i = 0; i < 60; i++) lines.push(ordinaryLine(i));
    lines.push(snapshotLine(0, 200_000, `,"toolUseResult":"${'z'.repeat(50_000)}"`));
    const p = writeTranscript(lines);
    expect(fs.statSync(p).size).toBeGreaterThan(BOUNDARY_SCAN_MIN);

    expect(seedContextAnchorForTests('anchor-ture', p)).toBe(true);
    // Under-counting is the dangerous direction: it hides a real approaching limit.
    expect(currentContextTokensSyncForOwner('anchor-ture')).toBe(expectedTokens(lines));
  });
});
