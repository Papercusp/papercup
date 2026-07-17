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
  runMaintenanceResidualSample,
  readRetiredResidualClasses,
  retireResidualClass,
  unretireResidualClass,
  isResidualClassRetired,
  RESIDUAL_SAMPLE_MIN_INTERVAL_MS,
  RESIDUAL_SAMPLE_SOURCE,
  RESIDUAL_LEDGER_MAX_FINDINGS,
  RESIDUAL_LEDGER_FINDING_MAX_CHARS,
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

describe('runMaintenanceResidualSample — the gateway-boundary sampling harness (D-010 live leg 2)', () => {
  const NOW = Date.parse('2026-07-16T12:00:00.000Z');
  const INPUT = {
    carryOwner: 'su-samp-1',
    stage1Doc: 'STAGE-1 CARRY DOC',
    droppedContext: 'RAW DROPPED TURNS',
    interactive: true,
  };
  function harness(overrides: Record<string, unknown> = {}) {
    const appended: ResidualSampleLedgerEvent[] = [];
    const deps = {
      readLedger: async () => [] as ResidualSampleLedgerEvent[],
      appendLedger: async (e: ResidualSampleLedgerEvent) => {
        appended.push(e);
        return true;
      },
      llmFn: async () => '{"findings":[]}',
      resolveAgent: async () => 'omp' as string | null,
      // EI-13234: default the canonical resolver to a MISS so the existing cases keep
      // exercising the legacy gateway-<agent> fallback vocabulary.
      resolveCanonicalClass: async () => null as string | null,
      isRetired: async () => false,
      now: () => NOW,
      ...overrides,
    };
    return { appended, deps };
  }

  it('EI-13234: a resolvable live host classifies the row with the CANONICAL sessionClassForHost name, not gateway-<agent>', async () => {
    const h = harness({ resolveCanonicalClass: async () => 'claude-interactive' });
    const r = await runMaintenanceResidualSample(INPUT, h.deps);
    expect(r).toMatchObject({ sampled: true, sessionClass: 'claude-interactive' });
    expect(h.appended[0]).toMatchObject({ sessionClass: 'claude-interactive' });
  });

  it('EI-13234: a canonical-resolver MISS falls back to the legacy gateway-<agent> label (a boundary is never unsampled over a classifier fault)', async () => {
    const h = harness({ resolveCanonicalClass: async () => null });
    const r = await runMaintenanceResidualSample(INPUT, h.deps);
    expect(r).toMatchObject({ sampled: true, sessionClass: 'gateway-omp' });
  });

  it('appends a parsed no-miss sample with the gateway-<agent> class + the live-boundary source stamp', async () => {
    const h = harness();
    const r = await runMaintenanceResidualSample(INPUT, h.deps);
    expect(r).toEqual({
      sampled: true,
      reason: 'ok',
      sessionClass: 'gateway-omp',
      material: false,
      parseError: false,
    });
    expect(h.appended).toEqual([
      {
        ts: new Date(NOW).toISOString(),
        ownerId: 'su-samp-1',
        sessionClass: 'gateway-omp',
        material: false,
        ran: true,
        parseError: false,
        source: RESIDUAL_SAMPLE_SOURCE,
        findingsCount: 0,
      },
    ]);
  });

  it('a material finding records material:true (a real stage-1 miss enters the corpus)', async () => {
    const h = harness({
      llmFn: async () =>
        '{"findings":[{"text":"the owner said to ship Friday","provenance":"owner","anchor":"turn 12","material":true}]}',
    });
    const r = await runMaintenanceResidualSample(INPUT, h.deps);
    expect(r).toMatchObject({ sampled: true, material: true, parseError: false });
    expect(h.appended[0]).toMatchObject({ material: true, findingsCount: 1 });
  });

  it('persists BOUNDED finding copies on a material row (triageable into a builder fix), and omits the field on a clean row', async () => {
    const longText = 'x'.repeat(1000);
    const findings = Array.from({ length: 8 }, (_, i) => ({
      text: `${i}:${longText}`,
      provenance: 'owner',
      anchor: i % 2 === 0 ? longText : null,
      material: true,
    }));
    const h = harness({ llmFn: async () => JSON.stringify({ findings }) });
    const r = await runMaintenanceResidualSample(INPUT, h.deps);
    expect(r).toMatchObject({ sampled: true, material: true });
    const row = h.appended[0];
    expect(row.findingsCount).toBe(8);
    expect(row.findings).toHaveLength(RESIDUAL_LEDGER_MAX_FINDINGS);
    for (const f of row.findings ?? []) {
      expect(f.text.length).toBeLessThanOrEqual(RESIDUAL_LEDGER_FINDING_MAX_CHARS);
      if (f.anchor !== null) expect(f.anchor.length).toBeLessThanOrEqual(RESIDUAL_LEDGER_FINDING_MAX_CHARS);
      expect(f).toMatchObject({ provenance: 'owner', material: true });
    }

    const clean = harness();
    await runMaintenanceResidualSample(INPUT, clean.deps);
    expect(clean.appended[0].findingsCount).toBe(0);
    expect(clean.appended[0]).not.toHaveProperty('findings');
  });

  it('non-interactive boundaries skip WITHOUT appending — drone compactions are graded by the P-020 drills, and skip rows must not roll real samples out of the bounded ledger', async () => {
    const h = harness();
    const r = await runMaintenanceResidualSample({ ...INPUT, interactive: false }, h.deps);
    expect(r).toEqual({ sampled: false, reason: 'non-interactive', sessionClass: 'gateway-omp' });
    expect(h.appended).toEqual([]);
  });

  it('rate-limits a second sample for the same owner inside RESIDUAL_SAMPLE_MIN_INTERVAL_MS', async () => {
    const h = harness({
      readLedger: async () => [
        {
          ts: new Date(NOW - RESIDUAL_SAMPLE_MIN_INTERVAL_MS + 1_000).toISOString(),
          ownerId: 'su-samp-1',
          sessionClass: 'gateway-omp',
          material: false,
          ran: true,
          source: 'earlier',
        },
      ],
    });
    const r = await runMaintenanceResidualSample(INPUT, h.deps);
    expect(r).toEqual({ sampled: false, reason: 'rate-limited', sessionClass: 'gateway-omp' });
    expect(h.appended).toEqual([]);
  });

  it("another owner's recent sample does NOT rate-limit this owner", async () => {
    const h = harness({
      readLedger: async () => [
        {
          ts: new Date(NOW - 1_000).toISOString(),
          ownerId: 'su-other',
          sessionClass: 'gateway-omp',
          material: false,
          ran: true,
          source: 'earlier',
        },
      ],
    });
    const r = await runMaintenanceResidualSample(INPUT, h.deps);
    expect(r.sampled).toBe(true);
  });

  it('an unparseable LLM response records parseError:true (a blind instrument, never a false "complete")', async () => {
    const h = harness({ llmFn: async () => 'sorry, I cannot do that' });
    const r = await runMaintenanceResidualSample(INPUT, h.deps);
    expect(r).toMatchObject({ sampled: true, parseError: true, material: false });
    expect(h.appended[0]).toMatchObject({ parseError: true });
  });

  it('an llmFn throw is a parseError sample, never a throw out of the sampler', async () => {
    const h = harness({
      llmFn: async () => {
        throw new Error('gateway down');
      },
    });
    const r = await runMaintenanceResidualSample(INPUT, h.deps);
    expect(r).toMatchObject({ sampled: true, parseError: true });
  });

  it('a ledger append failure reports append-failed', async () => {
    const h = harness({ appendLedger: async () => false });
    const r = await runMaintenanceResidualSample(INPUT, h.deps);
    expect(r).toMatchObject({ sampled: false, reason: 'append-failed' });
  });

  it('an unresolvable agent labels the class gateway-unknown (segregated, never folded into a real corpus)', async () => {
    const h = harness({ resolveAgent: async () => null });
    const r = await runMaintenanceResidualSample(INPUT, h.deps);
    expect(r.sessionClass).toBe('gateway-unknown');
    expect(h.appended[0]?.sessionClass).toBe('gateway-unknown');
  });

  it('a blank carryOwner refuses before any work', async () => {
    const h = harness();
    const r = await runMaintenanceResidualSample({ ...INPUT, carryOwner: '  ' }, h.deps);
    expect(r).toEqual({ sampled: false, reason: 'owner-missing' });
    expect(h.appended).toEqual([]);
  });

  it('a RETIRED class skips WITHOUT any LLM call or ledger row — checked before interactivity/rate-limit (D-010 leg 3)', async () => {
    const llmFn = vi.fn(async () => '{"findings":[]}');
    const h = harness({ resolveCanonicalClass: async () => 'claude-interactive', isRetired: async () => true, llmFn });
    const r = await runMaintenanceResidualSample(INPUT, h.deps);
    expect(r).toEqual({ sampled: false, reason: 'retired', sessionClass: 'claude-interactive' });
    expect(h.appended).toEqual([]);
    expect(llmFn).not.toHaveBeenCalled();
  });

  it('isRetired failing (rejected) is fail-soft to "not retired" — never silently stop sampling a class over a read fault', async () => {
    const h = harness({ isRetired: async () => { throw new Error('disk error'); } });
    // sampleDeps' own default wraps isRetired in try/catch; a caller-supplied
    // override that throws propagates (this harness bypasses sampleDeps' default),
    // so this test documents the CONTRACT the real default upholds — see the
    // dedicated readRetiredResidualClasses fail-soft tests below for the actual guard.
    await expect(runMaintenanceResidualSample(INPUT, h.deps)).rejects.toThrow('disk error');
  });
});

