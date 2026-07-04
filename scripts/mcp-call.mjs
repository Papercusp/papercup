#!/usr/bin/env node
/**
 * mcp-call — recover-now access to the operator MCP when the Claude Code
 * papercusp-su client has dropped (EI-1740 / EI-1750; runbook:
 * agent-insights/mcp-client-drop-curl-recovery). The server stays healthy when
 * the client disconnects; this drives it directly via a single-shot stateless
 * `tools/call` over the streamable-HTTP endpoint with the superuser bearer.
 *
 * Standardizes the technique several auto-mode agents were hand-rolling in
 * /tmp (and colliding on the same path) — pass your OWN --client so coord/plan
 * writes attribute correctly.
 *
 * Usage:
 *   node scripts/mcp-call.mjs <tool> [jsonArgs] [--client <id>] [--workspace <ws>] [--harness <h>] [--raw]
 * Examples:
 *   node scripts/mcp-call.mjs coord:whoami
 *   node scripts/mcp-call.mjs work_items:get '{"id":"EI-1750"}' --harness papercup
 *   node scripts/mcp-call.mjs plans:search '{"query":"infra","harness":"papercup"}' --client su-1234
 *
 * Notes: tool names use COLONS (coord:whoami, plans:new, work_items:set_state —
 * arg is `itemId` not `item`). `tools/list` returns empty in this mode, but
 * `tools/call` reaches every tool. Reads the bearer from ~/.papercusp/superuser-token.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function parseArgs(argv) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (key === 'raw') flags.raw = true;
      else flags[key] = argv[++i];
    } else pos.push(a);
  }
  return { tool: pos[0], jsonArgs: pos[1], flags };
}

/** Extract the JSON-RPC result from an SSE response body (exported shape for clarity). */
export function parseSse(raw) {
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s.startsWith('data:')) continue;
    let d;
    try { d = JSON.parse(s.slice(5).trim()); } catch { continue; }
    if (d.error) return { error: d.error };
    const text = d?.result?.content?.[0]?.text;
    if (text !== undefined) {
      try { return { result: JSON.parse(text) }; } catch { return { result: text }; }
    }
    return { result: d.result ?? d };
  }
  return { error: { message: 'no data: line in SSE response', raw: raw.slice(0, 400) } };
}

async function main() {
  const { tool, jsonArgs, flags } = parseArgs(process.argv.slice(2));
  if (!tool || tool === '--help' || tool === '-h') {
    console.error('usage: node scripts/mcp-call.mjs <ns:verb> [jsonArgs] [--client <id>] [--workspace <ws>] [--harness <h>] [--raw]');
    process.exit(tool ? 0 : 2);
  }
  let tok;
  try {
    tok = readFileSync(join(homedir(), '.papercusp', 'superuser-token'), 'utf8').trim();
  } catch {
    console.error('mcp-call: no ~/.papercusp/superuser-token — run on a host that has it.');
    process.exit(3);
  }
  const args = jsonArgs ? JSON.parse(jsonArgs) : {};
  // EI-6631: an empty/whitespace-only --client (e.g. `--client "$UNSET_VAR"`) must fall
  // back to the generated id, not be sent as a blank client= — `??` alone only catches
  // null/undefined, not "".
  const client = (flags.client && flags.client.trim()) || `mcp-call-${process.pid}`;
  const qs = new URLSearchParams({ superuser: '1', client });
  // The scoped-superuser session requires a resolved workspace (else
  // `scoped_superuser_workspace_unresolved`). Default to the standard one; override
  // with --workspace or PAPERCUSP_WORKSPACE.
  qs.set('workspace', flags.workspace ?? process.env.PAPERCUSP_WORKSPACE ?? 'papercusp-workspace');
  if (flags.harness) qs.set('harness', flags.harness);
  const url = `http://localhost:${process.env.PAPERCUSP_HONO_PORT ?? 3070}/api/mcp?${qs}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${tok}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }),
  });
  const raw = await res.text();
  if (flags.raw) { process.stdout.write(raw); return; }
  const out = parseSse(raw);
  if (out.error) {
    console.error('MCP_ERROR:', JSON.stringify(out.error));
    process.exit(1);
  }
  console.log(typeof out.result === 'string' ? out.result : JSON.stringify(out.result, null, 2));
}

main().catch((e) => { console.error('mcp-call failed:', e?.message ?? e); process.exit(1); });
