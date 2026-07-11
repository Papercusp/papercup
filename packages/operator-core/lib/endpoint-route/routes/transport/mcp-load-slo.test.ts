/**
 * P-011 load-test regression gate (mcp-reliability-hardening-2026-07-11) — pin
 * the PURE SLO verdict: p95 over OK requests, a 429 is a graceful shed (never a
 * failure), a hard failure/near-total-shed breaches, and the budget knobs read
 * from env. The live driver (mcp-load-slo.integration.test.ts) only measures;
 * these tests gate the DECISION logic in CI without a live operator.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  percentile,
  classifyHttpOutcome,
  evaluateMcpLoad,
  loadBudgetsFromEnv,
  formatMcpLoadReport,
  intEnv,
  rateEnv,
  type McpLoadBudgets,
  type McpLoadSample,
} from './mcp-load-slo';

const BUDGETS: McpLoadBudgets = { p95Ms: 3000, maxFailRate: 0.02, maxShedRate: 0.8 };

const ok = (latencyMs: number): McpLoadSample => ({ outcome: 'ok', latencyMs });
const shed = (latencyMs = 5): McpLoadSample => ({ outcome: 'shed', latencyMs });
const fail = (latencyMs = 15_000): McpLoadSample => ({ outcome: 'fail', latencyMs });

describe('percentile — nearest-rank, small-N safe', () => {
  it('empty ⇒ 0', () => {
    expect(percentile([], 95)).toBe(0);
  });
  it('single value ⇒ that value at any p', () => {
    expect(percentile([42], 95)).toBe(42);
    expect(percentile([42], 50)).toBe(42);
  });
  it('p95 of 1..100 is 95 (nearest-rank)', () => {
    const xs = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(xs, 95)).toBe(95);
    expect(percentile(xs, 50)).toBe(50);
    expect(percentile(xs, 100)).toBe(100);
  });
  it('clamps rank into [1,N] (p0 ⇒ first, p100 ⇒ last)', () => {
    expect(percentile([10, 20, 30], 0)).toBe(10);
    expect(percentile([10, 20, 30], 100)).toBe(30);
  });
});

describe('classifyHttpOutcome — 429 is a shed, not a fail', () => {
  it('429 ⇒ shed regardless of anything else', () => {
    expect(classifyHttpOutcome(429, false)).toBe('shed');
    expect(classifyHttpOutcome(429, true)).toBe('shed');
  });
  it('clean 2xx with no RPC error ⇒ ok', () => {
    expect(classifyHttpOutcome(200, false)).toBe('ok');
    expect(classifyHttpOutcome(204, false)).toBe('ok');
  });
  it('2xx carrying a JSON-RPC error envelope ⇒ fail', () => {
    expect(classifyHttpOutcome(200, true)).toBe('fail');
  });
  it('5xx / 4xx (non-429) ⇒ fail', () => {
    expect(classifyHttpOutcome(500, false)).toBe('fail');
    expect(classifyHttpOutcome(503, false)).toBe('fail');
    expect(classifyHttpOutcome(400, false)).toBe('fail');
  });
});

describe('evaluateMcpLoad — the verdict', () => {
  it('all-ok within budget ⇒ PASS, p95 measured over ok latencies', () => {
    const samples = Array.from({ length: 100 }, (_, i) => ok(i + 1)); // 1..100ms
    const r = evaluateMcpLoad(samples, BUDGETS);
    expect(r.passed).toBe(true);
    expect(r.ok).toBe(100);
    expect(r.fail).toBe(0);
    expect(r.p95Ms).toBe(95);
    expect(r.breaches).toEqual([]);
  });

  it('a p95 over budget ⇒ FAIL with a p95 breach', () => {
    // 95 fast + 5 slow: nearest-rank p95 lands on the first slow sample.
    const samples = [...Array.from({ length: 95 }, () => ok(100)), ...Array.from({ length: 5 }, () => ok(9000))];
    const r = evaluateMcpLoad(samples, BUDGETS);
    expect(r.passed).toBe(false);
    expect(r.p95Ms).toBe(9000);
    expect(r.breaches.some((b) => b.startsWith('p95'))).toBe(true);
  });

  it('hard failures over the fail-rate budget ⇒ FAIL', () => {
    // 96 ok + 4 fail = 4% > 2% budget.
    const samples = [...Array.from({ length: 96 }, () => ok(50)), fail(), fail(), fail(), fail()];
    const r = evaluateMcpLoad(samples, BUDGETS);
    expect(r.passed).toBe(false);
    expect(r.fail).toBe(4);
    expect(r.failRate).toBeCloseTo(0.04, 5);
    expect(r.breaches.some((b) => b.startsWith('fail-rate'))).toBe(true);
  });

  it('sheds (429s) do NOT count as failures and do NOT breach at a moderate rate', () => {
    // 60 ok + 40 shed: shedRate 0.40 < 0.80 budget, 0 failures ⇒ PASS.
    const samples = [...Array.from({ length: 60 }, () => ok(80)), ...Array.from({ length: 40 }, () => shed())];
    const r = evaluateMcpLoad(samples, BUDGETS);
    expect(r.passed).toBe(true);
    expect(r.shed).toBe(40);
    expect(r.fail).toBe(0);
    expect(r.p95Ms).toBe(80); // p95 measured over the 60 ok only
  });

  it('a NEAR-TOTAL shed (served almost nothing) ⇒ FAIL on the shed-rate guard', () => {
    // 5 ok + 95 shed: shedRate 0.95 > 0.80 ⇒ breach, even with zero hard failures.
    const samples = [...Array.from({ length: 5 }, () => ok(80)), ...Array.from({ length: 95 }, () => shed())];
    const r = evaluateMcpLoad(samples, BUDGETS);
    expect(r.passed).toBe(false);
    expect(r.breaches.some((b) => b.startsWith('shed-rate'))).toBe(true);
  });

  it('zero samples ⇒ FAIL (no-requests), never a vacuous pass', () => {
    const r = evaluateMcpLoad([], BUDGETS);
    expect(r.passed).toBe(false);
    expect(r.breaches.some((b) => b.startsWith('no-requests'))).toBe(true);
  });

  it('does NOT assert a p95 breach when there are no OK samples (all shed/fail already breach)', () => {
    const samples = [...Array.from({ length: 100 }, () => shed())];
    const r = evaluateMcpLoad(samples, BUDGETS);
    expect(r.breaches.some((b) => b.startsWith('p95'))).toBe(false); // p95 unmeasurable ⇒ not asserted
    expect(r.breaches.some((b) => b.startsWith('shed-rate'))).toBe(true); // caught by shed guard instead
  });
});

describe('formatMcpLoadReport — a readable one-liner', () => {
  it('renders PASS with the p50/p95 and no breaches', () => {
    const r = evaluateMcpLoad(Array.from({ length: 10 }, () => ok(100)), BUDGETS);
    const line = formatMcpLoadReport(r, BUDGETS);
    expect(line).toContain('PASS');
    expect(line).toContain('p95=100ms');
    expect(line).not.toContain('breaches');
  });
  it('renders FAIL with the breach list', () => {
    const r = evaluateMcpLoad([ok(50), fail(), fail(), fail()], BUDGETS);
    const line = formatMcpLoadReport(r, BUDGETS);
    expect(line).toContain('FAIL');
    expect(line).toContain('breaches:');
  });
});

describe('env budget parsing', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('intEnv floors + truncates, falls back on garbage', () => {
    process.env.X_INT = '2500.9';
    expect(intEnv('X_INT', 3000, 1)).toBe(2500);
    process.env.X_INT = 'nonsense';
    expect(intEnv('X_INT', 3000, 1)).toBe(3000);
    process.env.X_INT = '0';
    expect(intEnv('X_INT', 3000, 1)).toBe(1); // floored to min
    delete process.env.X_INT;
    expect(intEnv('X_INT', 3000, 1)).toBe(3000);
  });

  it('rateEnv clamps to [0,1], falls back on garbage', () => {
    process.env.X_RATE = '0.05';
    expect(rateEnv('X_RATE', 0.02)).toBeCloseTo(0.05, 5);
    process.env.X_RATE = '5';
    expect(rateEnv('X_RATE', 0.02)).toBe(1);
    process.env.X_RATE = '-1';
    expect(rateEnv('X_RATE', 0.02)).toBe(0);
    process.env.X_RATE = 'nope';
    expect(rateEnv('X_RATE', 0.02)).toBe(0.02);
  });

  it('loadBudgetsFromEnv wires all three knobs', () => {
    process.env.PAPERCUSP_MCP_LOAD_P95_MS = '1500';
    process.env.PAPERCUSP_MCP_LOAD_MAX_FAIL_RATE = '0.05';
    process.env.PAPERCUSP_MCP_LOAD_MAX_SHED_RATE = '0.5';
    expect(loadBudgetsFromEnv()).toEqual({ p95Ms: 1500, maxFailRate: 0.05, maxShedRate: 0.5 });
  });

  it('loadBudgetsFromEnv defaults when unset', () => {
    delete process.env.PAPERCUSP_MCP_LOAD_P95_MS;
    delete process.env.PAPERCUSP_MCP_LOAD_MAX_FAIL_RATE;
    delete process.env.PAPERCUSP_MCP_LOAD_MAX_SHED_RATE;
    expect(loadBudgetsFromEnv()).toEqual({ p95Ms: 3000, maxFailRate: 0.02, maxShedRate: 0.8 });
  });
});
