/**
 * GET /api/agent-mcp/operator-scan — SSE stream of operator:scan reasoning.
 * Thin shim: principal resolution, rate-limit, idle short-circuit, dispatch.
 * Ported from app/api/agent-mcp/operator-scan/route.ts. `auth: 'public'`.
 */
import { sseResponse } from '@papercusp/sse';
import {
  dispatchProjectedToolStream,
  emitToSseSink,
  lookupByMcpName,
  type UnifiedToolContext,
} from '@papercusp/agent-mcp';
import '../../../agent-tools/index';
import { activeWorkspaceId } from '../../../workspace-registry';
import { readSystemPrincipal } from '../../../system-principal';
import { getSessionUser } from '../../../auth';
import { checkRate } from '../../../operator-rate-limit';
import { canShortCircuit } from '../../../operator-idle-snapshot';
import { fingerprint, readTriggerState } from '../../../operator-trigger-state';
import { defineTool } from '@papercusp/agent-mcp';

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

export default defineTool({
  method: 'GET',
  path: '/agent-mcp/operator-scan',
  auth: 'public',
  // SSE — one route-stack run per long-lived connection; a route_invocations
  // row per connect carries little signal (RFC Q7). Don't record it.
  sampleRate: 0,
  async handler(req) {
    const url = new URL(req.url);
    const requestText =
      url.searchParams.get('request') ??
      'Scan the workspace and surface up to 5 next-action suggestions.';
    const isBackground = url.searchParams.get('background') === '1';

    const principal = await loadOperatorBearer();
    if (!principal) {
      return new Response(
        'Papercup principal not provisioned. POST /api/agent-mcp/provision first.',
        { status: 503 },
      );
    }
    const workspaceId = activeWorkspaceId();
    if (principal.workspaceId !== workspaceId) {
      return new Response(
        `Papercup principal workspace mismatch (file=${principal.workspaceId} active=${workspaceId}).`,
        { status: 503 },
      );
    }

    const sessionUser = await getSessionUser(req.headers);
    const userId = sessionUser?.id ?? 'anonymous';

    if (isBackground) {
      const rate = await checkRate(workspaceId);
      if (!rate.allowed) {
        return new Response(`Background scan throttled (${rate.reason}).`, {
          status: 429,
          headers: { 'retry-after': String(rate.retryAfterSec ?? 30) },
        });
      }
    }

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
              sink.event('error', { message: ev.error.message });
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
  },
});
