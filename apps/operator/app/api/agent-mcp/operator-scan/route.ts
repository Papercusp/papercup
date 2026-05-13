/**
 * GET /api/agent-mcp/operator-scan?request=<text>&background=<0|1>
 *
 * Server-Sent Events stream of Operator's reasoning + suggestions.
 *
 * Events (forwarded from operator:scan):
 *   - first_run:    {}                       — emitted once on the first scan
 *   - delta:        { text }                 — Operator text streamed live
 *   - tool_call:    { name, input }          — Operator invoked an MCP tool
 *   - suggestion:   ParsedSuggestion         — emitted as Operator finalizes
 *   - idle_status:  { perHarness, computedAt } — only on the cached path
 *   - error:        { message, code? }       — fatal OR mid-stream non-fatal
 *   - done:         { costUsd, suggestions, parseErrors, cached? }
 *
 * Most of the lifecycle (lock, scan tracker, plugin merge, snapshot,
 * session bump, budget enforcement) lives in the operator:scan tool —
 * see apps/operator/lib/agent-tools/operator/scan.ts. This route is
 * the thin shim that owns:
 *   1. Operator-principal resolution (HTTP 503 if not provisioned).
 *   2. Rate-limit check + HTTP 429 (DoS protection — HTTP-only).
 *   3. Idle short-circuit (cached snapshot — cheap cache hit; emits
 *      directly without going through the LLM).
 *   4. Superuser-token read from disk.
 *   5. Dispatch the tool and forward its events.
 *
 * The IPC fast-path (apps/operator/lib/endpoint-ipc/server.ts) calls
 * operator:scan directly, getting the same safety + persistence as
 * the HTTP path (minus rate-limit + idle-cache — neither matters for
 * in-boundary webview calls).
 */

import { NextRequest } from 'next/server';
import { sseResponse } from '@restart/sse';
import {
  dispatchProjectedToolStream,
  emitToSseSink,
  lookupByMcpName,
  type UnifiedToolContext,
} from '@papercusp/agent-mcp';
// Side-effect: registers operator:scan + the other operator-side tools.
import '@/lib/agent-tools/index';
import { activeWorkspaceId } from '@/lib/workspace-registry';
import { readSystemPrincipal } from '@/lib/system-principal';
import { getSessionUser } from '@/lib/auth';
import { checkRate } from '@/lib/operator-rate-limit';
import { canShortCircuit } from '@/lib/operator-idle-snapshot';
import { fingerprint, readTriggerState } from '@/lib/operator-trigger-state';

export const dynamic = 'force-dynamic';

interface SystemPrincipalConfig {
  bearer: string;
  name: string;
  workspaceId: string;
  capabilities: string[];
}

async function loadOperatorBearer(): Promise<SystemPrincipalConfig | null> {
  const p = await readSystemPrincipal('operator');
  return p
    ? { bearer: p.bearer, name: p.name, workspaceId: p.workspaceId, capabilities: p.capabilities }
    : null;
}

