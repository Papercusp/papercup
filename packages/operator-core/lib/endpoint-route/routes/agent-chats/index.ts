/**
 * /api/harness/:slug/agent-chats — multi-turn conversational sessions
 * with role-scoped agents. Phase A2 (endpoint-hono-elimination-2026-05-21).
 * Ported off `_hono/agent-chats.ts` (mounted via `registerAgentChats`).
 * URLs unchanged.
 *
 *   GET    /api/harness/:slug/agent-chats
 *   POST   /api/harness/:slug/agent-chats
 *   GET    /api/harness/:slug/agent-chats/:chatId
 *   DELETE /api/harness/:slug/agent-chats/:chatId
 *   POST   /api/harness/:slug/agent-chats/:chatId/messages   → SSE stream
 *
 * `auth: 'public'` — the legacy `harness` sub-app gated none of these.
 */
import { join } from 'node:path';
import { sseResponse } from '@papercusp/sse';
import { dispatchProjectedToolStream, lookupByMcpName } from '@papercusp/agent-mcp';
import { getLegacyClient } from '@papercusp/db-org';
import { assembleRolePrompt } from '@papercusp/orchestrator/role-prompt';
import { getPromptOverride } from '../../../harness-prompt-overrides';
import { defineTool } from '@papercusp/agent-mcp';
import { activeWorkspaceId } from '../../../workspace-registry';
import { buildMemoryContextBlock } from '../../../memory/injection';
import { projectDirForSlug } from '../../../operator-notes';
import {
  readFeatureLockState,
  rowToChat,
  type ChatRow,
  type TranscriptTurn,
} from '../../../agent-chats-data';
import '../../../agent-tools/index';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Per-chat in-memory lock. A second message POST while a prior one is
 * streaming returns 409 — prevents duplicate spawn-and-append races.
 */
const activeChats = new Map<string, { startedAt: number }>();

function dbForSlug(slug: string) {
  return getLegacyClient(slug);
}

/** Per-harness chat cost cap from the effective harness config (blueprint ⊕
 *  workspace-PG instance — `deprecate-harness-config-json-2026-06-06`). */
async function readChatCostCap(slug: string): Promise<{ perChatUsd?: number; aggregateUsd?: number }> {
  try {
    const { loadHarnessRegistry } = require('../../../harness-registry') as typeof import('../../../harness-registry');
    const { activeWorkspaceId } = require('../../../workspace-registry') as typeof import('../../../workspace-registry');
    const { readEffectiveHarnessConfig } = require('../../../harness-effective-config') as typeof import('../../../harness-effective-config');
    const projectDir = (await loadHarnessRegistry()).projects.find((p) => p.slug === slug)?.path ?? null;
    if (!projectDir) return {};
    const cfg = await readEffectiveHarnessConfig(slug, activeWorkspaceId(), projectDir);
    const out: { perChatUsd?: number; aggregateUsd?: number } = {};
    if (typeof cfg.maxChatCostUsd === 'number' && cfg.maxChatCostUsd > 0) out.perChatUsd = cfg.maxChatCostUsd;
    if (typeof cfg.maxAggregateChatCostUsd === 'number' && cfg.maxAggregateChatCostUsd > 0) {
      out.aggregateUsd = cfg.maxAggregateChatCostUsd;
    }
    return out;
  } catch {
    return {};
  }
}

/** Strict-mode lock policy — default false (soft-warn). */
async function readChatLockPolicy(slug: string): Promise<boolean> {
  try {
    const { loadHarnessRegistry } = require('../../../harness-registry') as typeof import('../../../harness-registry');
    const { activeWorkspaceId } = require('../../../workspace-registry') as typeof import('../../../workspace-registry');
    const { readEffectiveHarnessConfig } = require('../../../harness-effective-config') as typeof import('../../../harness-effective-config');
    const projectDir = (await loadHarnessRegistry()).projects.find((p) => p.slug === slug)?.path ?? null;
    if (!projectDir) return false;
    const cfg = await readEffectiveHarnessConfig(slug, activeWorkspaceId(), projectDir);
    const parallelChat = cfg.parallelChat as Record<string, unknown> | undefined;
    return parallelChat?.respectFeatureLocks === true;
  } catch {
    return false;
  }
}