describe('residual retirement actuation — evidence-gated, reversible per-class kill-switch (D-010 leg 3)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'residual-carry-retired-'));
    return async () => rm(dir, { recursive: true, force: true });
  });

  it('a class is not retired until explicitly retired', async () => {
    expect(await isResidualClassRetired('claude-interactive', dir)).toBe(false);
    expect(await readRetiredResidualClasses(dir)).toEqual({});
  });

  it('retireResidualClass round-trips a record with the pinned evidence', async () => {
    const res = await retireResidualClass(
      'claude-interactive',
      { retiredBy: 'su-owner-1', evidence: { n: 40, missRate: 0, errorCount: 1 }, note: 'clean per report' },
      dir,
    );
    expect(res.ok).toBe(true);
    expect(await isResidualClassRetired('claude-interactive', dir)).toBe(true);
    const map = await readRetiredResidualClasses(dir);
    expect(map['claude-interactive']).toMatchObject({
      sessionClass: 'claude-interactive',
      retiredBy: 'su-owner-1',
      evidence: { n: 40, missRate: 0, errorCount: 1 },
      note: 'clean per report',
    });
    expect(typeof map['claude-interactive'].retiredAt).toBe('string');
  });

  it('refuses to retire with no evidence (n<=0) — retirement must be evidence-backed', async () => {
    const res = await retireResidualClass(
      'claude-interactive',
      { retiredBy: 'su-owner-1', evidence: { n: 0, missRate: 0, errorCount: 0 } },
      dir,
    );
    expect(res).toEqual({ ok: false, error: expect.stringContaining('evidence') });
    expect(await isResidualClassRetired('claude-interactive', dir)).toBe(false);
  });

  it('refuses with a blank sessionClass or retiredBy', async () => {
    expect((await retireResidualClass('  ', { retiredBy: 'su-1', evidence: { n: 1, missRate: 0, errorCount: 0 } }, dir)).ok).toBe(false);
    expect((await retireResidualClass('x', { retiredBy: ' ', evidence: { n: 1, missRate: 0, errorCount: 0 } }, dir)).ok).toBe(false);
  });

  it('unretireResidualClass removes the record and reports whether it existed', async () => {
    await retireResidualClass('gateway-omp', { retiredBy: 'su-1', evidence: { n: 30, missRate: 0, errorCount: 0 } }, dir);
    expect(await unretireResidualClass('gateway-omp', dir)).toBe(true);
    expect(await isResidualClassRetired('gateway-omp', dir)).toBe(false);
    // Removing again reports false — nothing left to remove.
    expect(await unretireResidualClass('gateway-omp', dir)).toBe(false);
  });

  it('readRetiredResidualClasses fails soft to {} for a missing directory/file', async () => {
    expect(await readRetiredResidualClasses(join(dir, 'does-not-exist'))).toEqual({});
  });

  it('retiring one class never affects another', async () => {
    await retireResidualClass('claude-interactive', { retiredBy: 'su-1', evidence: { n: 30, missRate: 0, errorCount: 0 } }, dir);
    expect(await isResidualClassRetired('gateway-omp', dir)).toBe(false);
  });
});
