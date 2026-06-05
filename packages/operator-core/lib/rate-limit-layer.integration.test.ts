/**
 * rate-limit-layer.integration.test.ts — the rate-limit layer's PG surfaces against real
 * Postgres (rate-limit-layer-v2-2026-06-05, P-008 / P-014 / P-020).
 *
 * Covers, against the full migrated schema (migration 161):
 *   - usage telemetry (D-002): recordUsageSample / recordUsageHeaders round-trip +
 *     summarizeUsage computes usage% ONLY where a provider ceiling is known;
 *   - live fleet config (D-004/D-005): writeRateLimitConfig persists + clamps + publishes
 *     on the bus + pushes cap/floor into the REAL governor global gate (no restart);
 *   - operator-rate-limit jsonb encoding (D-007): the `::text::jsonb` payload round-trips
 *     through the real postgres-js driver (the double-encode bug a PG mock cannot catch).
 *
 * Follows the org-fixture mock pattern (test/_org-test-db.ts): runtime modules route
 * through `getOrgPg().sql`; we point that at the fixture's admin (RLS-bypass) client and
 * mock the workspace resolver.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import type { OrgTestDb } from '../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: null as unknown, ws: 'ws-rate-limit-test' }));

vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('./workspace-registry', () => ({ activeWorkspaceId: () => h.ws }));

// Imported AFTER the mocks are declared (vi.mock is hoisted above imports).
const { recordUsageSample, recordUsageHeaders, summarizeUsage } = await import('./agent-usage-telemetry');
const {
  readRateLimitConfig,
  writeRateLimitConfig,
  getRateLimitBus,
  __resetRateLimitConfigForTest,
} = await import('./rate-limit-config');
const { record503, recordSuccess } = await import('./operator-rate-limit');
const { globalConcurrencySnapshot, effectiveConcurrencySnapshot } = await import(
  '@papercusp/papercup-shared/agent'
);
const { createOrgTestDb } = await import('../test/_org-test-db');

describe('rate-limit layer (real PG)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;
  }, 120_000);

  afterAll(async () => {
    __resetRateLimitConfigForTest();
    await db?.cleanup();
  });

  // --- P-008: usage telemetry round-trip (D-002) ---------------------------------------------
  it('round-trips usage samples and aggregates; usage% only where a ceiling is known', async () => {
    await recordUsageSample({
      bucketKey: 'anthropic:opus',
      provider: 'anthropic',
      modelClass: 'opus',
      source: 'headers',
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.01,
      rlTokensLimit: 100_000,
      rlTokensRemaining: 75_000,
      rlResetAt: Date.now() + 60_000,
    });
    await recordUsageSample({
      bucketKey: 'anthropic:opus',
      provider: 'anthropic',
      modelClass: 'opus',
      source: 'jsonl',
      inputTokens: 200,
      outputTokens: 80,
      cacheReadTokens: 1_000,
      costUsd: 0.02,
    });
    // A subscription-style bucket: tokens visible, NO ceiling → usagePct must stay null.
    await recordUsageSample({
      bucketKey: 'unknown:self',
      provider: 'unknown',
      modelClass: 'self',
      source: 'jsonl',
      inputTokens: 10,
      outputTokens: 5,
    });

    const s = await summarizeUsage(60 * 60 * 1000);
    expect(s.calls).toBe(3);
    expect(s.inputTokens).toBe(310);
    expect(s.outputTokens).toBe(135);
    expect(s.cacheReadTokens).toBe(1_000);
    expect(s.spendUsd).toBeCloseTo(0.03, 6);

    const opus = s.buckets.find((b) => b.key === 'anthropic:opus');
    expect(opus).toBeDefined();
    expect(opus!.calls).toBe(2);
    expect(opus!.usagePct).toBeCloseTo(25, 5); // (1 - 75000/100000) × 100, from the header sample
    expect(opus!.rlResetAt).not.toBeNull();

    const self = s.buckets.find((b) => b.key === 'unknown:self');
    expect(self).toBeDefined();
    expect(self!.usagePct).toBeNull(); // graceful fallback — never a fabricated percentage
  });

  // --- cross-backend-cost-capture P-006/verify: the Overview $spend rollup reflects ALL
  //     three CLIs, and codex (tokens-only) cost is estimated + labeled. -------------------
  it('summarizeUsage rolls up spend across claude (provider) + omp (provider) + codex (estimated)', async () => {
    const ws = 'ws-xbackend-spend';
    const prevWs = h.ws;
    h.ws = ws;
    try {
      // claude — provider-reported cost
      await recordUsageSample({
        bucketKey: 'anthropic:opus', provider: 'anthropic', modelClass: 'opus', source: 'jsonl',
        inputTokens: 1000, outputTokens: 200, costUsd: 0.05,
        model: 'claude-opus-4-8', costSource: 'provider', harnessSlug: 'h1', runId: 'r1', role: 'worker',
      });
      // omp — provider-reported cost.total
      await recordUsageSample({
        bucketKey: 'unknown:self', provider: 'unknown', modelClass: 'self', source: 'jsonl',
        inputTokens: 500, outputTokens: 100, costUsd: 0.01,
        model: 'claude-opus-4-8', costSource: 'provider', harnessSlug: 'h1', runId: 'r2', role: 'scoper',
      });
      // codex — NO costUsd, but a known model → recordUsageSample prices it (estimated).
      // 1M uncached in × $2.5 + 100k out × $20 per MTok = 2.5 + 2.0 = 4.5
      await recordUsageSample({
        bucketKey: 'openai:default', provider: 'openai', modelClass: 'default', source: 'jsonl',
        inputTokens: 1_000_000, outputTokens: 100_000,
        model: 'gpt-5.5', harnessSlug: 'h1', runId: 'r3', role: 'validator',
      });

      const s = await summarizeUsage(60 * 60 * 1000);
      // total spend = 0.05 + 0.01 + 4.5 — all three backends contribute
      expect(s.spendUsd).toBeCloseTo(4.56, 6);
      expect(s.calls).toBe(3);

      // codex row persisted the estimated cost + label
      const rows = await (h.sql as (parts: TemplateStringsArray, ...vals: unknown[]) => Promise<Array<{ cost_usd: number | null; cost_source: string | null; model: string | null; harness_slug: string | null }>>)`
        SELECT cost_usd, cost_source, model, harness_slug
          FROM harness_shared.agent_usage_samples
         WHERE workspace_id = ${ws} AND run_id = 'r3'
      `;
      expect(rows).toHaveLength(1);
      expect(Number(rows[0].cost_usd)).toBeCloseTo(4.5, 6);
      expect(rows[0].cost_source).toBe('estimated');
      expect(rows[0].model).toBe('gpt-5.5');
      expect(rows[0].harness_slug).toBe('h1');
    } finally {
      h.ws = prevWs;
    }
  });

  it('recordUsageHeaders skips a wholly-empty sample and persists a header-bearing one', async () => {
    await recordUsageHeaders('anthropic:sonnet', 'anthropic', 'sonnet', {}); // nothing useful → no row
    await recordUsageHeaders('anthropic:sonnet', 'anthropic', 'sonnet', {
      'anthropic-ratelimit-tokens-limit': '1000',
      'anthropic-ratelimit-tokens-remaining': '400',
      'anthropic-ratelimit-tokens-reset': new Date(Date.now() + 30_000).toISOString(),
    });
    const s = await summarizeUsage(60 * 60 * 1000);
    const sonnet = s.buckets.find((b) => b.key === 'anthropic:sonnet');
    expect(sonnet).toBeDefined();
    expect(sonnet!.calls).toBe(1); // the empty call wrote nothing
    expect(sonnet!.usagePct).toBeCloseTo(60, 5);
  });

  // --- P-014: live config persist + clamp + bus + real governor gate (D-004/D-005) ------------
  it('writeRateLimitConfig persists, clamps, and round-trips through PG', async () => {
    const w = await writeRateLimitConfig({ maxSimultaneousAgents: 5, concurrencyFloor: 99 });
    expect(w).toEqual({ maxSimultaneousAgents: 5, concurrencyFloor: 5 }); // floor clamps to max
    expect(await readRateLimitConfig()).toEqual(w);
  });

  it('a write pushes cap+floor into the live governor gate and publishes on the bus', async () => {
    let seen: { config: { maxSimultaneousAgents: number } } | undefined;
    const off = getRateLimitBus().onPublish(({ event }) => {
      seen = event;
    });
    try {
      await writeRateLimitConfig({ maxSimultaneousAgents: 3, concurrencyFloor: 2 });
      expect(globalConcurrencySnapshot().cap).toBe(3); // the REAL registry gate, no restart
      const eff = effectiveConcurrencySnapshot();
      expect(eff.effective).toBe(3);
      expect(eff.floor).toBe(2);
      expect(seen?.config.maxSimultaneousAgents).toBe(3);
    } finally {
      off?.();
      __resetRateLimitConfigForTest();
    }
  });

  // --- P-020: operator-rate-limit ::text::jsonb round-trip (D-007) ----------------------------
  it('operator_rate_limit payload survives a real-driver round-trip (no double-encode)', async () => {
    const ws = 'ws-jsonb-roundtrip';
    const readPayload = async () => {
      const rows = await (db.adminSql as unknown as (
        s: TemplateStringsArray,
        ...v: unknown[]
      ) => Promise<Array<{ payload: { consecutive503: number; breakerUntilMs: number } }>>)`
        SELECT payload FROM harness_shared.operator_rate_limit WHERE workspace_id = ${ws}
      `;
      return rows[0]?.payload;
    };
    await record503(ws);
    await record503(ws);
    // A double-encoded payload would come back as a STRING (or read as defaults) — assert the
    // driver returns a real object with the mutated counter.
    const p2 = await readPayload();
    expect(typeof p2).toBe('object');
    expect(p2!.consecutive503).toBe(2);
    for (let i = 0; i < 3; i++) await record503(ws);
    expect((await readPayload())!.breakerUntilMs).toBeGreaterThan(0); // breaker at 5 consecutive
    await recordSuccess(ws);
    expect((await readPayload())!.consecutive503).toBe(0);
  });
});
