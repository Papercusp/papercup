#!/usr/bin/env node
/**
 * End-to-end test for the chat:ask_choice card flow.
 *
 *   1. chat:ask_choice tool registered + reachable via /api/mcp.
 *   2. Tool handler validates args (rejects empty options, over-cap,
 *      bad ids; lowercases option ids).
 *   3. POST /api/operator/conversations/:id/turns with a tools array
 *      persists the chat:ask_choice tool call to operator_turns.tools
 *      jsonb (migration 015).
 *   4. POST /api/operator/conversations/:id/turn-answer atomically
 *      UPDATEs the assistant row's tools[i].answered AND INSERTs a
 *      user row with the joined-labels text and source='card_pick'.
 *   5. Idempotency: second answer on same toolIndex → 409.
 *   6. Validation: unknown option_id → 400; bad body → 400;
 *      over-cap (>6 picks) → 400; empty picks → 400.
 *   7. Multi-select: picks array of length 2+ stored on
 *      tools[i].answered.picks and joined to user turn text via " · ".
 *
 * Honors OP_PORT (defaults to 3055).
 */

import { execSync } from 'node:child_process';

const OP_PORT = process.env.OP_PORT ?? '3055';
const BASE = `http://localhost:${OP_PORT}`;

let pass = 0, fail = 0;
const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };
const bad = (n, d = '') => { console.log(`  ✗ ${n}  ${d}`); fail++; };
const check = (cond, n, d = '') => (cond ? ok(n) : bad(n, d));

async function jsonPOST(path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: r.status, text, json };
}

async function getConversationId() {
  const r = await fetch(`${BASE}/api/operator/conversations`);
  const j = await r.json();
  return j?.conversation?.id ?? null;
}