function readSuperuserToken(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs') as typeof import('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('node:path') as typeof import('node:path');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const os = require('node:os') as typeof import('node:os');
    const tok = fs
      .readFileSync(path.join(os.homedir(), '.papercusp', 'superuser-token'), 'utf8')
      .trim();
    return tok && tok.length >= 16 ? tok : null;
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const requestText =
    url.searchParams.get('request') ??
    'Scan the workspace and surface up to 5 next-action suggestions.';
  const isBackground = url.searchParams.get('background') === '1';

  const principal = await loadOperatorBearer();
  if (!principal) {
    return new Response(
      'Operator principal not provisioned. POST /api/agent-mcp/provision first.',
      { status: 503 },
    );
  }
  const workspaceId = activeWorkspaceId();
  if (principal.workspaceId !== workspaceId) {
    return new Response(
      `Operator principal workspace mismatch (file=${principal.workspaceId} active=${workspaceId}).`,
      { status: 503 },
    );
  }

  const sessionUser = await getSessionUser();
  const userId = sessionUser?.id ?? 'anonymous';

  // Per-workspace rate limit + 503 circuit breaker — background scans
  // only. Manual scans bypass per the decision: errors should surface,
  // not be silenced. Rate limit is intentionally HTTP-only — IPC is
  // in-boundary so no DoS surface.
  if (isBackground) {
    const rate = await checkRate(workspaceId);
    if (!rate.allowed) {
      return new Response(`Background scan throttled (${rate.reason}).`, {
        status: 429,
        headers: { 'retry-after': String(rate.retryAfterSec ?? 30) },
      });
    }
  }

  // Idle short-circuit: cached snapshot if trigger-state is unchanged
  // AND we're inside the 30 min TTL. Background only — manual rescans
  // always burn the LLM (user explicitly asked). Lives at the route
  // because it returns SSE BEFORE any tool dispatch — cheaper than
  // running the tool just to short-circuit.
  if (isBackground) {
    try {
      const state = await readTriggerState();
      const fp = fingerprint(state);
      const snap = await canShortCircuit(fp);
      if (snap) {
        return sseResponse({
          signal: req.signal,
          headers: { 'x-operator-cached': '1' },
          setup: (sink) => {
            if (snap.perHarness && snap.perHarness.length > 0) {
              sink.event('idle_status', { perHarness: snap.perHarness, computedAt: snap.computedAt });
            }
            for (const card of snap.cards) sink.event('suggestion', card);
            sink.done({ costUsd: 0, suggestions: snap.cards.length, cached: true });
          },
        });
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[operator-scan] idle short-circuit unavailable:', err);
    }
  }

  // Read the superuser token (commit 0ccac7cf) for ?superuser=1 bypass —
  // operator-scan runs at chrome scope, not inside a spawn, so there's
  // no harness/run/spawn URL params to pass.
  const scanSuperuserToken = readSuperuserToken();

  const operatorScanTool = lookupByMcpName('operator:scan');
  if (!operatorScanTool) {
    return new Response('operator:scan tool not registered', { status: 500 });
  }

  return sseResponse({
    signal: req.signal,
    setup: async (sink) => {
      const ctxBase: UnifiedToolContext = {
        log: (msg) => {
          // eslint-disable-next-line no-console
          console.log(`[operator-scan][tool] ${msg}`);
        },
        signal: req.signal,
        progress: () => { /* unused — tool emits via ctx.emit */ },
        emit: () => { /* installed by dispatchProjectedToolStream */ },
        workspaceId,
        role: 'operator',
        // Phase 4 T2.2: UUIDs eliminate the Date.now() collision risk
        // (reviewer concern #4 from the v1 plan review).
        runId: globalThis.crypto.randomUUID(),
        spawnId: globalThis.crypto.randomUUID(),
        transport: 'in_process',
      };

      let costUsd = 0;
      let suggestions = 0;
      let parseErrors = 0;

      try {
        for await (const ev of dispatchProjectedToolStream(
          operatorScanTool,
          'operator:scan',
          {
            requestText,
            background: isBackground,
            userId,
            superuserToken: scanSuperuserToken,
          },
          ctxBase,
          {},
        )) {
          if (ev.kind === 'event') {
            emitToSseSink(sink, operatorScanTool, ev.name, ev.data);
          } else if (ev.kind === 'done') {
            try {
              const text = (ev.result.content[0] as { text?: string })?.text ?? '{}';
              const out = JSON.parse(text) as {
                costUsd: number;
                suggestions: number;
                parseErrors: number;
              };
              costUsd = out.costUsd;
              suggestions = out.suggestions;
              parseErrors = out.parseErrors;
            } catch (e) {
              // eslint-disable-next-line no-console
              console.warn('[operator-scan] tool result parse failed:', e);
            }
          } else if (ev.kind === 'error') {
            // Tool already emitted a typed error event for the
            // recoverable cases (budget_exhausted, scan_in_progress).
            // This branch handles the dispatcher's terminal error
            // (timeout / role gate / handler throw).
            sink.event('error', { message: ev.error.message });
            // Close so the consumer's reader exits — sink.event alone
            // doesn't EOF the stream. Same bug class as architect/chat
            // and operator-converse error paths.
            sink.close();
            return;
          }
        }

        sink.done({ costUsd, suggestions, parseErrors });
      } catch (err) {
        sink.event('error', { message: err instanceof Error ? err.message : String(err) });
        sink.close();
      }
    },
  });
}
