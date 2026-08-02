import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  readRecentProxyFailures,
  summarizeProxyFailureLines,
} from './mcp-proxy-failure-summary';

const NOW = Date.parse('2026-08-02T23:00:00.000Z');
const at = (minsAgo: number) => new Date(NOW - minsAgo * 60_000).toISOString();
const rec = (kind: string, minsAgo: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ ts: at(minsAgo), kind, target: '127.0.0.1:3070', ...extra });

describe('summarizeProxyFailureLines', () => {
  it('counts by kind, newest-first, inside the window', () => {
    const s = summarizeProxyFailureLines(
      [rec('upstream_error', 1), rec('upstream_error', 2), rec('recovered', 3)],
      { nowMs: NOW, windowMinutes: 20 },
    );
    expect(s.total).toBe(3);
    expect(Object.keys(s.byKind)[0]).toBe('upstream_error'); // sorted descending
    expect(s.byKind.upstream_error).toBe(2);
  });

  it('EXCLUDES records outside the window', () => {
    const s = summarizeProxyFailureLines([rec('recovered', 5), rec('recovered', 500)], {
      nowMs: NOW,
      windowMinutes: 20,
    });
    expect(s.total).toBe(1);
    expect(s.recoveries).toBe(1);
  });

  it('treats a RECOVERY as a fault that happened — the WI-6740 trap', () => {
    // The whole point: 7 recoveries and zero hard failures must NOT read as healthy.
    const s = summarizeProxyFailureLines(
      Array.from({ length: 7 }, (_, i) => rec('recovered', i + 1)),
      { nowMs: NOW, windowMinutes: 20 },
    );
    expect(s.recoveries).toBe(7);
    expect(s.exhausted).toBe(0);
    expect(s.headline).toBeTruthy();
    expect(s.headline).toMatch(/SURVIVED by retry/);
    expect(s.headline).toMatch(/not a sign of health/i);
  });

  it('separates rescued faults from requests that actually failed', () => {
    const s = summarizeProxyFailureLines(
      [rec('recovered', 1), rec('post_connect_retry', 1), rec('exhausted_refused', 2), rec('upstream_non2xx', 2)],
      { nowMs: NOW, windowMinutes: 20 },
    );
    expect(s.recoveries).toBe(2);
    expect(s.exhausted).toBe(2);
    expect(s.headline).toMatch(/could NOT rescue/);
  });

  it('stays SILENT when there is nothing to report', () => {
    // A cheerful "0 problems" on every call trains the reader to skip the field.
    const s = summarizeProxyFailureLines([rec('absorb_429', 1)], { nowMs: NOW, windowMinutes: 20 });
    expect(s.total).toBe(1);
    expect(s.headline).toBeUndefined();
  });

  it('survives torn and malformed lines rather than throwing', () => {
    const s = summarizeProxyFailureLines(
      ['{"ts":"2026-08-02T22:5', '', 'not json at all', rec('recovered', 1)],
      { nowMs: NOW, windowMinutes: 20 },
    );
    expect(s.total).toBe(1);
    expect(s.recoveries).toBe(1);
  });

  it('ignores a record with no parseable timestamp', () => {
    const s = summarizeProxyFailureLines(
      [JSON.stringify({ kind: 'recovered' }), JSON.stringify({ ts: 'nonsense', kind: 'recovered' })],
      { nowMs: NOW, windowMinutes: 20 },
    );
    expect(s.total).toBe(0);
  });
});

describe('readRecentProxyFailures — bounded by construction', () => {
  const write = (name: string, body: string) => {
    const p = join(mkdtempSync(join(tmpdir(), 'proxy-fail-')), name);
    writeFileSync(p, body);
    return p;
  };

  it('reads a small file whole and reports truncated:false', () => {
    const p = write('small.jsonl', [rec('recovered', 1), rec('upstream_error', 2)].join('\n') + '\n');
    const s = readRecentProxyFailures({ path: p, nowMs: NOW, windowMinutes: 20 });
    expect(s.total).toBe(2);
    expect(s.truncated).toBe(false);
  });

  it('reads only a TAIL of a large file and says so — counts are a lower bound', () => {
    // The real log is 27MB. Reading it whole would be slower than the incident it describes.
    const many = Array.from({ length: 4000 }, (_, i) => rec('recovered', 1, { seq: i })).join('\n') + '\n';
    const p = write('big.jsonl', many);
    const s = readRecentProxyFailures({ path: p, nowMs: NOW, windowMinutes: 20, maxBytes: 4096 });

    expect(s.truncated).toBe(true);
    expect(s.total).toBeGreaterThan(0);
    expect(s.total).toBeLessThan(4000); // proves we did not read it all
  });

  it('drops the partial first line when starting mid-file', () => {
    const body = 'GARBAGE-PARTIAL-LINE-NOT-JSON\n' + rec('recovered', 1) + '\n';
    const p = write('partial.jsonl', body);
    // maxBytes smaller than the file forces a mid-file start.
    const s = readRecentProxyFailures({ path: p, nowMs: NOW, windowMinutes: 20, maxBytes: body.length - 10 });
    expect(s.truncated).toBe(true);
    expect(s.total).toBe(1); // the garbage line was discarded, the good record survived
  });

  it('returns an empty summary for a missing log instead of throwing', () => {
    const s = readRecentProxyFailures({ path: '/nonexistent/nope.jsonl', nowMs: NOW });
    expect(s.total).toBe(0);
    expect(s.headline).toBeUndefined();
  });
});