/** Sum of cents across all non-archived chats in this harness. */
async function aggregateChatCostCents(slug: string): Promise<number> {
  try {
    const db = dbForSlug(slug);
    const row = (await db
      .prepare('SELECT COALESCE(SUM(total_cost_usd_cents), 0)::bigint AS total FROM agent_chats WHERE archived_at IS NULL')
      .get()) as { total: number | bigint };
    return typeof row.total === 'bigint' ? Number(row.total) : (row.total ?? 0);
  } catch {
    return 0;
  }
}

const listChatsRoute = defineTool({
  method: 'GET',
  path: '/harness/:slug/agent-chats',
  auth: 'public',
  async handler(req, ctx) {
    const { listChats } = await import('../../../agent-chats-data');
    const result = await listChats({
      slug: ctx.params.slug,
      includeArchived: new URL(req.url).searchParams.get('include') === 'archived',
    });
    if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
    return Response.json(result.data);
  },
});

const createChatRoute = defineTool({
  method: 'POST',
  path: '/harness/:slug/agent-chats',
  auth: 'loopback',
  async handler(req, ctx) {
    const { createChat } = await import('../../../agent-chats-data');
    let body: { role?: string; feature_id?: string; title?: string };
    try { body = await req.json(); } catch { return Response.json({ error: 'invalid JSON body' }, { status: 400 }); }
    const result = await createChat({
      slug: ctx.params.slug,
      role: body.role ?? '',
      feature_id: body.feature_id,
      title: body.title,
    });
    if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
    return Response.json(result.data, { status: 201 });
  },
});

const getChatRoute = defineTool({
  method: 'GET',
  path: '/harness/:slug/agent-chats/:chatId',
  auth: 'public',
  async handler(_req, ctx) {
    const { getChat } = await import('../../../agent-chats-data');
    const result = await getChat({ slug: ctx.params.slug, chatId: ctx.params.chatId });
    if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
    return Response.json(result.data);
  },
});

const archiveChatRoute = defineTool({
  method: 'DELETE',
  path: '/harness/:slug/agent-chats/:chatId',
  auth: 'loopback',
  async handler(_req, ctx) {
    const { archiveChat } = await import('../../../agent-chats-data');
    const result = await archiveChat({ slug: ctx.params.slug, chatId: ctx.params.chatId });
    if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
    return Response.json(result.data);
  },
});

