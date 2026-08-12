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
 *   node scripts/mcp-call.mjs <tool> [jsonArgs] [--client <id>] [--workspace <ws>] [--harness <h>] [--port <n>] [--raw]
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
import { pathToFileURL } from 'node:url';

/** The JSON-RPC id we send; parseSse selects the frame that answers it. */
const REQUEST_ID = 1;

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

/**
 * Extract the JSON-RPC result from an SSE response body (exported shape for clarity).
 *
 * The stream carries frames we did NOT ask for: the server emits
 * `notifications/tools/list_changed` (and friends) BEFORE the response to our
 * `tools/call`. Those are JSON-RPC *notifications* — a `method`, no `id`, no
 * `result`. Returning the first `data:` frame therefore handed callers the
 * notification instead of the tool result, and because the old fallback
 * (`d.result ?? d`) returned the raw frame rather than erroring, it looked like
 * a successful call that answered `{"method":"notifications/tools/list_changed"}`
 * — a well-formed, confidently wrong result on the exact path agents use when
 * the papercusp-su MCP client has dropped. Select the frame that RESPONDS to us
 * (`id` matching the request), never merely the first one.
 */
export function parseSse(raw, requestId = 1) {
  let sawFrame = false;
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s.startsWith('data:')) continue;
    let d;
    try { d = JSON.parse(s.slice(5).trim()); } catch { continue; }
    sawFrame = true;
    // A notification has no id and never answers our call — skip it.
    if (d.id === undefined || d.id === null) continue;
    if (d.id !== requestId) continue;
    if (d.error) return { error: d.error };
    if (!('result' in d)) continue;
    const text = d?.result?.content?.[0]?.text;
    if (text !== undefined) {
      try { return { result: JSON.parse(text) }; } catch { return { result: text }; }
    }
    return { result: d.result };
  }
  return {
    error: sawFrame
      ? { message: `no JSON-RPC response frame for id ${requestId} in SSE stream`, raw: raw.slice(0, 400) }
      : { message: 'no data: line in SSE response', raw: raw.slice(0, 400) },
  };
}

/** Resolve the operator ports to try. An explicit CLI port is a fail-closed pin;
 * the inherited environment hint retains its recovery fallback to canonical. */
export function resolveCandidatePorts(flags = {}, env = process.env) {
  const CANONICAL_PORT = '3070';
  if (flags.port !== undefined) {
    const pinned = String(flags.port).trim();
    if (!/^\d+$/.test(pinned) || Number(pinned) < 1 || Number(pinned) > 65535) {
      throw new Error(`--port must be an integer from 1 to 65535 (received ${JSON.stringify(flags.port)})`);
    }
    return { configuredPort: pinned, candidatePorts: [pinned], pinned: true };
  }
  const configuredPort = env.PAPERCUSP_HONO_PORT ?? CANONICAL_PORT;
  return {
    configuredPort: String(configuredPort),
    candidatePorts: [...new Set([String(configuredPort), CANONICAL_PORT])],
    pinned: false,
  };
}

async function main() {
  const { tool, jsonArgs, flags } = parseArgs(process.argv.slice(2));
  if (!tool || tool === '--help' || tool === '-h') {
    console.error('usage: node scripts/mcp-call.mjs <ns:verb> [jsonArgs] [--client <id>] [--workspace <ws>] [--harness <h>] [--port <n>] [--raw]');
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
  // EI-20182275617587040: PAPERCUSP_HONO_PORT can OUTLIVE the process it described
  // (e.g. a per-session operator that has since died), and a bare fetch at a port with
  // no listener dies as an unactionable `fetch failed`. That is worst precisely HERE:
  // this script IS the documented recovery path for a dropped MCP client, so when it
  // inherits the same stale port, the primary and its fallback fail together and the
  // symptom reads as "the server is down" while the server is answering in ~4ms.
  // So: try the configured port, then the canonical one, and say exactly what happened.
  const { configuredPort, candidatePorts, pinned } = resolveCandidatePorts(flags);

  const init = {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${tok}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: REQUEST_ID, method: 'tools/call', params: { name: tool, arguments: args } }),
  };

  let res;
  const attempts = [];
  for (const port of candidatePorts) {
    try {
      res = await fetch(`http://localhost:${port}/api/mcp?${qs}`, init);
      if (!pinned && port !== String(configuredPort)) {
        console.error(
          `mcp-call: WARNING — nothing was listening on PAPERCUSP_HONO_PORT=${configuredPort}; ` +
            `reached the operator on the canonical port ${port} instead. Your environment's port is ` +
            `STALE: export PAPERCUSP_HONO_PORT=${port} (or unset it), or every other tool deriving ` +
            `its URL from that variable will keep failing the same way.`,
        );
      }
      break;
    } catch (err) {
      attempts.push(`${port} (${err?.cause?.code ?? err?.message ?? 'unknown error'})`);
    }
  }

  if (!res) {
    console.error(
      `mcp-call: could not reach the operator MCP endpoint. Tried port(s): ${attempts.join(', ')}.\n` +
        (pinned ? `  Port ${configuredPort} was explicitly pinned with --port, so no fallback was attempted.\n` : '') +
        `  Nothing is listening there — but a HEALTHY operator on a DIFFERENT port is the common\n` +
        `  case, so do not read this as a dead server. Find the live port:\n` +
        `    ss -ltn | grep -E ':(3070|3170)'   # then: PAPERCUSP_HONO_PORT=<live port> re-run\n` +
        `  Confirm the server is actually fine with:\n` +
        `    curl -s -o /dev/null -w '%{http_code}\\n' http://127.0.0.1:3070/api/health\n` +
        `  See EI-20182275617587040 / agent-insights/mcp-client-drop-curl-recovery.`,
    );
    process.exit(4);
  }
  const raw = await res.text();
  if (flags.raw) { process.stdout.write(raw); return; }
  const out = parseSse(raw, REQUEST_ID);
  if (out.error) {
    console.error('MCP_ERROR:', JSON.stringify(out.error));
    process.exit(1);
  }
  console.log(typeof out.result === 'string' ? out.result : JSON.stringify(out.result, null, 2));
}

// Run ONLY when invoked as a script. `parseSse` is exported for tests, and a
// bare `main()` at module scope executed it on import — so importing the parser
// fired a real MCP call and then process.exit(1), which reads as a broken test
// rather than a non-importable module.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((e) => { console.error('mcp-call failed:', e?.message ?? e); process.exit(1); });
}
