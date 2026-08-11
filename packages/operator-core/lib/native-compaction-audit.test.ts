/**
 * native-compaction-audit.test.ts — the P-022 zero-native-summarizer scanner.
 *
 * Run: cd packages/operator-core && npx vitest run lib/native-compaction-audit.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  auditNativeCompactionRetirement,
  countCompactBoundaries,
  countCodexCompactions,
  firstTimestampMs,
} from './native-compaction-audit';

// Relative instants — a hardcoded calendar cutover raced the wall clock (files
// written "now" sat BEFORE a future cutover and the mtime prefilter skipped them).
const CUTOVER = Date.now() - 3_600_000; // one hour ago
const AFTER = new Date(CUTOVER + 600_000).toISOString();
const BEFORE = new Date(CUTOVER - 600_000).toISOString();
const row = (o: Record<string, unknown>) => JSON.stringify(o);
const boundary = row({ type: 'system', subtype: 'compact_boundary', timestamp: AFTER });

let root = '';
let codexRoot = '';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nca-'));
  codexRoot = mkdtempSync(join(tmpdir(), 'nca-codex-'));
  mkdirSync(join(root, 'proj-a'), { recursive: true });
  mkdirSync(join(codexRoot, 'session-42', 'sessions', '2026', '08', '11'), { recursive: true });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(codexRoot, { recursive: true, force: true });
});

function writeTranscript(name: string, lines: string[], mtimeMs = Date.now()) {
  const p = join(root, 'proj-a', name);
  writeFileSync(p, lines.join('\n') + '\n');
  utimesSync(p, new Date(mtimeMs), new Date(mtimeMs));
  return p;
}

function writeCodexRollout(name: string, lines: string[], mtimeMs = Date.now()) {
  const p = join(codexRoot, 'session-42', 'sessions', '2026', '08', '11', name);
  writeFileSync(p, lines.join('\n') + '\n');
  utimesSync(p, new Date(mtimeMs), new Date(mtimeMs));
  return p;
}

describe('countCompactBoundaries', () => {
  it('counts only REAL system/compact_boundary rows — a quoted marker inside message content never counts', () => {
    const text = [
      boundary,
      row({ type: 'assistant', message: { content: 'discussing "subtype":"compact_boundary" markers' } }),
      boundary,
    ].join('\n');
    expect(countCompactBoundaries(text)).toBe(2);
  });

  it('zero for a transcript with no marker at all (cheap prefilter path)', () => {
    expect(countCompactBoundaries(row({ type: 'user', timestamp: '2026-07-18T03:00:00Z' }))).toBe(0);
  });
});

describe('countCodexCompactions', () => {
  it('counts only REAL top-level compacted rollout events, never a marker copied into message content', () => {
    const text = [
      row({ timestamp: AFTER, type: 'compacted', payload: { replacement_history: [] } }),
      row({ timestamp: AFTER, type: 'event_msg', payload: { message: 'discussing "type":"compacted" markers' } }),
      row({ timestamp: AFTER, type: 'compacted', payload: { replacement_history: [] } }),
    ].join('\n');
    expect(countCodexCompactions(text)).toBe(2);
  });

  it('returns zero through the cheap prefilter when no marker exists', () => {
    expect(countCodexCompactions(row({ timestamp: AFTER, type: 'event_msg' }))).toBe(0);
  });
});

describe('firstTimestampMs', () => {
  it('parses the first row timestamp; null on malformed', () => {
    expect(firstTimestampMs(row({ timestamp: AFTER }) + '\n' + boundary)).toBe(Date.parse(AFTER));
    expect(firstTimestampMs('not json\n')).toBeNull();
    expect(firstTimestampMs('')).toBeNull();
  });
});

describe('auditNativeCompactionRetirement', () => {
  it('a post-cutover session with native boundaries is an offender; the verdict flips to violations', async () => {
    writeTranscript('dirty.jsonl', [row({ timestamp: AFTER }), boundary, boundary]);
    writeTranscript('clean.jsonl', [row({ timestamp: AFTER }), row({ type: 'user' })]);
    const r = await auditNativeCompactionRetirement({ sinceMs: CUTOVER, root });
    expect(r.scanned).toBe(2);
    expect(r.offenders).toHaveLength(1);
    expect(r.offenders[0]!.backend).toBe('claude');
    expect(r.offenders[0]!.compactBoundaries).toBe(2);
    expect(r.totalBoundaries).toBe(2);
    expect(r.verdict).toBe('violations');
  });

  it('audits managed Codex rollout trees and reports type=compacted as a native boundary', async () => {
    writeTranscript('clean.jsonl', [row({ timestamp: AFTER }), row({ type: 'user' })]);
    writeCodexRollout('rollout-after.jsonl', [
      row({ timestamp: AFTER, type: 'session_meta' }),
      row({ timestamp: AFTER, type: 'compacted', payload: { replacement_history: [] } }),
    ]);
    const r = await auditNativeCompactionRetirement({ sinceMs: CUTOVER, root, codexRoots: [codexRoot] });
    expect(r.scanned).toBe(2);
    expect(r.scannedByBackend).toEqual({ claude: 1, codex: 1 });
    expect(r.offenders).toEqual([
      expect.objectContaining({ backend: 'codex', compactBoundaries: 1 }),
    ]);
    expect(r.totalBoundaries).toBe(1);
    expect(r.verdict).toBe('violations');
  });

  it('excludes a Codex rollout started before the cutover even when modified afterward', async () => {
    writeCodexRollout('rollout-before.jsonl', [
      row({ timestamp: BEFORE, type: 'session_meta' }),
      row({ timestamp: AFTER, type: 'compacted', payload: { replacement_history: [] } }),
    ]);
    const r = await auditNativeCompactionRetirement({ sinceMs: CUTOVER, root, codexRoots: [codexRoot] });
    expect(r.scannedByBackend.codex).toBe(0);
    expect(r.offenders).toEqual([]);
    expect(r.verdict).toBe('clean');
  });

  it('a session STARTED before the cutover is out of scope even if it compacted natively (pre-existing sessions die out, not audited)', async () => {
    writeTranscript('old.jsonl', [row({ timestamp: BEFORE }), boundary]);
    const r = await auditNativeCompactionRetirement({ sinceMs: CUTOVER, root });
    expect(r.scanned).toBe(0);
    expect(r.offenders).toEqual([]);
    expect(r.verdict).toBe('clean');
  });

  it('a file untouched since before the cutover is skipped without being read into scope', async () => {
    writeTranscript('stale.jsonl', [row({ timestamp: AFTER }), boundary], CUTOVER - 60_000);
    const r = await auditNativeCompactionRetirement({ sinceMs: CUTOVER, root });
    expect(r.scanned).toBe(0);
    expect(r.verdict).toBe('clean');
  });

  it('an unreadable start timestamp is included CONSERVATIVELY (an unattributable native compaction must surface)', async () => {
    writeTranscript('mystery.jsonl', ['garbage first line', boundary]);
    const r = await auditNativeCompactionRetirement({ sinceMs: CUTOVER, root });
    expect(r.scanned).toBe(1);
    expect(r.offenders).toHaveLength(1);
    expect(r.offenders[0]!.sessionStartMs).toBeNull();
    expect(r.verdict).toBe('violations');
  });

  it('a missing root fails soft to an empty clean report', async () => {
    const r = await auditNativeCompactionRetirement({ sinceMs: CUTOVER, root: join(root, 'nope') });
    expect(r).toEqual({
      scanned: 0,
      scannedByBackend: { claude: 0, codex: 0 },
      offenders: [],
      totalBoundaries: 0,
      verdict: 'clean',
    });
  });
});
