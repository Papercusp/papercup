/**
 * operator:scan — the operator workspace scanner.
 *
 * Self-contained: this tool owns the full scan lifecycle from
 * lock-acquire through scan-tracker persistence, plugin-suggestion
 * merging, and idle-snapshot writeback. The HTTP route at
 * `/api/agent-mcp/operator-scan` is a thin shim that:
 *   1. Resolves the operator principal + workspaceId
 *   2. Enforces HTTP-shaped rate limits (429-only — DoS protection)
 *   3. Optionally short-circuits an idle scan with the cached snapshot
 *      (cheap cache hit; can't be done from inside SSE response)
 *   4. Reads the superuser token from disk
 *   5. Dispatches into this tool and forwards events
 *
 * Originally split: the route owned everything bookkeeping-related
 * and dispatched a "streaming chat core" into this tool. Round 1 of
 * the audit flagged that as a real safety gap once IPC was wired —
 * an IPC caller of operator:scan would bypass every safety check.
 * This refactor closes that gap.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { runAgentChat } from '../../agent-chat-stream';
import { surfaceBackend, surfaceModel } from '../../agent-config';
import { selfUrl } from '../../self-url';
import { parseSuggestions, enrich } from '../../operator-suggestion-parser';
import { loadPreferences, type OperatorPreferences } from '../../operator-preferences';
import { NON_INTERACTIVE_AGENT_MCP_TOOLS } from '../../operator-mcp-tools';
import { buildOperatorPrompt, markFirstRunShown } from '../../operator-prompt';
import { acquireScanLock, releaseScanLock } from '../../operator-scan-lock';
import { checkBudget, recordSpend } from '../../operator-budget';
import { writeLastScan } from '../../operator-last-scan';
import { startOperatorScan, completeOperatorScan, failOperatorScan } from '../../operator-scans';
import {
  isScannerResumeEnabled,
  getOrCreateScannerSessionId,
  bumpScannerSession,
} from '../../operator-scanner-session';
import { buildScannerBootstrap } from '../../operator-scanner-bootstrap';
import { record503, recordSuccess } from '../../operator-rate-limit';
import { writeSnapshot } from '../../operator-idle-snapshot';
import { fingerprint, readTriggerState } from '../../operator-trigger-state';
import { resolvePluginAwareTier } from '../../operator-plugin-tier';
import { gatherPluginSuggestions } from '../../operator-plugin-suggestions';

const ArgsSchema = z.object({
  /** User's free-form scan request. The tool wraps it with the base
   *  operator system prompt. */
  requestText: z.string(),
  /** Background scan? Drives the 503 breaker + auto-archival policy
   *  but doesn't otherwise change behavior in the tool. */
  background: z.boolean().default(false),
  /** User id for first-run tracking + audit. 'anonymous' is fine. */
  userId: z.string().default('anonymous'),
  /** Superuser bearer token (read by the route from
   *  ~/.papercusp/superuser-token). null = no MCP tools available. */
  superuserToken: z.string().nullable(),
});

type Args = z.infer<typeof ArgsSchema>;

interface SuggestionPayload {
  [k: string]: unknown;
  actualTier: unknown;
  auto_dispatch: unknown;
  provenanceFlags: unknown;
}

/**
 * Pull the scanner's trailing one-line status out of the assistant
 * text. The scanner.md role tells it to write exactly that after the
 * <suggestion> blocks. Cap at 280 chars for the History view.
 */
function extractScanSummary(text: string): string | null {
  if (!text) return null;
  const stripped = text.replace(/<suggestion>[\s\S]*?<\/suggestion>/g, '').trim();
  if (!stripped) return null;
  const lines = stripped.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1] ?? null;
  if (!last) return null;
  return last.length > 280 ? last.slice(0, 277) + '…' : last;
}

