#!/usr/bin/env node
/**
 * Managed Codex PreCompact bridge.
 *
 * Native automatic compaction bypasses Papercusp's deterministic carry,
 * checkpoint gate, lifecycle marker, and successor authority assembly. Codex's
 * synchronous PreCompact hook is the one supported point that can stop that
 * cut before it happens. This bridge asks the existing
 * session:request-compaction tool to schedule the managed boundary, then ALWAYS
 * returns continue:false: a refused or unavailable managed boundary leaves the
 * current process intact and reports the actionable reason; it never falls
 * through to an unmanaged native compaction.
 *
 * PAPERCUSP_MCP_URL is the exact per-session URL already written to the managed
 * CODEX_HOME. Keeping that exact URL preserves workspace, harness, role, tool
 * allowlist, signature, and owner route. Superuser homes additionally set
 * PAPERCUSP_MCP_AUTH=superuser-token; the bearer is read from its mode-0600 file
 * at execution time, never embedded in hooks.json or exposed in argv.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';

const MAX_INPUT_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 590_000;

function objectOrNull(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function parseJsonObject(text) {
  try {
    return objectOrNull(JSON.parse(String(text)));
  } catch {
    return null;
  }
}

/** Parse JSON, JSON-RPC/SSE, and CallToolResult envelopes into the tool body. */
export function parseManagedCarryResponse(rawText) {
  let rpcResult = null;
  let rpcError = null;
  for (let line of String(rawText ?? '').split('\n')) {
    line = line.trim();
    if (!line || line.startsWith('event:')) continue;
    if (line.startsWith('data:')) line = line.slice(5).trim();
    const frame = parseJsonObject(line);
    if (!frame) continue;
    if (Object.prototype.hasOwnProperty.call(frame, 'error')) {
      rpcError = frame.error;
      break;
    }
    if (Object.prototype.hasOwnProperty.call(frame, 'result')) {
      rpcResult = frame.result;
      break;
    }
    if (Array.isArray(frame.content) || Object.prototype.hasOwnProperty.call(frame, 'ok')) {
      rpcResult = frame;
      break;
    }
  }
  if (rpcError) {
    return { ok: false, detail: String(rpcError?.message ?? 'JSON-RPC error') };
  }
  const result = objectOrNull(rpcResult);
  if (!result) return { ok: false, detail: 'operator returned no MCP result' };
  if (Object.prototype.hasOwnProperty.call(result, 'ok')) {
    return { ok: true, inner: result, isError: result.isError === true };
  }
  for (const part of result.content ?? []) {
    if (part?.type !== 'text' || typeof part.text !== 'string') continue;
    const inner = parseJsonObject(part.text);
    if (inner) return { ok: true, inner, isError: result.isError === true };
  }
  return {
    ok: false,
    detail: result.isError === true
      ? 'session:request-compaction returned an unreadable tool error'
      : 'MCP result carried no JSON text',
  };
}

function boundedDetail(value, fallback) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return (text || fallback).slice(0, 700);
}

/** Convert every managed outcome to Codex's fail-closed PreCompact response. */
export function preCompactDecision(parsed) {
  const stopReason =
    'Papercusp intercepted automatic native compaction; only the managed carry boundary may replace this session.';
  if (!parsed?.ok || !parsed.inner) {
    return {
      continue: false,
      stopReason,
      systemMessage:
        'Managed carry could not be requested, so native compaction was stopped and this process remains intact. ' +
        `Retry session:request-compaction at a clean boundary. Detail: ${boundedDetail(parsed?.detail, 'unknown transport response')}`,
    };
  }
  const inner = parsed.inner;
  const queued = inner.ok === true && inner.requested === true && inner.respawn === 'queued';
  if (queued) {
    return {
      continue: false,
      stopReason,
      systemMessage:
        'Managed carry-respawn is QUEUED, not yet completed. Native compaction was stopped. ' +
        'Finish the atomic step, flush current work-item/loop state, then let the turn go quiet so the managed host can cut and resume this logical session.',
    };
  }
  const error = inner.error ?? inner.reason ??
    (parsed.isError ? 'tool-refused' : 'managed-boundary-not-queued');
  const note = inner.note ?? inner.message ?? inner.detail ?? '';
  return {
    continue: false,
    stopReason,
    systemMessage:
      `Managed carry was NOT queued (${boundedDetail(error, 'unknown refusal')}); native compaction was stopped and this process remains intact. ` +
      boundedDetail(note, 'Resolve the named prerequisite and retry session:request-compaction at a clean boundary.'),
  };
}

function readSuperuserToken(env) {
  if (env.PAPERCUSP_MCP_AUTH !== 'superuser-token') return '';
  const path = env.PAPERCUSP_SUPERUSER_TOKEN_PATH ||
    join(homedir(), '.papercusp', 'superuser-token');
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return '';
  }
}

/**
 * Run the bridge with injectable transport/token readers for hermetic tests.
 * @param {Record<string, unknown>} payload
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   fetchImpl?: typeof globalThis.fetch,
 *   readToken?: (env: Record<string, string | undefined>) => string,
 * }} [options]
 */
export async function runManagedPreCompact(payload, options = {}) {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const input = objectOrNull(payload);
  if (!input || input.hook_event_name !== 'PreCompact' || input.trigger !== 'auto') {
    return preCompactDecision({
      ok: false,
      detail: 'invalid PreCompact payload (expected hook_event_name=PreCompact and trigger=auto)',
    });
  }
  const mcpUrl = String(env.PAPERCUSP_MCP_URL ?? '').trim();
  const sid = String(env.PAPERCUSP_SID ?? '').trim();
  if (!mcpUrl || !sid || typeof fetchImpl !== 'function') {
    return preCompactDecision({ ok: false, detail: 'managed MCP URL or session identity is missing' });
  }
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  const token = options.readToken ? options.readToken(env) : readSuperuserToken(env);
  if (env.PAPERCUSP_MCP_AUTH === 'superuser-token') {
    if (!token) {
      return preCompactDecision({ ok: false, detail: 'superuser token is missing or unreadable' });
    }
    headers.Authorization = `Bearer ${token}`;
  }
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'session:request-compaction', arguments: {} },
  });
  try {
    const response = await fetchImpl(mcpUrl, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const raw = await response.text();
    const parsed = parseManagedCarryResponse(raw);
    if (!response.ok && !parsed.ok) parsed.detail = `HTTP ${response.status}: ${parsed.detail}`;
    return preCompactDecision(parsed);
  } catch (error) {
    return preCompactDecision({
      ok: false,
      detail: error?.name === 'TimeoutError'
        ? 'operator request timed out'
        : boundedDetail(error?.message, 'operator request failed'),
    });
  }
}

async function readStdin() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > MAX_INPUT_BYTES) throw new Error('hook input exceeds 1 MiB');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  let payload = null;
  try {
    payload = JSON.parse(await readStdin());
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify(preCompactDecision({ ok: false, detail: error?.message ?? 'invalid JSON input' }))}\n`,
    );
    return;
  }
  process.stdout.write(`${JSON.stringify(await runManagedPreCompact(payload))}\n`);
}

if (isCliEntry(import.meta.url)) {
  await main();
}
