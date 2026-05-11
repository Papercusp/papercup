/**
 * GET /api/agent-mcp/operator-scan?request=<text>
 *
 * Server-Sent Events stream of Operator's reasoning + suggestions.
 *
 * Events:
 *   - delta:        { text }                 — Operator text streamed live
 *   - tool_call:    { name, input }          — Operator invoked an MCP tool
 *   - suggestion:   ParsedSuggestion         — emitted as Operator finalizes
 *   - first_run:    {}                       — emitted once on the first scan
 *   - done:         { costUsd, suggestions } — Operator finished
 *   - error:        { message }              — fatal
 *
 * The actual MCP server spawned for this request is `agent-mcp`'s
 * standalone entrypoint, with the calling principal's bearer wired in
 * via env. The principal is `system:operator` for the active workspace,
 * loaded from the operator's per-workspace config file.
 */

import { NextRequest } from 'next/server';
import { existsSync, readFileSync } from 'node:fs';
import { runAgentChat } from '@/lib/agent-chat-stream';
import { papercuspPath } from '@/lib/papercusp-root';
import { activeWorkspaceId } from '@/lib/workspace-registry';
import { readSystemPrincipal } from '@/lib/system-principal';
import { getSessionUser } from '@/lib/auth';
import { ALL_AGENT_MCP_TOOLS } from '@/lib/operator-mcp-tools';
import {
  buildOperatorPrompt,
  markFirstRunShown,
} from '@/lib/operator-prompt';
import { parseSuggestions } from '@/lib/operator-suggestion-parser';
import { loadPreferences } from '@/lib/operator-preferences';
import { acquireScanLock, releaseScanLock } from '@/lib/operator-scan-lock';
import { checkBudget, recordSpend } from '@/lib/operator-budget';
import { writeLastScan } from '@/lib/operator-last-scan';
import { startOperatorScan, completeOperatorScan, failOperatorScan } from '@/lib/operator-scans';
import { isScannerResumeEnabled, getOrCreateScannerSessionId, bumpScannerSession } from '@/lib/operator-scanner-session';
import { buildScannerBootstrap } from '@/lib/operator-scanner-bootstrap';
import { checkRate, record503, recordSuccess } from '@/lib/operator-rate-limit';
import { canShortCircuit, writeSnapshot } from '@/lib/operator-idle-snapshot';
import { fingerprint, readTriggerState } from '@/lib/operator-trigger-state';
import { resolvePluginAwareTier } from '@/lib/operator-plugin-tier';
import { refreshDismissedFromPg } from '@/lib/operator-dismissed-cache';
import { gatherPluginSuggestions } from '@/lib/operator-plugin-suggestions';
import { enrich } from '@/lib/operator-suggestion-parser';

export const dynamic = 'force-dynamic';

interface SystemPrincipalConfig {
  bearer: string;
  name: string;
  workspaceId: string;
  capabilities: string[];
}

/**
 * Pull the scanner's trailing one-line status out of the assistant
 * text. The scanner.md role tells it to write exactly that after the
 * <suggestion> blocks (e.g. "Scanned 7 harnesses, surfaced 3
 * suggestions."). Falls back to a generic summary if the model didn't
 * follow the convention this turn.
 */
function extractScanSummary(text: string): string | null {
  if (!text) return null;
  // Drop everything inside <suggestion> blocks; keep the prose around them.
  const stripped = text.replace(/<suggestion>[\s\S]*?<\/suggestion>/g, '').trim();
  if (!stripped) return null;
  // Use the LAST non-empty line — that's where the persona puts the
  // status sentence. Cap at 280 chars to keep the History view tidy.
  const lines = stripped.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1] ?? null;
  if (!last) return null;
  return last.length > 280 ? last.slice(0, 277) + '…' : last;
}

