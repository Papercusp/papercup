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
import { sseResponse } from '@restart/sse';
import {
  dispatchProjectedToolStream,
  emitToSseSink,
  lookupByMcpName,
  type UnifiedToolContext,
} from '@papercusp/agent-mcp';
// Side-effect: registers operator:scan + the other operator-side tools.
import '@/lib/agent-tools/index';
import { papercuspPath } from '@/lib/papercusp-root';
import { activeWorkspaceId } from '@/lib/workspace-registry';
import { readSystemPrincipal } from '@/lib/system-principal';
import { getSessionUser } from '@/lib/auth';
import {
  buildOperatorPrompt,
  markFirstRunShown,
} from '@/lib/operator-prompt';
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
      agentSessionId: scannerSessionId,
      startedAt: new Date(),
      requestText: requestText.length > 1000 ? requestText.slice(0, 1000) + '…' : requestText,
    });
  } catch (e) {
    console.warn('[operator-scan] history-start failed:', e);
  }

  return sseResponse({
    signal: req.signal,
    setup: async (sink) => {
      sink.onClose(() => {
        if (lock.holderId) void releaseScanLock(lock.holderId);
      });

      if (isFirstRun) {
        sink.event('first_run', {});
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

      const operatorScanTool = lookupByMcpName('operator:scan');
      if (!operatorScanTool) {
        sink.event('error', { message: 'operator:scan tool not registered' });
        return;
      }

      // Synthesize a minimal UnifiedToolContext for the in-process call.
      // No principal — operator:scan is role-gated on `operator`, which
      // we set here. role/runId/spawnId populate tool_invocations rows
      // so the scanner's invocation is visible in audit.
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
        runId: scannerSessionId ?? `scan-${Date.now()}`,
        spawnId: scannerSessionId ?? `scan-${Date.now()}`,
        transport: 'in_process',
      };

      let costUsd = 0;
      let assistantText = '';
      let llmBlocks: Record<string, unknown>[] = [];
      let parseErrors = 0;

      try {
        for await (const ev of dispatchProjectedToolStream(
          operatorScanTool,
          'operator:scan',
          {
            promptText,
            superuserToken: scanSuperuserToken,
            scannerSessionId,
            preferencesJson: JSON.stringify(preferences),
          },
          ctxBase,
          {},
        )) {
          if (ev.kind === 'event') {
            // Forward all events. Mid-stream `error` events from the tool
            // (non-fatal runAgentChat yields) ALSO drive the 503 breaker.
            // emitToSseSink honors the tool's schema-inferred wire kind
            // so future z.string()/Uint8Array events Just Work.
            emitToSseSink(sink, operatorScanTool, ev.name, ev.data);
            if (ev.name === 'error' && isBackground) {
              const msg = (ev.data as { message?: string })?.message ?? '';
              if (/503|service unavailable|connection refused|ECONNREFUSED/i.test(msg)) {
                await record503(workspaceId);
              }
            }
          } else if (ev.kind === 'done') {
            // Tool result carries the post-stream stats the route needs
            // for plugin-suggestion merging + persistence.
            try {
              const text = (ev.result.content[0] as { text?: string })?.text ?? '{}';
              const out = JSON.parse(text) as {
                costUsd: number;
                assistantText: string;
                llmBlocks: Record<string, unknown>[];
                parseErrors: number;
              };
              costUsd = out.costUsd;
              assistantText = out.assistantText;
              llmBlocks = out.llmBlocks;
              parseErrors = out.parseErrors;
            } catch (e) {
              console.warn('[operator-scan] tool result parse failed:', e);
            }
          } else if (ev.kind === 'error') {
            sink.event('error', { message: ev.error.message });
            if (scanHistoryId != null) {
              try {
                await failOperatorScan({
                  id: scanHistoryId,
                  endedAt: new Date(),
                  error: ev.error.message,
                });
              } catch (e2) {
                console.warn('[operator-scan] history-fail failed:', e2);
              }
            }
            return;
          }
        }

        // Post-stream: spend, plugin suggestions, persistence.
        void recordSpend(costUsd);

        const finalCards: Record<string, unknown>[] = [...llmBlocks];
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
            finalCards.push(payload);
            sink.event('suggestion', payload);
          }
        } catch (e) {
          console.warn('[operator-scan] plugin suggestions failed:', e);
        }

        try {
          await writeLastScan({
            scanCompletedAt: new Date().toISOString(),
            scanCostUsd: costUsd,
            cards: finalCards,
          });
        } catch (e) {
          console.warn('[operator-scan] writeLastScan failed:', e);
        }
        try {
          const state = await readTriggerState();
          await writeSnapshot(fingerprint(state), finalCards, state.perHarness);
        } catch (e) {
          console.warn('[operator-scan] writeSnapshot failed:', e);
        }
        await recordSuccess(workspaceId);
        sink.done({
          costUsd,
          suggestions: finalCards.length,
          parseErrors,
        });

        if (isFirstRun) void markFirstRunShown(userId);
        if (scanHistoryId != null) {
          try {
            const summary = extractScanSummary(assistantText);
            await completeOperatorScan({
              id: scanHistoryId,
              endedAt: new Date(),
              summary,
              suggestions: finalCards,
              costUsd,
              agentSessionId: scannerSessionId,
            });
          } catch (e) {
            console.warn('[operator-scan] history-complete failed:', e);
          }
        }
        if (scannerSessionId) void bumpScannerSession();
      } catch (err) {
        sink.event('error', { message: err instanceof Error ? err.message : String(err) });
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
      }
    },
  });
}
