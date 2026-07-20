// Sync-read audit recurrence guard (precompute-sync-reads-phase2 P-008).
//
// HERMETIC — enumerate the registry, auto-detect arg-requiring queries via their
// argsSchema, and FAIL when a fixture is missing or the allowlist rots. NO
// resolver invocation (an older invoke-every-entry breadth test repeatedly blew
// the green gate under load — getRegistryEntryV2 note in index.ts); the live
// payload/latency budget runs on demand via measureSyncReadPayloadsViaRest
// against a running operator, not here.

import { describe, it, expect } from 'vitest';
import { knownQueryNamesV2, getRegistryEntryV2, isRegisteredV2 } from './index';
import {
  SYNC_QUERY_FIXTURES,
  SYNC_READ_ALLOWLIST,
  PAYLOAD_BUDGET_BYTES,
  LATENCY_BUDGET_MS,
  queryRequiresArgs,
  evaluateBudget,
  measureSyncReadPayloadsViaRest,
} from './sync-read-audit';

describe('sync-read audit — registry coverage guard (P-008)', () => {
  const names = knownQueryNamesV2();

  it('the registry is non-trivial (sanity: many queries registered)', () => {
    expect(names.length).toBeGreaterThan(100);
  });

  it('EVERY arg-requiring query has a fixtures entry (extend SYNC_QUERY_FIXTURES, do not work around)', () => {
    const missing: string[] = [];
    for (const name of names) {
      const entry = getRegistryEntryV2(name) as { argsSchema?: { safeParse?: (v: unknown) => { success: boolean } } } | undefined;
      if (!queryRequiresArgs(entry)) continue; // resolves with {} → no fixture needed
      if (!Object.prototype.hasOwnProperty.call(SYNC_QUERY_FIXTURES, name)) missing.push(name);
    }
    expect(
      missing,
      `These arg-REQUIRING sync queries have no fixture — the audit cannot measure them.\n` +
        `Add representative args to SYNC_QUERY_FIXTURES in sync-read-audit.ts (or null if it needs a\n` +
        `per-run id that has no stable fixture):\n  ${missing.join('\n  ')}`,
    ).toEqual([]);
  });

  it('no fixture entry names an UNREGISTERED query (fixtures cannot drift ahead of the registry)', () => {
    const stale = Object.keys(SYNC_QUERY_FIXTURES).filter((n) => !isRegisteredV2(n));
    expect(stale, `SYNC_QUERY_FIXTURES names queries no longer in the registry: ${stale.join(', ')}`).toEqual([]);
  });
});

describe('sync-read audit — allowlist hygiene (P-008)', () => {
  it('every allowlist entry names a REAL registered query, with a reason + reviewBy', () => {
    for (const [name, entry] of Object.entries(SYNC_READ_ALLOWLIST)) {
      expect(isRegisteredV2(name), `allowlisted query ${name} is not registered`).toBe(true);
      expect(entry.reason.length, `allowlist ${name} needs a non-empty reason`).toBeGreaterThan(20);
      expect(entry.reviewBy, `allowlist ${name} needs a reviewBy date`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(entry.maxBytes ?? entry.maxMs, `allowlist ${name} must raise at least one ceiling`).toBeDefined();
    }
  });

  it('an allowlist ceiling is always ABOVE the default budget (else it is pointless)', () => {
    for (const [name, entry] of Object.entries(SYNC_READ_ALLOWLIST)) {
      if (entry.maxBytes != null) expect(entry.maxBytes, name).toBeGreaterThan(PAYLOAD_BUDGET_BYTES);
      if (entry.maxMs != null) expect(entry.maxMs, name).toBeGreaterThan(LATENCY_BUDGET_MS);
    }
  });
});

describe('sync-read audit — budget evaluation', () => {
  it('flags a non-allowlisted query over either ceiling', () => {
    expect(evaluateBudget('some.unknownQuery', PAYLOAD_BUDGET_BYTES + 1, 10)).toEqual({ overBudget: true, allowlisted: false });
    expect(evaluateBudget('some.unknownQuery', 10, LATENCY_BUDGET_MS + 1)).toEqual({ overBudget: true, allowlisted: false });
    expect(evaluateBudget('some.unknownQuery', 10, 10)).toEqual({ overBudget: false, allowlisted: false });
  });

  it('an allowlisted query is judged against its RAISED ceiling', () => {
    // agentRunsConsolidated.bySlug is allowlisted to 1.1MB — 1.0MB is fine, 1.2MB is over.
    expect(evaluateBudget('agentRunsConsolidated.bySlug', 1_000_000, 10).overBudget).toBe(false);
    expect(evaluateBudget('agentRunsConsolidated.bySlug', 1_200_000, 10).overBudget).toBe(true);
    expect(evaluateBudget('agentRunsConsolidated.bySlug', 1_000_000, 10).allowlisted).toBe(true);
  });
});

describe('sync-read audit — measureSyncReadPayloadsViaRest (harness logic, fake fetch)', () => {
  it('ranks by bytes desc, flags non-allowlisted violations, skips null fixtures', async () => {
    // Fake operator: featuresConsolidated.bySlug small (ok), a synthetic fat query
    // over budget (violation), agentRunsConsolidated.bySlug fat-but-allowlisted.
    const bodies: Record<string, string> = {
      'featuresConsolidated.bySlug': JSON.stringify({ rows: [{ a: 1 }, { a: 2 }] }),
      'agentRunsConsolidated.bySlug': JSON.stringify({ rows: Array.from({ length: 10 }, () => ({ x: 'y'.repeat(60_000) })) }), // ~600KB, allowlisted <1.1MB
      'workItems.stats': 'X'.repeat(PAYLOAD_BUDGET_BYTES + 5000), // over budget, NOT allowlisted → violation
    };
    const fakeFetch = (async (url: string) => {
      const name = new URL(url).searchParams.get('name')!;
      const body = bodies[name] ?? '{"rows":[]}';
      return { ok: true, status: 200, text: async () => body } as Response;
    }) as unknown as typeof fetch;

    const report = await measureSyncReadPayloadsViaRest({
      baseUrl: 'http://x',
      token: 't',
      queryNames: ['featuresConsolidated.bySlug', 'agentRunsConsolidated.bySlug', 'workItems.stats', 'workItems.detail'],
      fetchImpl: fakeFetch,
    });

    // workItems.detail has a null fixture → skipped, never fetched.
    expect(report.skipped).toContain('workItems.detail');
    // sorted by bytes desc → the fat allowlisted run list first.
    expect(report.measured[0].name).toBe('agentRunsConsolidated.bySlug');
    // the only non-allowlisted over-budget read is workItems.stats.
    expect(report.violations.map((v) => v.name)).toEqual(['workItems.stats']);
    // the allowlisted fat query is measured but NOT a violation.
    const runs = report.measured.find((m) => m.name === 'agentRunsConsolidated.bySlug')!;
    expect(runs.allowlisted).toBe(true);
    expect(runs.overBudget).toBe(false);
    expect(runs.rows).toBe(10);
  });

  it('records a non-OK HTTP response as an error, not a false pass', async () => {
    const fakeFetch = (async () => ({ ok: false, status: 500, text: async () => 'boom' }) as Response) as unknown as typeof fetch;
    const report = await measureSyncReadPayloadsViaRest({
      baseUrl: 'http://x',
      token: 't',
      queryNames: ['workItems.stats'],
      fetchImpl: fakeFetch,
    });
    expect(report.measured[0].error).toBe('HTTP 500');
    expect(report.violations).toEqual([]);
  });
});