const messagesRoute = defineTool({
  method: 'POST',
  path: '/harness/:slug/agent-chats/:chatId/messages',
  auth: 'loopback',
  // Pure SSE transport — don't flood route_invocations per chat turn.
  sampleRate: 0,
  async handler(req, ctx) {
    const slug = ctx.params.slug;
    const chatId = ctx.params.chatId;
    let body: { content?: string; mode?: string };
    try { body = await req.json(); } catch { return Response.json({ error: 'invalid JSON body' }, { status: 400 }); }
    const userContent = (body.content ?? '').trim();
    if (!userContent) return Response.json({ error: 'content is required' }, { status: 400 });

    if (activeChats.has(chatId)) {
      return Response.json({ error: 'chat already has an in-flight assistant response' }, { status: 409 });
    }

    let chat: ChatRow;
    try {
      const db = dbForSlug(slug);
      const row = (await db.prepare('SELECT * FROM agent_chats WHERE id = ?').get(chatId)) as any;
      if (!row) return Response.json({ error: 'chat not found' }, { status: 404 });
      chat = rowToChat(row);
      if (chat.archived_at) return Response.json({ error: 'chat is archived' }, { status: 410 });
    } catch (e) {
      return Response.json({ error: `failed to load chat: ${(e as Error).message}` }, { status: 500 });
    }

    // Cost-cap checks — per-chat + aggregate.
    const cap = await readChatCostCap(slug);
    if (cap.perChatUsd !== undefined && chat.total_cost_usd_cents >= cap.perChatUsd * 100) {
      return Response.json({
        error: 'per-chat cost cap reached',
        chat_cost_usd: chat.total_cost_usd_cents / 100,
        cap_usd: cap.perChatUsd,
        hint: 'increase config.json `maxChatCostUsd` or archive this chat',
      }, { status: 402 });
    }
    if (cap.aggregateUsd !== undefined) {
      const aggCents = await aggregateChatCostCents(slug);
      if (aggCents >= cap.aggregateUsd * 100) {
        return Response.json({
          error: 'aggregate chat cost cap reached for this harness',
          aggregate_cost_usd: aggCents / 100,
          cap_usd: cap.aggregateUsd,
          hint: 'increase config.json `maxAggregateChatCostUsd` or archive other chats',
        }, { status: 402 });
      }
    }

    // Concurrency awareness — feature-lock state for the prompt notice / strict gate.
    const featureLock = chat.feature_id ? await readFeatureLockState(slug, chat.feature_id) : null;
    if (featureLock?.active) {
      const respectLocks = await readChatLockPolicy(slug);
      if (respectLocks) {
        return Response.json({
          error: 'feature_locked',
          feature_id: chat.feature_id,
          taken_by: featureLock.taken_by,
          taken_at: featureLock.taken_at,
          expires_at: featureLock.expires_at,
          hint: `Feature is currently being worked on autonomously by ${featureLock.taken_by}. Wait for the lock to release, or drop a note via POST /api/harness/${slug}/features/${chat.feature_id}/notes if you want guidance picked up on the next worker tick. Disable strict mode by removing parallelChat.respectFeatureLocks from .papercusp/config.json.`,
        }, { status: 409 });
      }
    }

    // Append the user turn before streaming so a client reload sees it.
    const userTurn: TranscriptTurn = { role: 'user', content: userContent, ts: new Date().toISOString() };
    const baseTranscript = [...chat.transcript, userTurn];
    try {
      const db = dbForSlug(slug);
      await db.prepare(`UPDATE agent_chats SET transcript = ?::jsonb, updated_at = ? WHERE id = ?`)
        .run(JSON.stringify(baseTranscript), Date.now(), chatId);
    } catch (e) {
      return Response.json({ error: `failed to persist user turn: ${(e as Error).message}` }, { status: 500 });
    }

    // Resolve the project dir IN-PROCESS (workspace-aware, live registry)
    // BEFORE assembly. Without it the assembler falls back to its
    // workspace-blind `lookupProjectDir`, which curls the operator base
    // (default :3055 — not an API port) mid-request and then the legacy
    // ~/.restart-harness-projects.json — so any harness that exists only in
    // the live registry fails to assemble (same class as role-launch-spec
    // step 0 / EI-220).
    const projectDir = await projectDirForSlug(slug);
    if (!projectDir) {
      return Response.json({
        error: `harness "${slug}" is not registered in workspace "${activeWorkspaceId()}"`,
      }, { status: 404 });
    }

    // Assemble the role prompt + transcript history.
    let assembled: { text: string; runId: string };
    try {
      // Workspace-owned prompt override (D-7), best-effort (miss → default).
      let chatOverride: string | undefined;
      try {
        chatOverride = (await getPromptOverride(activeWorkspaceId(), slug, chat.role)) ?? undefined;
      } catch { /* fall back to config.json default */ }
      const r = assembleRolePrompt({
        slug,
        role: chat.role,
        projectDir,
        featureId: chat.feature_id ?? undefined,
        // 'discuss' (client sends it per message) reframes the worker to
        // advise-first; anything else is the default interactive chat.
        mode: body.mode === 'discuss' ? 'discuss' : 'chat',
        promptOverrideText: chatOverride,
      });
      const lockNotice = featureLock?.active
        ? `\n---\n\n## ⚠ Concurrent autonomous run\n\nFeature ${chat.feature_id} is currently being worked on autonomously (taken_by=${featureLock.taken_by}, taken_at=${featureLock.taken_at}). The autonomous loop holds the worktree lock; you do not. **Do not propose code changes**; the user is asking you for advice or context. If they want guidance the autonomous worker should pick up, tell them to add a note (it lands in \`.papercusp/notes/${chat.feature_id}.md\`, which the next worker tick reads).\n`
        : '';
      const historyBlock = baseTranscript.length > 1
        ? '\n---\n\n## Conversation history\n\n' +
          baseTranscript.slice(0, -1).map((t) => `${t.role === 'user' ? 'User' : 'You (assistant)'}: ${t.content}`).join('\n\n') +
          '\n'
        : '';
      const memBlock = await buildMemoryContextBlock({
        userId: null,
        workspaceId: activeWorkspaceId(),
        queryContext: `${chat.role} agent: ${userContent}`,
        heading: 'Agent memory (relevant entries)',
      }).catch(() => null);
      const memorySection = memBlock ? `\n---\n\n${memBlock}\n` : '';

      // Plan context — inject for worker/validator/reviewer roles on
      // plan-derived features. Best-effort; 3 s timeout; empty on miss.
      const CHAT_PLAN_ROLES = new Set(['worker', 'validator', 'reviewer']);
      let planContextSection = '';
      if (CHAT_PLAN_ROLES.has(chat.role) && chat.feature_id) {
        try {
          const { getPlanContextForFeature } = await import('../../../plan-context-for-feature');
          const planCtx = await getPlanContextForFeature(slug, chat.feature_id);
          if (planCtx) planContextSection = `\n---\n\n${planCtx.section}\n`;
        } catch { /* best-effort */ }
      }

      const promptText = `${r.text}${lockNotice}${planContextSection}${memorySection}${historyBlock}\n---\n\n## User\n\n${userContent}\n`;
      assembled = { text: promptText, runId: r.meta.runId };
    } catch (e) {
      return Response.json({ error: `failed to assemble prompt: ${(e as Error).message}` }, { status: 500 });
    }

    activeChats.set(chatId, { startedAt: Date.now() });

    const tool = lookupByMcpName('agent_chats:chat');
    if (!tool) {
      activeChats.delete(chatId);
      return Response.json({ error: 'agent_chats:chat tool not registered' }, { status: 500 });
    }

    // EI-259: a chat turn is a real agent invocation — track it in the durable
    // nursery (harness_shared.spawned_agents) like every other spawn path, so
    // it shows in fleet:tree / intel:spawn_tree and counts a provider slot.
    // Best-effort: tracking failure never blocks the chat (null ⇒ untracked).
    const { beginChatSpawnTracking, resolveChatRunOutcome } =
      await import('../../../fleet/chat-spawn-tracking');
    const spawnTracking = await beginChatSpawnTracking({
      chatId,
      workspaceId: activeWorkspaceId(),
      harnessSlug: slug,
      childRole: chat.role,
      runId: assembled.runId,
      featureId: chat.feature_id ?? null,
      projectDir,
    });

    return sseResponse({
      signal: req.signal,
      setup: async (sink) => {
        let assistantText = '';
        let tokensIn = 0;
        let tokensOut = 0;
        let costUsd = 0;
        let lastErrorMessage: string | null = null;
        let lastErrorStderr: string | undefined;
        let toolError: { code: string; message: string } | null = null;
        let sawDone = false;
        let threwMessage: string | null = null;

        try {
          const dispatchCtx = {
            workspaceId: activeWorkspaceId(),
            harnessSlug: slug,
            role: 'operator' as const,
            runId: assembled.runId,
            spawnId: spawnTracking?.spawnId ?? `agent_chats-${chatId}`,
            log: () => { /* */ },
            progress: () => { /* */ },
            emit: () => { /* overridden by dispatcher */ },
            signal: req.signal,
            spawn: async () => { throw new Error('spawn not available in agent_chats shim'); },
            secret: async () => null,
            projectDir: projectDir ?? '',
            stateDir: '',
          };

          for await (const ev of dispatchProjectedToolStream(
            tool,
            'agent_chats:chat',
            { promptText: assembled.text, cwd: projectDir ?? undefined },
            dispatchCtx as never,
            {},
          )) {
            if (ev.kind === 'event') {
              if (ev.name === 'delta') {
                const text = (ev.data as { text?: string })?.text ?? '';
                assistantText += text;
                sink.event('delta', { text });
              } else if (ev.name === 'error') {
                const d = ev.data as { message?: string; stderr?: string };
                lastErrorMessage = d.message ?? 'unknown error';
                lastErrorStderr = d.stderr;
              }
            } else if (ev.kind === 'done') {
              sawDone = true;
              try {
                const blob = ev.result?.content?.[0];
                if (blob && 'text' in blob && typeof blob.text === 'string') {
                  const parsed = JSON.parse(blob.text) as {
                    finalText?: string; tokensIn?: number; tokensOut?: number; costUsd?: number;
                  };
                  if (parsed.finalText && parsed.finalText.length > assistantText.length) {
                    assistantText = parsed.finalText;
                  }
                  tokensIn = parsed.tokensIn ?? 0;
                  tokensOut = parsed.tokensOut ?? 0;
                  costUsd = parsed.costUsd ?? 0;
                }
              } catch { /* malformed tool result — keep what we accumulated */ }
            } else if (ev.kind === 'error') {
              toolError = ev.error;
            }
          }
        } catch (e) {
          threwMessage = e instanceof Error ? e.message : String(e);
          throw e;
        } finally {
          activeChats.delete(chatId);
          if (spawnTracking) {
            const outcome = resolveChatRunOutcome({
              sawDone,
              toolErrorMessage: toolError?.message ?? null,
              lastErrorMessage,
              threwMessage,
              aborted: req.signal.aborted,
            });
            await spawnTracking.finish({
              ...outcome,
              outputTail: assistantText ? assistantText.slice(-400) : null,
            });
          }
        }

        // A turn that failed (rate-limit, backend/dispatch error) persists a
        // failure-marker assistant turn — otherwise the transcript keeps only the
        // user turn and a reload / second viewer sees a silent gap. The live
        // sender ALSO gets the inline error event below. Best-effort: a persist
        // failure must not swallow the error signal itself.
        const failureMessage = toolError?.message ?? lastErrorMessage;
        if (failureMessage) {
          const failureTurn: TranscriptTurn = {
            role: 'assistant',
            content: failureMessage,
            ts: new Date().toISOString(),
            tokens_in: 0,
            tokens_out: 0,
            cost_cents: 0,
            error: true,
          };
          try {
            const db = dbForSlug(slug);
            await db.prepare(`UPDATE agent_chats SET transcript = ?::jsonb, updated_at = ? WHERE id = ?`)
              .run(JSON.stringify([...baseTranscript, failureTurn]), Date.now(), chatId);
          } catch { /* best-effort — still emit the error event */ }
          sink.event('error', { message: failureMessage, ...(lastErrorStderr ? { stderr: lastErrorStderr } : {}) });
          sink.close();
          return;
        }

        const finalAssistantTurn: TranscriptTurn = {
          role: 'assistant',
          content: assistantText,
          ts: new Date().toISOString(),
          tokens_in: tokensIn,
          tokens_out: tokensOut,
          cost_cents: Math.round(costUsd * 100),
        };
        const finalTranscript = [...baseTranscript, finalAssistantTurn];

        try {
          const db = dbForSlug(slug);
          await db.prepare(
            `UPDATE agent_chats
               SET transcript = ?::jsonb,
                   total_input_tokens = total_input_tokens + ?,
                   total_output_tokens = total_output_tokens + ?,
                   total_cost_usd_cents = total_cost_usd_cents + ?,
                   updated_at = ?
             WHERE id = ?`,
          ).run(
            JSON.stringify(finalTranscript),
            tokensIn,
            tokensOut,
            finalAssistantTurn.cost_cents ?? 0,
            Date.now(),
            chatId,
          );
        } catch (e) {
          sink.event('error', { message: `failed to persist assistant turn: ${(e as Error).message}` });
          sink.close();
          return;
        }

        sink.event('done', {
          run_id: assembled.runId,
          tokens_in: tokensIn,
          tokens_out: tokensOut,
          cost_cents: finalAssistantTurn.cost_cents,
        });
        sink.close();
      },
    });
  },
});

export default [listChatsRoute, createChatRoute, getChatRoute, archiveChatRoute, messagesRoute];
