/**
 * End-to-end test for the chat:ask_choice card flow.
 *
 * Plan: admin-testing-tab-restructure-2026-05-24, P-027.
 * Migrated from apps/operator/__tests__/integration/ask-choice-e2e.mjs.
 * Skipped when operator is not reachable.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

const OP_PORT = process.env.OP_PORT ?? '3055';
const BASE = `http://localhost:${OP_PORT}`;

let baseUrl = '';
let TOKEN = '';
let convId = '';

try {
  TOKEN = readFileSync(join(homedir(), '.papercusp', 'superuser-token'), 'utf8').trim();
  const probe = await fetch(`${BASE}/api/operator/conversations`, { signal: AbortSignal.timeout(3000) });
  if (probe.ok) {
    const j = await probe.json() as any;
    convId = j?.conversation?.id ?? '';
    if (convId) baseUrl = BASE;
  }
} catch { /* operator not running */ }

const itLive = baseUrl ? it : it.skip;

async function jsonPOST(path: string, body: unknown) {
  const r = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* */ }
  return { status: r.status, text, json };
}

async function callMcpTool(name: string, args: unknown) {
  const r = await fetch(`${baseUrl}/api/mcp?superuser=1`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const text = await r.text();
  const dataLine = text.split('\n').find((l) => l.startsWith('data:'));
  const env = dataLine ? JSON.parse(dataLine.slice('data:'.length).trim()) : {};
  const resultText: string = env.result?.content?.[0]?.text ?? text;
  let unwrapped: any = null;
  try { unwrapped = JSON.parse(resultText); } catch { /* */ }
  return { text: resultText, unwrapped };
}

function pgQuery(sql: string): string {
  return execSync(
    `PGPASSWORD=harness_admin_pwd psql -h localhost -U harness_admin -d papercusp -tAc "${sql}"`,
    { encoding: 'utf8' },
  ).trim();
}

// seqs inserted during the test — cleaned up in afterAll
const insertedSeqs: number[] = [];

describe('chat:ask_choice card e2e', () => {
  afterAll(() => {
    if (!baseUrl || !convId || insertedSeqs.length === 0) return;
    try {
      pgQuery(`DELETE FROM harness_shared.operator_turns WHERE conversation_id='${convId}' AND seq IN (${insertedSeqs.join(',')})`);
    } catch (e) {
      console.warn('[cleanup]', e instanceof Error ? e.message : e);
    }
  });

  itLive('tool reachable: echoes lowercased ids', async () => {
    const r = await callMcpTool('chat:ask_choice', {
      question: 'Test?',
      options: [{ id: 'Yes', label: 'Yes' }, { id: 'NO', label: 'No' }],
    });
    const ids: string[] = r.unwrapped?.options?.map((o: any) => o.id) ?? [];
    expect(r.unwrapped?.rendered).toBe(true);
    expect(ids).toContain('yes');
    expect(ids).toContain('no');
  });

  // The args schema rejects empty / over-cap options (z.array().min(1).max(6)).
  // Assert the stable invalid_args + failing-field path; zod v4's messages no
  // longer embed the raw 'too_small'/'too_big' issue codes (formatIssues emits
  // "options: <human message>").
  itLive('empty options → validation error', async () => {
    const r = await callMcpTool('chat:ask_choice', { question: 'X?', options: [] });
    expect(r.text).toContain('invalid_args');
    expect(r.text).toContain('options');
  });

  itLive('7 options → over-cap validation error', async () => {
    const r = await callMcpTool('chat:ask_choice', {
      question: 'X?',
      options: Array.from({ length: 7 }, (_, i) => ({ id: `o${i}`, label: `Opt ${i}` })),
    });
    expect(r.text).toContain('invalid_args');
    expect(r.text).toContain('options');
  });

  itLive('POST /turns persists tools[] and turn-answer updates them', async () => {
    const insert = await jsonPOST(`/api/operator/conversations/${convId}/turns`, {
      role: 'assistant',
      text: '',
      source: 'text_typed',
      tools: [{
        name: 'chat:ask_choice',
        input: { question: 'Single-select e2e?', options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No', style: 'danger' }] },
      }],
    });
    expect(insert.status).toBe(200);
    const assistantSeq: number = insert.json?.turn?.seq;
    expect(typeof assistantSeq).toBe('number');
    insertedSeqs.push(assistantSeq);
    expect(insert.json?.turn?.tools?.[0]?.name).toBe('chat:ask_choice');

    const answer = await jsonPOST(`/api/operator/conversations/${convId}/turn-answer`, {
      assistantSeq,
      toolIndex: 0,
      picks: [{ option_id: 'yes', label: 'Yes' }],
    });
    expect(answer.status).toBe(200);
    const userSeq: number = answer.json?.userSeq;
    expect(userSeq).toBe(assistantSeq + 1);
    insertedSeqs.push(userSeq);

    const pgRows = pgQuery(
      `SELECT seq||'|'||role||'|'||text||'|'||source||'|'||COALESCE(tools->0->>'answered', '') FROM harness_shared.operator_turns WHERE conversation_id='${convId}' AND seq IN (${assistantSeq}, ${userSeq}) ORDER BY seq`,
    );
    const [assistantLine, userLine] = pgRows.split('\n');
    expect(assistantLine).toContain(`${assistantSeq}|assistant`);
    expect(assistantLine).toContain('"option_id": "yes"');
    expect(userLine).toContain(`${userSeq}|user|Yes|card_pick`);
  });

  itLive('second answer → 409 already_answered with prior answer echoed', async () => {
    // Insert a fresh card to answer twice
    const ins = await jsonPOST(`/api/operator/conversations/${convId}/turns`, {
      role: 'assistant', text: '', source: 'text_typed',
      tools: [{ name: 'chat:ask_choice', input: { question: 'Dupe?', options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }] } }],
    });
    const seq: number = ins.json?.turn?.seq;
    insertedSeqs.push(seq);
    await jsonPOST(`/api/operator/conversations/${convId}/turn-answer`, { assistantSeq: seq, toolIndex: 0, picks: [{ option_id: 'yes', label: 'Yes' }] });
    const second = await jsonPOST(`/api/operator/conversations/${convId}/turn-answer`, { assistantSeq: seq, toolIndex: 0, picks: [{ option_id: 'no', label: 'No' }] });
    expect(second.status).toBe(409);
    expect(second.json?.answered?.picks?.[0]?.option_id).toBe('yes');
  });

  itLive('multi-select: 2 picks joined with " · "', async () => {
    const ins = await jsonPOST(`/api/operator/conversations/${convId}/turns`, {
      role: 'assistant', text: '', source: 'text_typed',
      tools: [{ name: 'chat:ask_choice', input: { question: 'Pick all', multi: true, options: [{ id: 'a', label: 'Feature A' }, { id: 'b', label: 'Feature B' }, { id: 'c', label: 'Feature C' }] } }],
    });
    const multiSeq: number = ins.json?.turn?.seq;
    insertedSeqs.push(multiSeq);
    const ans = await jsonPOST(`/api/operator/conversations/${convId}/turn-answer`, {
      assistantSeq: multiSeq, toolIndex: 0,
      picks: [{ option_id: 'a', label: 'Feature A' }, { option_id: 'c', label: 'Feature C' }],
    });
    expect(ans.status).toBe(200);
    insertedSeqs.push(ans.json?.userSeq);
    const rows = pgQuery(
      `SELECT text||'|'||COALESCE((tools->0->'answered'->>'picks')::text, '') FROM harness_shared.operator_turns WHERE conversation_id='${convId}' AND seq IN (${multiSeq}, ${ans.json?.userSeq}) ORDER BY seq`,
    ).split('\n');
    expect(rows[0]).toContain('Feature A');
    expect(rows[0]).toContain('Feature C');
    expect(rows[1]).toMatch(/^Feature A · Feature C\|/);
  });

  itLive('validation: empty/overcap/unknown/bad-index/missing-fields → 400', async () => {
    const ins = await jsonPOST(`/api/operator/conversations/${convId}/turns`, {
      role: 'assistant', text: '', source: 'text_typed',
      tools: [{ name: 'chat:ask_choice', input: { question: 'V?', options: [{ id: 'a', label: 'A' }] } }],
    });
    const vSeq: number = ins.json?.turn?.seq;
    insertedSeqs.push(vSeq);

    const empty = await jsonPOST(`/api/operator/conversations/${convId}/turn-answer`, { assistantSeq: vSeq, toolIndex: 0, picks: [] });
    expect(empty.status).toBe(400);

    const overcap = await jsonPOST(`/api/operator/conversations/${convId}/turn-answer`, { assistantSeq: vSeq, toolIndex: 0, picks: Array.from({ length: 7 }, (_, i) => ({ option_id: 'a', label: `A${i}` })) });
    expect(overcap.status).toBe(400);

    const unknown = await jsonPOST(`/api/operator/conversations/${convId}/turn-answer`, { assistantSeq: vSeq, toolIndex: 0, picks: [{ option_id: 'bogus', label: 'Bogus' }] });
    expect(unknown.status).toBe(400);
    expect(unknown.json?.unknownIds?.[0]).toBe('bogus');

    const badIdx = await jsonPOST(`/api/operator/conversations/${convId}/turn-answer`, { assistantSeq: vSeq, toolIndex: 99, picks: [{ option_id: 'a', label: 'A' }] });
    expect(badIdx.status).toBe(400);

    const missing = await jsonPOST(`/api/operator/conversations/${convId}/turn-answer`, {});
    expect(missing.status).toBe(400);
  });
});