async function loadOperatorBearer(): Promise<SystemPrincipalConfig | null> {
  const p = await readSystemPrincipal('operator');
  return p ? { bearer: p.bearer, name: p.name, workspaceId: p.workspaceId, capabilities: p.capabilities } : null;
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const requestText = url.searchParams.get('request') ?? 'Scan the workspace and surface up to 5 next-action suggestions.';
  const isBackground = url.searchParams.get('background') === '1';

  const principal = await loadOperatorBearer();
  if (!principal) {
    return new Response('Operator principal not provisioned. POST /api/agent-mcp/provision first.', {
      status: 503,
    });
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

  // Per-workspace rate limit + 503 circuit breaker — background scans only.
  // Manual scans bypass per §4 decision 3 (errors should surface, not be silenced).
  if (isBackground) {
    const rate = await checkRate(workspaceId);
    if (!rate.allowed) {
      return new Response(`Background scan throttled (${rate.reason}).`, {
        status: 429,
        headers: { 'retry-after': String(rate.retryAfterSec ?? 30) },
      });
    }
  }

  // Idle short-circuit: cached snapshot if trigger-state is unchanged AND
  // we're inside the 30 min TTL. Background only — manual rescans always
  // burn the LLM (user explicitly asked).
  if (isBackground) {
    try {
      const state = await readTriggerState();
      const fp = fingerprint(state);
      const snap = await canShortCircuit(fp);
      if (snap) {
        // Stream the cached cards as a degenerate scan response. Phase 5
        // polish: also stream `idle_status` with per-harness one-liners
        // so the panel can render a useful summary instead of just
        // showing N cached cards.
        const enc = new TextEncoder();
        const stream = new ReadableStream({
          start(controller) {
            const send = (event: string, data: Record<string, unknown>) => {
              controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
            };
            if (snap.perHarness && snap.perHarness.length > 0) {
              send('idle_status', { perHarness: snap.perHarness, computedAt: snap.computedAt });
            }
            for (const card of snap.cards) send('suggestion', card);
            send('done', { costUsd: 0, suggestions: snap.cards.length, cached: true });
            controller.close();
          },
        });
        return new Response(stream, {
          headers: {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache, no-transform',
            'connection': 'keep-alive',
            'x-operator-cached': '1',
          },
        });
      }
    } catch (err) {
      console.warn('[operator-scan] idle short-circuit unavailable:', err);
    }
  }

  const budget = await checkBudget();
  if (budget.state && budget.exceeded) {
    return new Response(
      `Operator daily budget reached (${budget.todaySpendUsd.toFixed(2)} of ${budget.capUsd}). Raise the cap in /settings/operator or wait until tomorrow.`,
      { status: 402 },
    );
  }

  // Multi-tab dedup: refuse if another holder has a fresh lock.
  let lock: { holderId: string };
  try {
    const acq = await acquireScanLock();
    if (!acq.acquired) {
      return new Response('Another scan is in progress for this workspace.', {
        status: 429,
        headers: { 'retry-after': String(acq.retryAfterSec ?? 30) },
      });
    }
    lock = { holderId: acq.holderId! };
  } catch (err) {
    // Migration not yet applied or PG transient — fail open with a hint.
    // This keeps dev environments unblocked until 014 is applied.
    console.warn('[operator-scan] scan-lock unavailable, proceeding without dedup:', err);
    lock = { holderId: '' };
  }

  const { promptText: basePromptText, isFirstRun } = await buildOperatorPrompt({ request: requestText, userId });
  const preferences = await loadPreferences();
  // Warm the plugin-tier cache so the (sync) parser can consult it
  // when classifying plugin-defined caps from this scan's suggestions.
  await resolvePluginAwareTier('__warm__').catch(() => {});
  await refreshDismissedFromPg().catch(() => {});

  // Phase 3: persistent scanner session + state bootstrap. Gated
  // behind OPERATOR_SCANNER_RESUME=1 until it stabilizes — the
  // baseline cold-start flow is unaffected when the env var is unset.
  const useResume = isScannerResumeEnabled();
  const scannerSessionId = useResume ? await getOrCreateScannerSessionId() : null;
  const bootstrap = useResume
    ? await buildScannerBootstrap({ workspaceId }).catch(() => '')
    : '';
  const promptText = bootstrap + basePromptText;

  // Persist a scan-history row so the Scan History tab can show this
  // run even if it errors. Best-effort: a DB hiccup shouldn't block
  // the user's scan from running.
  let scanHistoryId: number | null = null;
  try {
    scanHistoryId = await startOperatorScan({
      workspaceId,
      claudeSessionId: scannerSessionId,
      startedAt: new Date(),
      requestText: requestText.length > 1000 ? requestText.slice(0, 1000) + '…' : requestText,
    });
  } catch (e) {
    console.warn('[operator-scan] history-start failed:', e);
  }

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (event: string, data: Record<string, unknown>) => {
        controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      let costUsd = 0;
      let assistantText = '';
      let finalCards: Record<string, unknown>[] = [];

      if (isFirstRun) {
        send('first_run', {});
      }

      // Read the superuser token (commit 0ccac7cf) for ?superuser=1
      // bypass — operator-scan runs at chrome scope, not inside a
      // spawn, so there's no harness/run/spawn URL params to pass.
      let scanSuperuserToken: string | null = null;
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        scanSuperuserToken = require('node:fs').readFileSync(
          require('node:path').join(require('node:os').homedir(), '.papercusp', 'superuser-token'),
          'utf8',
        ).trim();
        if (!scanSuperuserToken || scanSuperuserToken.length < 16) scanSuperuserToken = null;
      } catch { scanSuperuserToken = null; }

      try {
        const events = runAgentChat({
          promptText,
          mcpConfig: scanSuperuserToken
            ? {
                mcpServers: {
                  agentmcp: {
                    // omp silently drops type:'http' MCP servers —
                    // bridge through mcp-remote (stdio→HTTP).
                    type: 'stdio',
                    command: 'npx',
                    args: [
                      '-y',
                      'mcp-remote@latest',
                      'http://127.0.0.1:3055/api/mcp?superuser=1',
                      '--header',
                      `Authorization:Bearer ${scanSuperuserToken}`,
                    ],
                  },
                },
              }
            : undefined,
          allowedTools: scanSuperuserToken ? [...ALL_AGENT_MCP_TOOLS] : [],
          toolEventFilter: (raw) =>
            raw.startsWith('mcp__agentmcp__') ? raw.replace(/^mcp__agentmcp__/, '') : null,
          permissionMode: 'bypassPermissions',
          // Phase 3: resume the workspace's persistent scanner session
          // so each scan can refer to prior turns. sessionMode 'force'
          // means create-or-resume — claude won't error if our uuid
          // doesn't yet have a session record.
          sessionId: scannerSessionId ?? undefined,
          sessionMode: scannerSessionId ? 'force' : undefined,
        });

        for await (const ev of events) {
          if (ev.type === 'delta') {
            assistantText += ev.text;
            send('delta', { text: ev.text });
          } else if (ev.type === 'tool_call') {
            send('tool_call', { name: ev.name, input: ev.input });
          } else if (ev.type === 'result') {
            costUsd = ev.costUsd;
            void recordSpend(costUsd);
            const parsed = await parseSuggestions(ev.finalText || assistantText, preferences);
            const cards: Record<string, unknown>[] = [];
            for (const block of parsed.blocks) {
              const payload = {
                ...block.suggestion.raw,
                actualTier: block.suggestion.actualTier,
                auto_dispatch: block.suggestion.auto_dispatch,
                provenanceFlags: block.suggestion.provenanceFlags,
              };
              cards.push(payload);
              send('suggestion', payload);
            }
            // Plugin-authored suggestions: enriched through the same
            // pipeline so tier-classification + auto_dispatch are
            // identical to LLM output.
            try {
              const pluginRaw = await gatherPluginSuggestions();
              for (const raw of pluginRaw) {
                const enriched = enrich(raw, preferences);
                const payload = {
                  ...enriched.raw,
                  actualTier: enriched.actualTier,
                  auto_dispatch: enriched.auto_dispatch,
                  provenanceFlags: { ...enriched.provenanceFlags, pluginAuthored: true },
                };
                cards.push(payload);
                send('suggestion', payload);
              }
            } catch (e) {
              console.warn('[operator-scan] plugin suggestions failed:', e);
            }
            finalCards = cards;
            try {
              await writeLastScan({
                scanCompletedAt: new Date().toISOString(),
                scanCostUsd: costUsd,
                cards,
              });
            } catch (e) {
              console.warn('[operator-scan] writeLastScan failed:', e);
            }
            // Refresh idle snapshot so a stable workspace can short-circuit
            // the next background scan. Persist per-harness one-liners
            // alongside so the cached path can stream them.
            try {
              const state = await readTriggerState();
              await writeSnapshot(fingerprint(state), cards, state.perHarness);
            } catch (e) {
              console.warn('[operator-scan] writeSnapshot failed:', e);
            }
            await recordSuccess(workspaceId);
            send('done', {
              costUsd,
              suggestions: parsed.blocks.length,
              parseErrors: parsed.parseErrors,
            });
          } else if (ev.type === 'error') {
            // Treat downstream 503-ish failures as breaker hits (background only).
            if (isBackground && /503|service unavailable|connection refused|ECONNREFUSED/i.test(ev.message)) {
              await record503(workspaceId);
            }
            send('error', { message: ev.message });
          }
        }
        if (isFirstRun) void markFirstRunShown(userId);
        // Finalize the history row on the happy path. The summary is
        // the trailing one-liner the scanner emits after the
        // <suggestion> blocks (the scanner.md role tells it to write
        // exactly that as a status line).
        if (scanHistoryId != null) {
          try {
            const summary = extractScanSummary(assistantText);
            await completeOperatorScan({
              id: scanHistoryId,
              endedAt: new Date(),
              summary,
              suggestions: finalCards,
              costUsd,
              claudeSessionId: scannerSessionId,
            });
          } catch (e) {
            console.warn('[operator-scan] history-complete failed:', e);
          }
        }
        if (scannerSessionId) void bumpScannerSession();
      } catch (err) {
        send('error', { message: err instanceof Error ? err.message : String(err) });
        if (scanHistoryId != null) {
          try {
            await failOperatorScan({
              id: scanHistoryId,
              endedAt: new Date(),
              error: err instanceof Error ? err.message : String(err),
            });
          } catch (e2) {
            console.warn('[operator-scan] history-fail failed:', e2);
          }
        }
      } finally {
        if (lock.holderId) await releaseScanLock(lock.holderId);
        controller.close();
      }
    },
    async cancel() {
      // Client closed the SSE — release the lock so a follow-up scan
      // doesn't block on the dead one until TTL.
      if (lock.holderId) await releaseScanLock(lock.holderId);
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      'connection': 'keep-alive',
    },
  });
}
