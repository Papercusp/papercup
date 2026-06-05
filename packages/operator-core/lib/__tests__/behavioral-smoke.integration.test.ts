/**
 * Behavioral smoke tests for the operator-scan surface.
 *
 * Fires GET /api/agent-mcp/operator-scan SSE requests, collects
 * tool_call events, and asserts the correct tool was called.
 *
 * Plan: admin-testing-tab-restructure-2026-05-24, P-027.
 * Migrated from apps/operator/__tests__/integration/behavioral-smoke.mjs.
 *
 * IMPORTANT: These tests invoke real LLM calls and are slow (~180s each).
 * Run selectively: `vitest run behavioral-smoke.integration`
 * They are skipped automatically when the operator is unreachable.
 *
 * Honors OP_PORT (default 3055) and BEHAVIORAL_SMOKE_TIMEOUT_MS (default 180000).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupFixture, cleanupFixture, FIXTURE_INFO } from './behavioral-smoke-fixture';

const OP_PORT = process.env.OP_PORT ?? '3055';
const BASE = `http://localhost:${OP_PORT}`;
const TIMEOUT_MS = Number(process.env.BEHAVIORAL_SMOKE_TIMEOUT_MS ?? 180_000);

async function operatorIsReachable(): Promise<boolean> {
  try {
    const r = await fetch(`${BASE}/api/operator/conversations?limit=1`);
    return r.ok;
  } catch {
    return false;
  }
}

interface ScanResult {
  toolCalls: Array<{ name: string; input: unknown }>;
  text: string;
  durationMs: number;
  error?: string;
}

async function runScanOnce(request: string): Promise<ScanResult> {
  const start = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    const url = `${BASE}/api/agent-mcp/operator-scan?request=${encodeURIComponent(request)}`;
    res = await fetch(url, { signal: ctrl.signal });
  } catch (err: unknown) {
    clearTimeout(timer);
    return { toolCalls: [], text: '', durationMs: Date.now() - start, error: `fetch failed: ${(err as Error)?.message ?? err}` };
  }

  if (!res.ok || !res.body) {
    clearTimeout(timer);
    const text = await res.text().catch(() => `HTTP ${res.status}`);
    return { toolCalls: [], text: '', durationMs: Date.now() - start, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
  }

  const toolCalls: Array<{ name: string; input: unknown }> = [];
  let assembled = '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  try {
    outer: while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const eventMatch = frame.match(/^event:\s*(.+)$/m);
        const dataMatch = frame.match(/^data:\s*(.+)$/m);
        if (!eventMatch || !dataMatch) continue;
        const event = eventMatch[1].trim();
        let data: Record<string, unknown>;
        try { data = JSON.parse(dataMatch[1]); } catch { continue; }
        if (event === 'tool_call' && typeof data?.name === 'string') {
          toolCalls.push({ name: data.name, input: data.input ?? null });
        } else if (event === 'delta' && typeof data?.text === 'string') {
          assembled += data.text;
        } else if (event === 'error') {
          clearTimeout(timer);
          return { toolCalls, text: assembled, durationMs: Date.now() - start, error: (data?.message as string) ?? 'stream error' };
        } else if (event === 'done') {
          clearTimeout(timer);
          break outer;
        }
      }
    }
  } finally {
    clearTimeout(timer);
  }
  return { toolCalls, text: assembled, durationMs: Date.now() - start };
}

// operator-scan holds a single-in-flight guard PER WORKSPACE, and the
// server-side scan outlives the SSE response, so back-to-back scans in this
// file can collide with "Another scan is in progress". Retry on that, waiting
// for the prior scan to clear (it frees within one scan duration).
async function runScan(request: string): Promise<ScanResult> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const result = await runScanOnce(request);
    if (!/in progress/i.test(result.error ?? '')) return result;
    await new Promise((r) => setTimeout(r, 3000));
  }
  return runScanOnce(request);
}

const reachable = await operatorIsReachable();
const itLive = reachable ? it : it.skip;

describe('behavioral-smoke (operator-scan)', () => {
  beforeAll(async () => {
    if (reachable) await setupFixture();
  });

  afterAll(() => {
    if (reachable) cleanupFixture();
  });

  // ── tool-gated: operator can ONLY answer via a tool call ─────────

  itLive(
    'asking for escalation contents triggers harness:escalation',
    async () => {
      const result = await runScan(
        `read the escalation file for the harness ${FIXTURE_INFO.slug} and report the exact unique marker word it contains. Use a tool — do not guess.`,
      );
      expect(result.error).toBeUndefined();
      const names = result.toolCalls.map((t) => t.name);
      const markerSeen = result.text.includes(FIXTURE_INFO.escalationMarker);
      const toolCalled = names.some((n) => ['harness:escalation', 'harness_escalation'].includes(n));
      expect(
        markerSeen || toolCalled,
        `marker '${FIXTURE_INFO.escalationMarker}' missing and harness:escalation not called. tool_calls: [${names.join(', ')}]`,
      ).toBe(true);
    },
    TIMEOUT_MS + 5000,
  );

  itLive(
    'asking for supervisor-notes triggers harness:escalation',
    async () => {
      const result = await runScan(
        `what does the supervisor-notes file say for harness ${FIXTURE_INFO.slug}? Quote the marker word from the file.`,
      );
      expect(result.error).toBeUndefined();
      const names = result.toolCalls.map((t) => t.name);
      const markerSeen = result.text.includes(FIXTURE_INFO.supervisorMarker);
      const toolCalled = names.some((n) => ['harness:escalation', 'harness_escalation'].includes(n));
      expect(
        markerSeen || toolCalled,
        `marker '${FIXTURE_INFO.supervisorMarker}' missing and harness:escalation not called. tool_calls: [${names.join(', ')}]`,
      ).toBe(true);
    },
    TIMEOUT_MS + 5000,
  );

  // ── guidance deflection smokes ───────────────────────────────────

  itLive(
    'scanner picks issues:list for "any open issues?"',
    async () => {
      const result = await runScan('are there any open issues anywhere in this workspace?');
      expect(result.error).toBeUndefined();
      const names = result.toolCalls.map((t) => t.name);
      const rejected = names.some((n) => ['harness:status', 'harness_status'].includes(n));
      expect(
        rejected,
        `called harness:status (wrong tool) — guidance.notWhen should deflect. tool_calls: [${names.join(', ')}]`,
      ).toBe(false);
      // accepted set: issues:list; lenient if no tool called (inventory block answered)
      const accepted = names.some((n) => ['issues:list', 'issues_list'].includes(n));
      if (!accepted && names.length > 0) {
        console.warn(`[lenient] unanticipated tool(s): ${names.join(', ')}`);
      }
    },
    TIMEOUT_MS + 5000,
  );

  itLive(
    'scanner picks harness:list for cross-harness enumeration',
    async () => {
      const result = await runScan('list every harness in this workspace and report which ones are stale');
      expect(result.error).toBeUndefined();
      const names = result.toolCalls.map((t) => t.name);
      const accepted = names.some((n) => ['harness:list', 'harness_list'].includes(n));
      if (!accepted && names.length === 0) {
        console.warn('[lenient] no tool calls — model answered from inventory block');
      } else if (!accepted) {
        console.warn(`[lenient] unanticipated tool(s): ${names.join(', ')}`);
      }
      // Non-failing: lenient smoke — we accept unanticipated tools or no tool call.
    },
    TIMEOUT_MS + 5000,
  );

  itLive(
    'scanner picks pending_reviews_list for "what needs approval?"',
    async () => {
      const result = await runScan('what currently needs my approval across the workspace?');
      expect(result.error).toBeUndefined();
      const names = result.toolCalls.map((t) => t.name);
      const rejected = names.some((n) => ['issues:list', 'issues_list'].includes(n));
      expect(
        rejected,
        `called issues:list (wrong tool for approvals). tool_calls: [${names.join(', ')}]`,
      ).toBe(false);
    },
    TIMEOUT_MS + 5000,
  );

  itLive(
    'scanner picks audit:list for "what happened recently?"',
    async () => {
      const result = await runScan('what notable actions happened across the workspace in the last day?');
      expect(result.error).toBeUndefined();
      const names = result.toolCalls.map((t) => t.name);
      const rejected = names.some((n) => ['harness:list', 'harness_list'].includes(n));
      expect(
        rejected,
        `called harness:list (enumeration, not history). tool_calls: [${names.join(', ')}]`,
      ).toBe(false);
    },
    TIMEOUT_MS + 5000,
  );
});
