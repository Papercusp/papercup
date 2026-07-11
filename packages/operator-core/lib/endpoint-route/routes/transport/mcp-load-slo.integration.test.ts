/**
 * P-011 load-test regression GATE (mcp-reliability-hardening-2026-07-11).
 *
 * Drives N CONCURRENT agents through the REAL `/api/mcp` HTTP transport and
 * asserts a p95-latency + success-rate SLO — the end-to-end regression gate for
 * the whole hardening plan (P-001..P-010 made the transport resilient; this pins
 * that it STAYS resilient under concurrent fleet-shaped load).
 *
 * Shape (mirrors su-locks-http-mcp.integration.test.ts — the established
 * real-HTTP-MCP e2e pattern):
 *   • reads the superuser bearer from ~/.papercusp/superuser-token;
 *   • `all_workspaces=1` opts out of the scoped-superuser-workspace clamp
 *     (the throwaway per-worker client ids have no registered workspace);
 *   • `format=json` so a 2xx envelope JSON-parses (result-format default is
 *     `compact`/TOON);
 *   • **skips cleanly when the operator is unreachable** — a load gate must NOT
 *     red CI for a missing server; it RUNS as a real gate wherever :3070/:3170
 *     (or OPERATOR_BASE_URL) is up, and is what a load host / release check runs.
 *
 * The per-request → verdict math lives in the PURE, always-unit-tested sibling
 * mcp-load-slo.ts (mcp-load-slo.test.ts gates it in CI with no server). A 429 is
 * a GRACEFUL shed (P-010 admission control), never a failure; only hard failures
 * (5xx / transport error / RPC error envelope) and a near-total shed breach.
 *
 * Tunables (env, all optional):
 *   PAPERCUSP_MCP_LOAD_CONCURRENCY   (default 24)   — concurrent workers
 *   PAPERCUSP_MCP_LOAD_REQUESTS      (default 240)  — total requests
 *   PAPERCUSP_MCP_LOAD_REQ_TIMEOUT_MS(default 15000)— per-request timeout
 *   PAPERCUSP_MCP_LOAD_TOOL          (default locks:queue) — the representative read
 *   PAPERCUSP_MCP_LOAD_P95_MS        (default 3000) — p95 budget      } SLO
 *   PAPERCUSP_MCP_LOAD_MAX_FAIL_RATE (default 0.02) — hard-fail budget } (see
 *   PAPERCUSP_MCP_LOAD_MAX_SHED_RATE (default 0.80) — near-total-shed  } mcp-load-slo.ts)
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  classifyHttpOutcome,
  evaluateMcpLoad,
  formatMcpLoadReport,
  loadBudgetsFromEnv,
  intEnv,
  type McpLoadSample,
} from './mcp-load-slo';

const OP_PORT = process.env.OP_PORT ?? null;
const BASE = OP_PORT
  ? `http://localhost:${OP_PORT}`
  : (process.env.OPERATOR_BASE_URL ?? 'http://localhost:3070');

const CONCURRENCY = intEnv('PAPERCUSP_MCP_LOAD_CONCURRENCY', 24, 1);
const REQUESTS = intEnv('PAPERCUSP_MCP_LOAD_REQUESTS', 240, 1);
const REQ_TIMEOUT_MS = intEnv('PAPERCUSP_MCP_LOAD_REQ_TIMEOUT_MS', 15_000, 100);
const TOOL = process.env.PAPERCUSP_MCP_LOAD_TOOL ?? 'locks:queue';
// Give the whole batch a generous ceiling: waves × worst-case per request + warmup.
const TEST_TIMEOUT = intEnv(
  'PAPERCUSP_MCP_LOAD_TEST_TIMEOUT_MS',
  Math.min(300_000, Math.ceil(REQUESTS / CONCURRENCY) * REQ_TIMEOUT_MS + 30_000),
  10_000,
);

const RUN_ID = `${process.pid}-${Date.now()}`;

let TOKEN = '';
let reachable = false;
try {
  TOKEN = readFileSync(join(homedir(), '.papercusp', 'superuser-token'), 'utf8').trim();
  // Probe with tools/list — a cheap, NON-sheddable method (admission control only
  // sheds tools/call), so reachability never depends on current loop pressure.
  const probe = await fetch(`${BASE}/api/mcp?superuser=1&all_workspaces=1`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'tools/list', params: {} }),
    signal: AbortSignal.timeout(4000),
  });
  reachable = probe.status < 500;
} catch {
  /* operator not running — the gate skips */
}