export default defineTool({
  name: 'operator:scan',
  expose: { ipc: true },
  profile: 'engineer',
  description:
    'Operator workspace scanner: acquires the per-workspace lock, runs the scanner LLM, parses + emits suggestion blocks, merges plugin-emitted suggestions, persists everything to scan history + idle snapshot, and releases the lock. Self-contained — safe to call from any transport.',
  capability: 'operator:scan',
  requirePrincipal: false,
  agentRoles: ['operator'],
  timeoutSec: 600,
  idleTimeoutSec: 120,
  // Phase 4 T2.2 — opt into replay buffer. 5000 events is a
  // generous soft cap; eviction warn-logs let us tune down once
  // migration 066's event_count column has p99 data.
  replayBufferSize: 5000,
  args: ArgsSchema,
  events: {
    first_run: z.object({}),
    delta: z.object({ text: z.string() }),
    tool_call: z.object({ name: z.string(), input: z.unknown() }),
    suggestion: z.record(z.unknown()),
    /** Mid-stream error from runAgentChat. Non-fatal — handler keeps
     *  reading. Carries an optional code; 503-flavored messages set
     *  code='upstream_503' so the route can drive its breaker. */
    error: z.object({ message: z.string(), code: z.string().optional() }),
  },
  handler: async (input: Args, ctx) => {
    const workspaceId = ctx.workspaceId ?? 'default';

    // ── Pre-LLM safety ────────────────────────────────────────────
    // Budget check moved into the tool so IPC callers can't bypass it.
    // Surfaces as a typed error event; route turns no HTTP code (already
    // inside SSE). Frontend reads `code` to render a budget-specific UX.
    const budget = await checkBudget();
    if (budget.state && budget.exceeded) {
      ctx.emit('error', {
        message: `Papercup daily budget reached (${budget.todaySpendUsd.toFixed(2)} of ${budget.capUsd}). Raise the cap in /settings/operator or wait until tomorrow.`,
        code: 'budget_exhausted',
      });
      throw new Error(`budget_exhausted: ${budget.todaySpendUsd}/${budget.capUsd}`);
    }

    // Multi-tab dedup — only one scan at a time per workspace.
    let lockHolderId = '';
    try {
      const acq = await acquireScanLock();
      if (!acq.acquired) {
        ctx.emit('error', {
          message: 'Another scan is in progress for this workspace.',
          code: 'scan_in_progress',
        });
        throw new Error(`scan_in_progress: retry after ${acq.retryAfterSec ?? 30}s`);
      }
      lockHolderId = acq.holderId!;
    } catch (err) {
      // PG migration not yet applied / transient — fail open in dev.
      // eslint-disable-next-line no-console
      console.warn('[operator:scan] scan-lock unavailable, proceeding without dedup:', err);
    }

    // From here on we hold the lock — make sure to release it.
    try {
      const { promptText: basePromptText, isFirstRun } = await buildOperatorPrompt({
        request: input.requestText,
        userId: input.userId,
      });
      const preferences: OperatorPreferences = await loadPreferences();
      await resolvePluginAwareTier('__warm__').catch(() => {});

      const useResume = isScannerResumeEnabled();
      const scannerSessionId = useResume ? await getOrCreateScannerSessionId() : null;
      const bootstrap = useResume
        ? await buildScannerBootstrap({ workspaceId }).catch(() => '')
        : '';
      const promptText = bootstrap + basePromptText;

      // Open the scan-history row.
      let scanHistoryId: number | null = null;
      try {
        scanHistoryId = await startOperatorScan({
          workspaceId,
          agentSessionId: scannerSessionId,
          startedAt: new Date(),
          requestText: input.requestText.length > 1000
            ? input.requestText.slice(0, 1000) + '…'
            : input.requestText,
        });
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[operator:scan] history-start failed:', e);
      }

      if (isFirstRun) ctx.emit('first_run', {});

      // ── LLM stream ──────────────────────────────────────────────
      let costUsd = 0;
      let assistantText = '';
      const llmBlocks: SuggestionPayload[] = [];
      let parseErrors = 0;

      // per-surface backend override (/settings/agent); undefined → global
      const scannerBackend = await surfaceBackend('scanner');
      const scannerModel = await surfaceModel('scanner'); // OQ3: undefined → backend default
      try {
        for await (const ev of runAgentChat({
          promptText,
          ...(scannerModel ? { model: scannerModel } : {}),
          backend: scannerBackend,
          mcpConfig: input.superuserToken
            ? {
                mcpServers: {
                  // Direct HTTP MCP — same shape operator:converse moved
                  // to at 1083bfaf (2026-05-21). The old `npx
                  // mcp-remote@latest` stdio bridge added a cold
                  // npm-resolve + a proxy subprocess per scan and was the
                  // flaky empty-turn culprit; the hardcoded :3055 also
                  // dead-ended on the packaged desktop, whose operator
                  // sidecar binds a dynamic port (never 3055), so the
                  // scanner's tools never connected and it surfaced no
                  // suggestions. selfUrl() resolves the host's own port
                  // in dev (:3070) and the desktop sidecar port.
                  // workspace= is required for state-channel scoping.
                  agentmcp: {
                    type: 'http',
                    url: `${selfUrl()}/api/mcp?superuser=1&workspace=${encodeURIComponent(workspaceId)}`,
                    headers: { Authorization: `Bearer ${input.superuserToken}` },
                  },
                },
              }
            : undefined,
          allowedTools: input.superuserToken ? [...NON_INTERACTIVE_AGENT_MCP_TOOLS] : [],
          toolEventFilter: (raw) =>
            raw.startsWith('mcp__agentmcp__') ? raw.replace(/^mcp__agentmcp__/, '') : null,
          permissionMode: 'bypassPermissions',
          sessionId: scannerSessionId ?? undefined,
          sessionMode: scannerSessionId ? 'force' : undefined,
          signal: ctx.signal,
        })) {
          if (ev.type === 'delta') {
            assistantText += ev.text;
            ctx.emit('delta', { text: ev.text });
          } else if (ev.type === 'tool_call') {
            ctx.emit('tool_call', { name: ev.name, input: ev.input });
          } else if (ev.type === 'result') {
            costUsd = ev.costUsd;
            const parsed = await parseSuggestions(ev.finalText || assistantText, preferences);
            parseErrors = parsed.parseErrors;
            for (const block of parsed.blocks) {
              const payload: SuggestionPayload = {
                ...block.suggestion.raw,
                actualTier: block.suggestion.actualTier,
                auto_dispatch: block.suggestion.auto_dispatch,
                provenanceFlags: block.suggestion.provenanceFlags,
              };
              llmBlocks.push(payload);
              ctx.emit('suggestion', payload);
            }
          } else if (ev.type === 'error') {
            // 503 breaker: tag the error code so the route (or any
            // future telemetry sink) can act on upstream failures.
            const is503 =
              /503|service unavailable|connection refused|ECONNREFUSED/i.test(ev.message);
            ctx.emit('error', {
              message: ev.message,
              ...(is503 ? { code: 'upstream_503' } : {}),
            });
            if (is503 && input.background) {
              await record503(workspaceId).catch(() => {});
            }
          }
        }
      } catch (llmErr) {
        // runAgentChat hard-failed (subprocess crash, etc.). Close the
        // scan-tracker row as failed before bubbling.
        if (scanHistoryId != null) {
          try {
            await failOperatorScan({
              id: scanHistoryId,
              endedAt: new Date(),
              error: llmErr instanceof Error ? llmErr.message : String(llmErr),
            });
          } catch (e2) {
            // eslint-disable-next-line no-console
            console.warn('[operator:scan] history-fail failed:', e2);
          }
        }
        throw llmErr;
      }

      // ── Post-stream persistence ────────────────────────────────
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
          ctx.emit('suggestion', payload);
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[operator:scan] plugin suggestions failed:', e);
      }

      try {
        await writeLastScan({
          scanCompletedAt: new Date().toISOString(),
          scanCostUsd: costUsd,
          cards: finalCards,
        });
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[operator:scan] writeLastScan failed:', e);
      }
      try {
        const state = await readTriggerState();
        await writeSnapshot(fingerprint(state), finalCards, state.perHarness);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[operator:scan] writeSnapshot failed:', e);
      }
      await recordSuccess(workspaceId).catch(() => {});

      if (isFirstRun) void markFirstRunShown(input.userId);
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
          // eslint-disable-next-line no-console
          console.warn('[operator:scan] history-complete failed:', e);
        }
      }
      if (scannerSessionId) void bumpScannerSession();

      // Tool result carries the post-stream stats the route surfaces
      // as `sink.done({...})` so the operator panel can show totals.
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              costUsd,
              suggestions: finalCards.length,
              parseErrors,
            }),
          },
        ],
      };
    } finally {
      // Guaranteed lock release — even on throw before the post-stream
      // persistence completed.
      if (lockHolderId) {
        void releaseScanLock(lockHolderId).catch(() => {});
      }
    }
  },
});
