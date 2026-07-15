/** residual-carry-pass-live (P-019 live legs, D-010): the reserved-maintenance-
 *  lane llmFn wiring + the durable per-class sample ledger. The impure edge —
 *  fetch and fs are stubbed; the pure scorer (residual-carry-pass.ts) is already
 *  covered by its own test file. */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildMaintenanceResidualLlmFn,
  readResidualCarryLedger,
  appendResidualCarryLedgerEvent,
  reportResidualCarrySamples,
  type ResidualSampleLedgerEvent,
} from './residual-carry-pass-live';

function fakeResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('buildMaintenanceResidualLlmFn — the reserved-lane llmFn seam', () => {
  it('POSTs { prompt, maxTokens } to /maintenance/summarize and returns the summary text', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return fakeResponse(200, { ok: true, summary: '{"findings":[]}' });
    }) as unknown as typeof fetch;

    const llmFn = buildMaintenanceResidualLlmFn({ baseUrl: 'http://127.0.0.1:8788', fetchImpl });
    const out = await llmFn('PROMPT TEXT', { maxTokens: 4000, sessionClass: 'claude-interactive' });

    expect(out).toBe('{"findings":[]}');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://127.0.0.1:8788/maintenance/summarize');
    const body = JSON.parse(String(calls[0].init.body));
    expect(body).toEqual({ prompt: 'PROMPT TEXT', maxTokens: 4000 });
    // Never sends carryOwner — must always ride the real LLM branch, never the
    // deterministic-carry short-circuit.
    expect(calls[0].url).not.toContain('carryOwner');
  });

  it('clamps an over-large maxTokens request to RESIDUAL_MAX_TOKENS', async () => {
    let sentBody: Record<string, unknown> = {};
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      sentBody = JSON.parse(String(init.body));
      return fakeResponse(200, { ok: true, summary: '{}' });
    }) as unknown as typeof fetch;
    const llmFn = buildMaintenanceResidualLlmFn({ fetchImpl });
    await llmFn('p', { maxTokens: 999_999, sessionClass: 'x' });
    expect(sentBody.maxTokens).toBe(4000);
  });

  it('throws on a non-2xx response (caller — runResidualCarryPass — treats a throw as parseError, never a false no-miss)', async () => {
    const fetchImpl = vi.fn(async () => fakeResponse(500, { error: 'boom' })) as unknown as typeof fetch;
    const llmFn = buildMaintenanceResidualLlmFn({ fetchImpl });
    await expect(llmFn('p', { maxTokens: 100, sessionClass: 'x' })).rejects.toThrow(/maintenance\/summarize failed/);
  });

  it('throws when the gateway responds 200 with no summary text', async () => {
    const fetchImpl = vi.fn(async () => fakeResponse(200, { ok: true })) as unknown as typeof fetch;
    const llmFn = buildMaintenanceResidualLlmFn({ fetchImpl });
    await expect(llmFn('p', { maxTokens: 100, sessionClass: 'x' })).rejects.toThrow(/no summary text/);
  });
});

describe('residual carry sample ledger — durable, bounded JSONL', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'residual-carry-ledger-'));
    return async () => rm(dir, { recursive: true, force: true });
  });

  it('round-trips an appended event', async () => {
    const event: ResidualSampleLedgerEvent = {
      ts: '2026-07-15T12:00:00.000Z',
      ownerId: 'su-1',
      sessionClass: 'claude-interactive',
      material: false,
      ran: true,
      source: 'smoke:manual-verification',
    };
    expect(await appendResidualCarryLedgerEvent(event, dir)).toBe(true);
    const rows = await readResidualCarryLedger(dir);
    expect(rows).toEqual([event]);
  });

  it('returns [] for a directory with no ledger yet', async () => {
    expect(await readResidualCarryLedger(join(dir, 'does-not-exist'))).toEqual([]);
  });

  it('reportResidualCarrySamples aggregates persisted samples by session class', async () => {
    await appendResidualCarryLedgerEvent(
      { ts: 't1', ownerId: 'su-1', sessionClass: 'claude-interactive', material: false, ran: true, source: 's1' },
      dir,
    );
    await appendResidualCarryLedgerEvent(
      { ts: 't2', ownerId: 'su-1', sessionClass: 'claude-interactive', material: true, ran: true, source: 's2' },
      dir,
    );
    const report = await reportResidualCarrySamples(() => readResidualCarryLedger(dir));
    const cls = report.perClass.find((c) => c.sessionClass === 'claude-interactive');
    expect(cls).toBeDefined();
    expect(cls?.n).toBe(2);
    expect(cls?.materialCount).toBe(1);
    // Nowhere near minSample(30) — must not recommend retirement on 2 samples.
    expect(cls?.retire).toBe(false);
  });
});
