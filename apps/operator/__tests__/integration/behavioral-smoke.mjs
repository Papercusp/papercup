#!/usr/bin/env node
/**
 * Behavioral smoke tests for the tool-guidance arc (Phase 1d acceptance).
 *
 * Targets the **operator-scan** surface — the proactive scanner whose
 * job is to investigate via MCP tools and emit suggestion cards.
 *
 * FINDING (from first runs, 2026-05-11): tool-call frequency is NOT a
 * reliable signal that guidance is working on these surfaces. Both
 * operator-converse AND operator-scan inject a pre-computed workspace
 * inventory block (harness list, recent activity, agent rolodex) into
 * their system prompts. For common questions like "what harnesses do
 * I have?", the brain answers from that block WITHOUT calling tools.
 * That's the intended optimization — it saves round-trips and keeps
 * the operator snappy.
 *
 * What that means for behavioral testing:
 *   1. Tool-call assertions only work for questions that NEED data
 *      beyond the inventory block (specific feature bodies, full audit
 *      details, escalation contents, etc.).
 *   2. The cleaner Phase 1d signal is the prompt-assembly shape tests
 *      in lib/prompt-assembly-shape.test.ts — they verify that the
 *      guidance reaches the prompt text. Whether the LLM uses it is
 *      then a fuzzy human-judgment thing.
 *   3. A future improvement: a fixture harness that DOES have known
 *      escalations / specific failing features the brain can ONLY
 *      access via tools. Then "did it call escalations:get?" is a
 *      reliable signal.
 *
 * Each smoke below fires a scan request through GET /api/agent-mcp/operator-scan,
 * accumulates SSE tool_call events, and asserts a specific tool was
 * called. Tests are LENIENT (accept multiple plausible tools, reject
 * only the specific wrong-pick the guidance deflects). When no tool
 * is called, the test notes the case rather than failing — the brain
 * may have answered from the inventory block.
 *
 * Costs real LLM calls. Honors OP_PORT (defaults 3055) and
 * BEHAVIORAL_SMOKE_TIMEOUT_MS (defaults 180000).
 *
 * Run: node apps/operator/__tests__/integration/behavioral-smoke.mjs
 */

const OP_PORT = process.env.OP_PORT ?? '3055';
const BASE = `http://localhost:${OP_PORT}`;
const TIMEOUT_MS = Number(process.env.BEHAVIORAL_SMOKE_TIMEOUT_MS ?? 180000);

let pass = 0, fail = 0, skip = 0;
const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };
const bad = (n, d = '') => { console.log(`  ✗ ${n}  ${d}`); fail++; };
const note = (n) => { console.log(`  ⚠ ${n}`); skip++; };

/**
 * Fire a scan request through operator-scan (SSE GET) and collect
 * tool_call events. Returns { toolCalls, text, durationMs, error? }.
 */
async function runScan({ request }) {
  const start = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res;
  try {
    const url = `${BASE}/api/agent-mcp/operator-scan?request=${encodeURIComponent(request)}`;
    res = await fetch(url, { signal: ctrl.signal });
  } catch (err) {
    clearTimeout(timer);
    return { error: `fetch failed: ${err?.message ?? err}` };
  }

  if (!res.ok || !res.body) {
    clearTimeout(timer);
    const text = await res.text().catch(() => `HTTP ${res.status}`);
    return { error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
  }

  const toolCalls = [];
  let assembled = '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const eventMatch = frame.match(/^event:\s*(.+)$/m);
        const dataMatch = frame.match(/^data:\s*(.+)$/m);
        if (!eventMatch || !dataMatch) continue;
        const event = eventMatch[1].trim();
        let data;
        try { data = JSON.parse(dataMatch[1]); } catch { continue; }
        if (event === 'tool_call' && data?.name) {
          toolCalls.push({ name: data.name, input: data.input ?? null });
        } else if (event === 'delta' && typeof data?.text === 'string') {
          assembled += data.text;
        } else if (event === 'error') {
          clearTimeout(timer);
          return { error: data?.message ?? 'stream error' };
        } else if (event === 'done') {
          clearTimeout(timer);
          return { toolCalls, text: assembled, durationMs: Date.now() - start };
        }
      }
    }
  } finally {
    clearTimeout(timer);
  }
  return { toolCalls, text: assembled, durationMs: Date.now() - start };
}