async function callMcpTool(name, args) {
  const TOKEN = execSync(`cat ${process.env.HOME}/.papercusp/superuser-token`, { encoding: 'utf8' }).trim();
  const r = await fetch(`${BASE}/api/mcp?superuser=1`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const text = await r.text();
  // SSE response: extract + unwrap the JSON-RPC result. The MCP tool's
  // handler output sits inside result.content[0].text as a nested JSON
  // string; un-stringify so the test can assert against the actual
  // shape instead of escaped braces.
  let unwrapped = null;
  try {
    const dataLine = text.split('\n').find((l) => l.startsWith('data: '));
    if (dataLine) {
      const envelope = JSON.parse(dataLine.slice(6));
      const inner = envelope?.result?.content?.[0]?.text;
      if (typeof inner === 'string') {
        unwrapped = JSON.parse(inner);
      } else if (envelope?.result?.content?.[0]?.text) {
        unwrapped = envelope.result.content[0].text;
      } else {
        unwrapped = envelope?.result ?? envelope;
      }
    }
  } catch { /* leave unwrapped null on parse failure */ }
  return { status: r.status, text, unwrapped };
}

function pgQuery(sql) {
  return execSync(
    `PGPASSWORD=harness_admin_pwd psql -h localhost -U harness_admin -d papercusp -tAc "${sql}"`,
    { encoding: 'utf8' },
  ).trim();
}

async function main() {
  console.log(`--- targeting ${BASE} ---`);

  const conv = await getConversationId();
  if (!conv) {
    bad('GET /api/operator/conversations did not return a conversation id');
    process.exit(2);
  }
  ok(`got conversation id ${conv.slice(0, 8)}…`);

  // ── 1. Tool reachable + validates correctly ───────────────────────
  console.log('\n--- 1. tool reachable + handler validation ---');
  {
    const r = await callMcpTool('chat:ask_choice', {
      question: 'Test?',
      options: [{ id: 'Yes', label: 'Yes' }, { id: 'NO', label: 'No' }],
    });
    const ids = r.unwrapped?.options?.map((o) => o.id) ?? [];
    check(
      r.unwrapped?.rendered === true && ids.includes('yes') && ids.includes('no'),
      'handler echoes back validated args with lowercased ids',
      JSON.stringify(r.unwrapped).slice(0, 250),
    );
  }
  {
    const r = await callMcpTool('chat:ask_choice', { question: 'X?', options: [] });
    check(r.text.includes('too_small'), 'empty options rejected', r.text.slice(0, 200));
  }
  {
    const r = await callMcpTool('chat:ask_choice', {
      question: 'X?',
      options: Array.from({ length: 7 }, (_, i) => ({ id: `o${i}`, label: `Opt ${i}` })),
    });
    check(r.text.includes('too_big'), '7 options rejected (over 6 cap)', r.text.slice(0, 200));
  }

  // ── 2. Persist a card via POST /turns ─────────────────────────────
  console.log('\n--- 2. persist tools[] on operator_turns row ---');
  const cardTools = [{
    name: 'chat:ask_choice',
    input: {
      question: 'Single-select e2e?',
      options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No', style: 'danger' }],
    },
  }];
  const insert = await jsonPOST(`/api/operator/conversations/${conv}/turns`, {
    role: 'assistant',
    text: '',
    source: 'text_typed',
    tools: cardTools,
  });
  check(insert.status === 200, 'POST /turns 200', `status=${insert.status}`);
  const assistantSeq = insert.json?.turn?.seq;
  check(typeof assistantSeq === 'number', 'turn.seq returned', `got ${assistantSeq}`);
  check(
    Array.isArray(insert.json?.turn?.tools) && insert.json.turn.tools[0]?.name === 'chat:ask_choice',
    'turn.tools round-tripped from PG',
  );

  // ── 3. turn-answer happy path (single-select) ─────────────────────
  console.log('\n--- 3. POST /turn-answer atomic happy path ---');
  const answer = await jsonPOST(`/api/operator/conversations/${conv}/turn-answer`, {
    assistantSeq,
    toolIndex: 0,
    picks: [{ option_id: 'yes', label: 'Yes' }],
  });
  check(answer.status === 200, 'turn-answer 200', `status=${answer.status} body=${answer.text.slice(0, 200)}`);
  const userSeq = answer.json?.userSeq;
  check(typeof userSeq === 'number' && userSeq === assistantSeq + 1, 'userSeq = assistantSeq + 1');

  // Verify both rows landed via PG
  const pgRows = pgQuery(
    `SELECT seq||'|'||role||'|'||text||'|'||source||'|'||COALESCE(tools->0->>'answered', '') FROM harness_shared.operator_turns WHERE conversation_id='${conv}' AND seq IN (${assistantSeq}, ${userSeq}) ORDER BY seq`,
  );
  const lines = pgRows.split('\n');
  check(
    lines.length === 2 && lines[0].includes(`${assistantSeq}|assistant`) && lines[0].includes('"option_id": "yes"'),
    'assistant row has answered set',
    lines[0],
  );
  check(
    lines[1].includes(`${userSeq}|user|Yes|card_pick`),
    'user row inserted with label=Yes, source=card_pick',
    lines[1],
  );

  // ── 4. Idempotency: second answer → 409 ───────────────────────────
  console.log('\n--- 4. idempotency: re-answer → 409 ---');
  const second = await jsonPOST(`/api/operator/conversations/${conv}/turn-answer`, {
    assistantSeq,
    toolIndex: 0,
    picks: [{ option_id: 'no', label: 'No' }],
  });
  check(second.status === 409, '409 already_answered', `status=${second.status}`);
  check(second.json?.answered?.picks?.[0]?.option_id === 'yes', '409 returns the prior answer', JSON.stringify(second.json));

  // ── 5. Multi-select round-trip ────────────────────────────────────
  console.log('\n--- 5. multi-select: 2 picks → joined labels ---');
  const multiInsert = await jsonPOST(`/api/operator/conversations/${conv}/turns`, {
    role: 'assistant',
    text: '',
    source: 'text_typed',
    tools: [{
      name: 'chat:ask_choice',
      input: {
        question: 'Pick all that apply',
        multi: true,
        options: [
          { id: 'a', label: 'Feature A' },
          { id: 'b', label: 'Feature B' },
          { id: 'c', label: 'Feature C' },
        ],
      },
    }],
  });
  const multiSeq = multiInsert.json?.turn?.seq;
  check(typeof multiSeq === 'number', 'multi card persisted', `seq=${multiSeq}`);

  const multiAnswer = await jsonPOST(`/api/operator/conversations/${conv}/turn-answer`, {
    assistantSeq: multiSeq,
    toolIndex: 0,
    picks: [
      { option_id: 'a', label: 'Feature A' },
      { option_id: 'c', label: 'Feature C' },
    ],
  });
  check(multiAnswer.status === 200, 'multi turn-answer 200', `status=${multiAnswer.status}`);
  const multiUserSeq = multiAnswer.json?.userSeq;
  // COALESCE because the user row has tools=NULL — PG's `||` returns
  // NULL if any operand is NULL, which collapsed multiLines[1] to
  // empty in the first version of this test.
  const multiRow = pgQuery(
    `SELECT text||'|'||COALESCE((tools->0->'answered'->>'picks')::text, '') FROM harness_shared.operator_turns WHERE conversation_id='${conv}' AND seq IN (${multiSeq}, ${multiUserSeq}) ORDER BY seq`,
  );
  const multiLines = multiRow.split('\n');
  check(
    multiLines[0]?.includes('Feature A') && multiLines[0]?.includes('Feature C'),
    'multi assistant tools[0].answered.picks has both',
    multiLines[0],
  );
  check(
    multiLines[1]?.startsWith('Feature A · Feature C|'),
    'user row text = joined labels with " · "',
    multiLines[1],
  );

  // ── 6. Validation: bad bodies ─────────────────────────────────────
  console.log('\n--- 6. validation failures ---');
  const validInsert = await jsonPOST(`/api/operator/conversations/${conv}/turns`, {
    role: 'assistant', text: '', source: 'text_typed',
    tools: [{ name: 'chat:ask_choice', input: { question: 'X?', options: [{ id: 'a', label: 'A' }] } }],
  });
  const vSeq = validInsert.json?.turn?.seq;

  const empty = await jsonPOST(`/api/operator/conversations/${conv}/turn-answer`, {
    assistantSeq: vSeq, toolIndex: 0, picks: [],
  });
  check(empty.status === 400, 'empty picks → 400');

  const overcap = await jsonPOST(`/api/operator/conversations/${conv}/turn-answer`, {
    assistantSeq: vSeq, toolIndex: 0,
    picks: Array.from({ length: 7 }, (_, i) => ({ option_id: 'a', label: `A${i}` })),
  });
  check(overcap.status === 400, 'over-cap picks (7) → 400');

  const unknown = await jsonPOST(`/api/operator/conversations/${conv}/turn-answer`, {
    assistantSeq: vSeq, toolIndex: 0,
    picks: [{ option_id: 'bogus', label: 'Bogus' }],
  });
  check(
    unknown.status === 400 && unknown.json?.unknownIds?.[0] === 'bogus',
    'unknown option_id → 400 with unknownIds echoed',
    JSON.stringify(unknown.json),
  );

  const badIndex = await jsonPOST(`/api/operator/conversations/${conv}/turn-answer`, {
    assistantSeq: vSeq, toolIndex: 99, picks: [{ option_id: 'a', label: 'A' }],
  });
  check(badIndex.status === 400, 'bad toolIndex → 400');

  const missingFields = await jsonPOST(`/api/operator/conversations/${conv}/turn-answer`, {});
  check(missingFields.status === 400, 'missing body fields → 400');

  // ── Cleanup: drop the test rows ───────────────────────────────────
  console.log('\n--- cleanup ---');
  pgQuery(
    `DELETE FROM harness_shared.operator_turns WHERE conversation_id='${conv}' AND seq IN (${assistantSeq}, ${userSeq}, ${multiSeq}, ${multiUserSeq}, ${vSeq})`,
  );
  ok('test rows deleted');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error('e2e error:', e); process.exit(2); });
