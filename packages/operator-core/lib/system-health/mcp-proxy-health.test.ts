/**
 * mcp-proxy-health.test — the MCP tool-call-transport SLO reader + summarizer
 * (backend-reliability-100pct-2026-07-03 W8 / P-008). Pins:
 *  - the PURE classification (hard vs soft vs otherNon2xx) + the stale-socket-400 signature,
 *  - the window + future-skew filtering,
 *  - the bounded TAIL reader against real temp files (absent = healthy zero, partial leading
 *    line dropped, malformed line skipped, genuine error → null).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  summarizeMcpProxyHealth,
  isStaleSocket400,
  readMcpProxyFailureTail,
  mcpProxyFailureLogPath,
  type McpProxyFailureRecord,
} from './mcp-proxy-health';

const NOW = 1_760_000_000_000; // fixed epoch — hermetic
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

function rec(o: Partial<McpProxyFailureRecord> & { kind: string }): McpProxyFailureRecord {
  return { ts: iso(1000), ...o };
}

describe('isStaleSocket400 — the W1.3 signature (HTTP 400 + connection:close)', () => {
  it('true for status 400 + connection close (any case)', () => {
    expect(isStaleSocket400({ status: 400, connection: 'close' })).toBe(true);
    expect(isStaleSocket400({ status: 400, connection: 'Close' })).toBe(true);
    expect(isStaleSocket400({ status: 400, connection: 'keep-alive, close' })).toBe(true);
  });
  it('false for a 400 WITHOUT connection:close (a genuine bad-request, not a stale socket)', () => {
    expect(isStaleSocket400({ status: 400, connection: 'keep-alive' })).toBe(false);
    expect(isStaleSocket400({ status: 400, connection: null })).toBe(false);
    expect(isStaleSocket400({ status: 400 })).toBe(false);
  });
  it('false for other statuses', () => {
    expect(isStaleSocket400({ status: 502, connection: 'close' })).toBe(false);
    expect(isStaleSocket400({ status: 503, connection: 'close' })).toBe(false);
  });
});

describe('summarizeMcpProxyHealth — classification', () => {
  it('exhausted_refused and upstream_error are HARD failures', () => {
    const d = summarizeMcpProxyHealth(
      [rec({ kind: 'exhausted_refused', status: 503 }), rec({ kind: 'upstream_error', status: 502 })],
      NOW,
    );
    expect(d.hardFailures).toBe(2);
    expect(d.recovered).toBe(0);
    expect(d.otherNon2xx).toBe(0);
    expect(d.total).toBe(2);
  });

  it('recovered is SOFT (informational — the proxy absorbed a deploy blip)', () => {
    const d = summarizeMcpProxyHealth([rec({ kind: 'recovered', status: 200, attempts: 3 })], NOW);
    expect(d.hardFailures).toBe(0);
    expect(d.recovered).toBe(1);
    expect(d.total).toBe(1);
  });

  it('upstream_non2xx WITH the stale-socket-400 signature is HARD (W1.3 regression)', () => {
    const d = summarizeMcpProxyHealth([rec({ kind: 'upstream_non2xx', status: 400, connection: 'close' })], NOW);
    expect(d.hardFailures).toBe(1);
    expect(d.otherNon2xx).toBe(0);
  });

  it('upstream_non2xx WITHOUT the stale-socket signature is otherNon2xx (genuine upstream 4xx/5xx)', () => {
    const d = summarizeMcpProxyHealth(
      [
        rec({ kind: 'upstream_non2xx', status: 404, connection: 'keep-alive' }),
        rec({ kind: 'upstream_non2xx', status: 500, connection: null }),
      ],
      NOW,
    );
    expect(d.hardFailures).toBe(0);
    expect(d.otherNon2xx).toBe(2);
  });

  it('byKind tallies every kind; newestAt is the freshest in-window record', () => {
    const d = summarizeMcpProxyHealth(
      [
        rec({ kind: 'recovered', ts: iso(5000) }),
        rec({ kind: 'exhausted_refused', ts: iso(1000) }),
        rec({ kind: 'exhausted_refused', ts: iso(3000) }),
      ],
      NOW,
    );
    expect(d.byKind).toEqual({ recovered: 1, exhausted_refused: 2 });
    expect(d.newestAt).toBe(NOW - 1000);
  });
});

describe('summarizeMcpProxyHealth — window + skew filtering', () => {
  it('drops records older than the window', () => {
    const windowMs = 60 * 60_000;
    const d = summarizeMcpProxyHealth(
      [rec({ kind: 'exhausted_refused', ts: iso(windowMs + 60_000) }), rec({ kind: 'exhausted_refused', ts: iso(1000) })],
      NOW,
      windowMs,
    );
    expect(d.hardFailures).toBe(1); // only the in-window one
    expect(d.total).toBe(1);
  });

  it('drops far-future records (clock-skew garbage) but tolerates minor skew', () => {
    const d = summarizeMcpProxyHealth(
      [
        rec({ kind: 'exhausted_refused', ts: new Date(NOW + 5 * 60_000).toISOString() }), // far future → dropped
        rec({ kind: 'exhausted_refused', ts: new Date(NOW + 10_000).toISOString() }), // +10s minor skew → kept
      ],
      NOW,
    );
    expect(d.hardFailures).toBe(1);
  });

  it('ignores records with an unparseable ts', () => {
    const d = summarizeMcpProxyHealth([{ ts: 'not-a-date', kind: 'exhausted_refused' }], NOW);
    expect(d.total).toBe(0);
  });

  it('empty input → all-zero summary', () => {
    const d = summarizeMcpProxyHealth([], NOW);
    expect(d).toMatchObject({ total: 0, hardFailures: 0, recovered: 0, otherNon2xx: 0, newestAt: null });
  });
});

describe('readMcpProxyFailureTail — bounded, fail-soft reader', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });
  function tmpFile(name = 'mcp-proxy-failures.jsonl'): string {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-proxy-health-'));
    dirs.push(dir);
    return join(dir, name);
  }

  it('absent ledger → [] (a healthy zero, NOT an error)', () => {
    expect(readMcpProxyFailureTail(join(tmpdir(), 'definitely-absent-xyz.jsonl'))).toEqual([]);
  });

  it('empty ledger → []', () => {
    const f = tmpFile();
    writeFileSync(f, '');
    expect(readMcpProxyFailureTail(f)).toEqual([]);
  });

  it('parses well-formed JSONL records and round-trips through the summarizer', () => {
    const f = tmpFile();
    writeFileSync(
      f,
      [
        JSON.stringify({ ts: iso(1000), kind: 'exhausted_refused', status: 503, attempts: 4 }),
        JSON.stringify({ ts: iso(2000), kind: 'recovered', status: 200, attempts: 2 }),
        JSON.stringify({ ts: iso(3000), kind: 'upstream_non2xx', status: 400, connection: 'close' }),
      ].join('\n') + '\n',
    );
    const recs = readMcpProxyFailureTail(f);
    expect(recs).not.toBeNull();
    expect(recs).toHaveLength(3);
    const d = summarizeMcpProxyHealth(recs!, NOW);
    expect(d.hardFailures).toBe(2); // exhausted_refused + stale-socket-400
    expect(d.recovered).toBe(1);
  });

  it('skips malformed / partial lines without failing the whole read', () => {
    const f = tmpFile();
    writeFileSync(
      f,
      [
        JSON.stringify({ ts: iso(1000), kind: 'exhausted_refused' }),
        '{ this is not json',
        '',
        JSON.stringify({ ts: iso(2000), kind: 'recovered' }),
      ].join('\n') + '\n',
    );
    const recs = readMcpProxyFailureTail(f);
    expect(recs).toHaveLength(2);
  });

  it('a record missing ts or kind is skipped (schema guard)', () => {
    const f = tmpFile();
    writeFileSync(
      f,
      [
        JSON.stringify({ ts: iso(1000) }), // no kind
        JSON.stringify({ kind: 'exhausted_refused' }), // no ts
        JSON.stringify({ ts: iso(1000), kind: 'exhausted_refused' }), // valid
      ].join('\n') + '\n',
    );
    expect(readMcpProxyFailureTail(f)).toHaveLength(1);
  });

  it('TAIL read: drops the partial leading line when the file exceeds the byte cap', () => {
    const f = tmpFile();
    // Write a big first record (guaranteed partial-clipped by a small cap) then two clean ones.
    const big = JSON.stringify({ ts: iso(9000), kind: 'recovered', pad: 'x'.repeat(400) });
    writeFileSync(f, big + '\n');
    appendFileSync(f, JSON.stringify({ ts: iso(1000), kind: 'exhausted_refused' }) + '\n');
    appendFileSync(f, JSON.stringify({ ts: iso(500), kind: 'upstream_error' }) + '\n');
    // Cap smaller than the big record → the tail starts mid-first-line → it is dropped,
    // and only the two trailing whole records survive (no parse error).
    const recs = readMcpProxyFailureTail(f, 200);
    expect(recs).not.toBeNull();
    expect(recs!.every((r) => r.kind !== 'recovered')).toBe(true);
    expect(recs!.length).toBeGreaterThanOrEqual(1);
    expect(recs!.length).toBeLessThanOrEqual(2);
  });
});

describe('mcpProxyFailureLogPath — matches the proxy writer contract', () => {
  const prev = process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG;
  afterEach(() => {
    if (prev === undefined) delete process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG;
    else process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG = prev;
  });
  it('honours the env override (the same var the proxy writer reads)', () => {
    process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG = '/tmp/custom-proxy-fail.jsonl';
    expect(mcpProxyFailureLogPath()).toBe('/tmp/custom-proxy-fail.jsonl');
  });
  it('defaults under ~/.papercusp when the env var is unset', () => {
    delete process.env.PAPERCUSP_MCP_PROXY_FAILURE_LOG;
    expect(mcpProxyFailureLogPath()).toMatch(/\.papercusp[/\\]mcp-proxy-failures\.jsonl$/);
  });
});