const itLive = reachable ? it : it.skip;

/** Args for the representative read. locks:queue is side-effect-free (a light PG
 *  read that returns active_locks for a never-held path). A custom TOOL gets no args. */
function toolArgs(i: number): Record<string, unknown> {
  if (TOOL === 'locks:queue') return { paths: [`mcp-load/${RUN_ID}/${i}.ts`] };
  return {};
}

/** Does a 2xx MCP SSE/JSON body carry a JSON-RPC error (or an isError result)? */
function envelopeHasError(raw: string): boolean {
  const dataLine = raw.split('\n').find((l) => l.startsWith('data:'));
  const jsonText = dataLine ? dataLine.slice('data:'.length).trim() : raw.trim();
  try {
    const env = JSON.parse(jsonText) as { error?: unknown; result?: { isError?: boolean } };
    return env.error != null || env.result?.isError === true;
  } catch {
    return false; // unparseable 2xx body → don't manufacture a failure
  }
}

/** Fire one tools/call and classify + time it. Never throws. */
async function oneCall(client: string, i: number): Promise<McpLoadSample> {
  const url = `${BASE}/api/mcp?superuser=1&all_workspaces=1&format=json&client=${encodeURIComponent(client)}`;
  const body = JSON.stringify({
    jsonrpc: '2.0', id: i, method: 'tools/call',
    params: { name: TOOL, arguments: toolArgs(i) },
  });
  const t0 = performance.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body,
      signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
    });
    const raw = await res.text();
    const latencyMs = performance.now() - t0;
    const rpcError = res.status >= 200 && res.status < 300 ? envelopeHasError(raw) : false;
    return { outcome: classifyHttpOutcome(res.status, rpcError), latencyMs };
  } catch {
    // Timeout / abort / network reset — a hard failure (the request never completed).
    return { outcome: 'fail', latencyMs: performance.now() - t0 };
  }
}

/** Worker-pool load: CONCURRENCY workers each pull from a shared counter until
 *  REQUESTS are exhausted. `next++` is atomic between awaits (single-threaded JS),
 *  so no request is dropped or double-issued. */
async function runLoad(): Promise<McpLoadSample[]> {
  const samples: McpLoadSample[] = [];
  let next = 0;
  async function worker(workerId: number) {
    const client = `mcp-load-${RUN_ID}-w${workerId}`;
    for (;;) {
      const i = next++;
      if (i >= REQUESTS) return;
      samples.push(await oneCall(client, i));
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, (_, w) => worker(w)));
  return samples;
}

describe('MCP /api/mcp load SLO gate (P-011 — mcp-reliability-hardening)', () => {
  itLive(
    `${CONCURRENCY} concurrent agents × ${REQUESTS} reqs stay within the p95 + success-rate SLO`,
    async () => {
      const budgets = loadBudgetsFromEnv();

      // Warm-up: prime connections + tool-dispatch caches so p95 reflects
      // steady-state, not one-time cold-start cost. Discarded.
      const warmup = Math.min(CONCURRENCY, 8);
      await Promise.all(Array.from({ length: warmup }, (_, w) => oneCall(`mcp-load-${RUN_ID}-warm${w}`, -1 - w)));

      const samples = await runLoad();
      const report = evaluateMcpLoad(samples, budgets);

      // eslint-disable-next-line no-console
      console.log(formatMcpLoadReport(report, budgets));

      // The gate: no hard-failure/near-total-shed breach, and p95 within budget.
      expect(report.passed, formatMcpLoadReport(report, budgets)).toBe(true);
      // Sanity: we actually drove the intended load (guards a silent zero-sample pass path).
      expect(report.total).toBe(REQUESTS);
    },
    TEST_TIMEOUT,
  );
});