async function operatorIsReachable() {
  try {
    const r = await fetch(`${BASE}/api/operator/conversations?limit=1`);
    return r.ok;
  } catch {
    return false;
  }
}

const SMOKES = [
  {
    name: 'scanner picks issues:list for "any open issues?"',
    request: 'are there any open issues anywhere in this workspace?',
    accept: ['issues:list', 'issues_list'],
    reject: ['harness:status', 'harness_status'],
    rejectReason: 'harness:status is for live phase/counts, not problems — guidance.notWhen should deflect',
  },
  {
    name: 'scanner picks harness:list for cross-harness enumeration',
    request: 'list every harness in this workspace and report which ones are stale',
    accept: ['harness:list', 'harness_list'],
    reject: [],
    rejectReason: '',
  },
  {
    name: 'scanner picks pending_reviews_list for "what needs approval?"',
    request: 'what currently needs my approval across the workspace?',
    accept: [
      'harness:pending_reviews', 'harness_pending_reviews',
      'pending_reviews_list', 'pending_reviews:list',
    ],
    reject: ['issues:list', 'issues_list'],
    rejectReason: 'issues:list is for open bugs; approvals have their own dedicated tool',
  },
  {
    name: 'scanner picks audit:list for "what happened recently?"',
    request: 'what notable actions happened across the workspace in the last day?',
    accept: ['audit:list', 'audit_list', 'cross_harness:recent_activity', 'cross_harness_recent_activity'],
    reject: ['harness:list', 'harness_list'],
    rejectReason: 'harness:list is enumeration, not history',
  },
];

async function main() {
  if (!(await operatorIsReachable())) {
    note(`operator at ${BASE} not reachable — skipping behavioral smokes`);
    console.log(`\nResult: ${pass} passed, ${fail} failed, ${skip} skipped`);
    return process.exit(skip > 0 ? 0 : 1);
  }
  console.log(`Behavioral smoke — ${SMOKES.length} cases, ${TIMEOUT_MS}ms each`);
  console.log('');

  for (const smoke of SMOKES) {
    console.log(`--- ${smoke.name} ---`);
    console.log(`  request: "${smoke.request}"`);
    const result = await runScan({ request: smoke.request });
    if (result.error) {
      bad(smoke.name, `→ ${result.error}`);
      continue;
    }
    const names = result.toolCalls.map((t) => t.name);
    console.log(`  tool_calls (${names.length}): ${names.join(', ') || '(none)'}`);
    console.log(`  text length: ${result.text.length} chars, ${result.durationMs}ms`);

    const accepted = smoke.accept.some((a) => names.includes(a));
    const rejected = smoke.reject.some((r) => names.includes(r));
    if (rejected) {
      bad(smoke.name, `→ called a rejected tool: ${smoke.reject.find((r) => names.includes(r))}. ${smoke.rejectReason}`);
    } else if (accepted) {
      ok(smoke.name);
    } else if (names.length === 0) {
      // No tool calls — model just talked. Lenient: not a failure if no
      // reject hit, but flag for review.
      note(`${smoke.name} — no tool calls (model answered conversationally)`);
    } else {
      // Called a tool we didn't anticipate. Surface for human review;
      // not a hard fail unless it's in the reject set.
      note(`${smoke.name} — called unanticipated tool(s): ${names.join(', ')}`);
    }
    console.log('');
  }

  console.log(`Result: ${pass} passed, ${fail} failed, ${skip} skipped/noted`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('behavioral-smoke fatal:', err);
  process.exit(2);
});
