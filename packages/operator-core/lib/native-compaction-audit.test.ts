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
  firstTimestampMs,
} from './native-compaction-audit';

const CUTOVER = Date.parse('2026-07-18T02:00:00Z');
const row = (o: Record<string, unknown>) => JSON.stringify(o);
const boundary = row({ type: 'system', subtype: 'compact_boundary', timestamp: '2026-07-18T03:30:00Z' });

let root = '';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nca-'));
  mkdirSync(join(root, 'proj-a'), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function writeTranscript(name: string, lines: string[], mtimeMs = Date.now()) {
  const p = join(root, 'proj-a', name);
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

describe('firstTimestampMs', () => {
  it('parses the first row timestamp; null on malformed', () => {
    expect(firstTimestampMs(row({ timestamp: '2026-07-18T03:00:00Z' }) + '\n' + boundary)).toBe(
      Date.parse('2026-07-18T03:00:00Z'),
    );
    expect(firstTimestampMs('not json\n')).toBeNull();
    expect(firstTimestampMs('')).toBeNull();
  });
});

describe('auditNativeCompactionRetirement', () => {
  it('a post-cutover session with native boundaries is an offender; the verdict flips to violations', async () => {
    writeTranscript('dirty.jsonl', [row({ timestamp: '2026-07-18T03:00:00Z' }), boundary, boundary]);
    writeTranscript('clean.jsonl', [row({ timestamp: '2026-07-18T04:00:00Z' }), row({ type: 'user' })]);
    const r = await auditNativeCompactionRetirement({ sinceMs: CUTOVER, root });
    expect(r.scanned).toBe(2);
    expect(r.offenders).toHaveLength(1);
    expect(r.offenders[0]!.compactBoundaries).toBe(2);
    expect(r.totalBoundaries).toBe(2);
    expect(r.verdict).toBe('violations');
  });

  it('a session STARTED before the cutover is out of scope even if it compacted natively (pre-existing sessions die out, not audited)', async () => {
    writeTranscript('old.jsonl', [row({ timestamp: '2026-07-17T01:00:00Z' }), boundary]);
    const r = await auditNativeCompactionRetirement({ sinceMs: CUTOVER, root });
    expect(r.scanned).toBe(0);
    expect(r.offenders).toEqual([]);
    expect(r.verdict).toBe('clean');
  });

  it('a file untouched since before the cutover is skipped without being read into scope', async () => {
    writeTranscript('stale.jsonl', [row({ timestamp: '2026-07-18T03:00:00Z' }), boundary], CUTOVER - 60_000);
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
    expect(r).toEqual({ scanned: 0, offenders: [], totalBoundaries: 0, verdict: 'clean' });
  });
});
