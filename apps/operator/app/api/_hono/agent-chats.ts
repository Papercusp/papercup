/**
 * /api/harness/:slug/agent-chats — multi-turn conversational sessions with
 * role-scoped agents.
 *
 * Phase B "Pair" primitive. Each chat is a transcript stored in the
 * per-harness `agent_chats` table; on each user message the server
 * assembles the role's full prompt (same as autonomous dispatches via
 * `assembleRolePrompt`) plus the prior transcript, spawns the agent CLI
 * via `runAgentChat` (backend-aware: omp -p by default, claude -p when
 * AGENT_BACKEND=claude-code), and streams the response back via SSE.
 *
 * Side-channel design: chat agents read state and may write supervisor
 * notes, but do NOT mutate the worktree or feature rows directly. The
 * autonomous loop remains authoritative — chats inform it via notes.
 *
 * Endpoints:
 *   GET    /:slug/agent-chats                       → list (excludes archived)
 *   POST   /:slug/agent-chats                       body: { role, feature_id?, title? }
 *   GET    /:slug/agent-chats/:chatId               → { id, role, transcript, ... }
 *   POST   /:slug/agent-chats/:chatId/messages      body: { content } → SSE stream
 *   DELETE /:slug/agent-chats/:chatId               → archive (sets archived_at)
 */
import type { Hono } from 'hono';
import { sseResponse } from '@restart/sse';
import { dispatchProjectedToolStream, lookupByMcpName } from '@papercusp/agent-mcp';
import { existsSync, readFileSync } from 'node:fs';
import { notifySyncInvalidate } from '@/lib/sync-sse';
import { join } from 'node:path';
import { getLegacyClient } from '@restart/db-org';
import { assembleRolePrompt } from '@papercusp/orchestrator/role-prompt';
import { activeWorkspaceId } from '@/lib/workspace-registry';
import { buildMemoryContextBlock } from '@/lib/memory/injection';
import '@/lib/agent-tools/index';
import {
  readFeatureLockState,
  rowToChat,
  type ChatRow,
  type TranscriptTurn,
} from '@/lib/agent-chats-data';
import { projectDirForSlug } from '../../../lib/operator-notes';

/**
 * Per-chat in-memory lock. A second message POST while a prior one is
 * streaming returns 409. Prevents duplicate spawn-and-append races.
 */
const activeChats = new Map<string, { startedAt: number }>();

function dbForSlug(slug: string) {
  return getLegacyClient(slug);
}

/**
 * Flip the userEngaged flag (and corresponding awaiting_user / gathering_feedback
/**
 * Read the per-harness chat cost cap from `.harness/config.json`. Two keys
 * supported: `maxChatCostUsd` (per-chat) and `maxAggregateChatCostUsd`
 * (across all chats in the harness). Both default to undefined = uncapped.
 */
async function readChatCostCap(slug: string): Promise<{ perChatUsd?: number; aggregateUsd?: number }> {
  try {
    const { loadHarnessRegistry } = require('@/lib/harness-registry') as typeof import('@/lib/harness-registry');
    const projectDir = (await loadHarnessRegistry()).projects.find((p) => p.slug === slug)?.path ?? null;
    if (!projectDir) return {};
    const cfgPath = join(projectDir, '.harness', 'config.json');
    if (!existsSync(cfgPath)) return {};
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>;
    const out: { perChatUsd?: number; aggregateUsd?: number } = {};
    if (typeof cfg.maxChatCostUsd === 'number' && cfg.maxChatCostUsd > 0) out.perChatUsd = cfg.maxChatCostUsd;
    if (typeof cfg.maxAggregateChatCostUsd === 'number' && cfg.maxAggregateChatCostUsd > 0) out.aggregateUsd = cfg.maxAggregateChatCostUsd;
    return out;
  } catch {
    return {};
  }
}

/**
 * Read the strict-mode lock policy for chat. Default false (soft-warn).
 * Set `parallelChat.respectFeatureLocks: true` in `.harness/config.json` to
 * make chat refuse messages when the targeted feature is currently locked
 * by the autonomous worker.
 */
async function readChatLockPolicy(slug: string): Promise<boolean> {
  try {
    const { loadHarnessRegistry } = require('@/lib/harness-registry') as typeof import('@/lib/harness-registry');
    const projectDir = (await loadHarnessRegistry()).projects.find((p) => p.slug === slug)?.path ?? null;
    if (!projectDir) return false;
    const cfgPath = join(projectDir, '.harness', 'config.json');
    if (!existsSync(cfgPath)) return false;
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>;
    const parallelChat = cfg.parallelChat as Record<string, unknown> | undefined;
    return parallelChat?.respectFeatureLocks === true;
  } catch {
    return false;
  }
}

/** Sum of cents across all (non-archived) chats in this harness. */
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

export function registerAgentChats(harness: Hono): void {
  // ── List chats (active by default; ?include=archived to see all) ─────
  harness.get('/:slug/agent-chats', async (c) => {
    const { listChats } = await import('@/lib/agent-chats-data');
    const result = await listChats({
      slug: c.req.param('slug'),
      includeArchived: c.req.query('include') === 'archived',
    });
    if (!result.ok) return c.json({ error: result.error }, result.status as 500);
    return c.json(result.data);
  });

  // ── Create chat ──────────────────────────────────────────────────────
  harness.post('/:slug/agent-chats', async (c) => {
    const { createChat } = await import('@/lib/agent-chats-data');
    let body: { role?: string; feature_id?: string; title?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const result = await createChat({
      slug: c.req.param('slug'),
      role: body.role ?? '',
      feature_id: body.feature_id,
      title: body.title,
    });
    if (!result.ok) return c.json({ error: result.error }, result.status as 400);
    return c.json(result.data, 201);
  });

  // ── Get chat ─────────────────────────────────────────────────────────
  harness.get('/:slug/agent-chats/:chatId', async (c) => {
    const { getChat } = await import('@/lib/agent-chats-data');
    const result = await getChat({
      slug: c.req.param('slug'),
      chatId: c.req.param('chatId'),
    });
    if (!result.ok) return c.json({ error: result.error }, result.status as 404);
    return c.json(result.data);
  });

  // ── Archive chat ─────────────────────────────────────────────────────
  harness.delete('/:slug/agent-chats/:chatId', async (c) => {
    const { archiveChat } = await import('@/lib/agent-chats-data');
    const result = await archiveChat({
      slug: c.req.param('slug'),
      chatId: c.req.param('chatId'),
    });
    if (!result.ok) return c.json({ error: result.error }, result.status as 500);
    return c.json(result.data);
  });

  // ── Append user message + stream assistant reply via SSE ─────────────
  harness.post('/:slug/agent-chats/:chatId/messages', async (c) => {
    const slug = c.req.param('slug');
    const chatId = c.req.param('chatId');
    let body: { content?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const userContent = (body.content ?? '').trim();
    if (!userContent) return c.json({ error: 'content is required' }, 400);

    if (activeChats.has(chatId)) {
      return c.json({ error: 'chat already has an in-flight assistant response' }, 409);
    }

    let chat: ChatRow;
    try {
      const db = dbForSlug(slug);
      const row = (await db.prepare('SELECT * FROM agent_chats WHERE id = ?').get(chatId)) as any;
      if (!row) return c.json({ error: 'chat not found' }, 404);
      chat = rowToChat(row);
      if (chat.archived_at) return c.json({ error: 'chat is archived' }, 410);
    } catch (e) {
      return c.json({ error: `failed to load chat: ${(e as Error).message}` }, 500);
    }

    // Cost-cap check. Per-chat cap is checked against this chat's own
    // accumulated cents; aggregate cap sums all non-archived chats in
    // this harness. Either being exceeded refuses the spawn — operator
    // must archive a chat or raise the cap before continuing.
    const cap = await readChatCostCap(slug);
    if (cap.perChatUsd !== undefined && chat.total_cost_usd_cents >= cap.perChatUsd * 100) {
      return c.json({
        error: 'per-chat cost cap reached',
        chat_cost_usd: chat.total_cost_usd_cents / 100,
        cap_usd: cap.perChatUsd,
        hint: 'increase config.json `maxChatCostUsd` or archive this chat',
      }, 402);
    }
    if (cap.aggregateUsd !== undefined) {
      const aggCents = await aggregateChatCostCents(slug);
      if (aggCents >= cap.aggregateUsd * 100) {
        return c.json({
          error: 'aggregate chat cost cap reached for this harness',
          aggregate_cost_usd: aggCents / 100,
          cap_usd: cap.aggregateUsd,
          hint: 'increase config.json `maxAggregateChatCostUsd` or archive other chats',
        }, 402);
      }
    }

    // Concurrency awareness. If the chat is feature-scoped AND that
    // feature is currently locked by an autonomous worker, prepend a
    // notice to the assembled prompt so the chat agent gives the user
    // an honest "another instance of me is on this right now" answer
    // instead of pretending exclusive ownership.
    const featureLock = chat.feature_id ? await readFeatureLockState(slug, chat.feature_id) : null;

    // Belt-and-braces strict mode: if config.json sets
    // `parallelChat.respectFeatureLocks: true`, refuse chat messages on a
    // feature that's currently locked by an autonomous worker. Default is
    // false — keeps the historical soft-warn behavior (proceed but inject
    // a "concurrent run" notice into the prompt). Strict mode is for
    // operators who want hard substrate-level guarantees that no two
    // claude -p processes can fire against the same feature concurrently.
    if (featureLock?.active) {
      const respectLocks = await readChatLockPolicy(slug);
      if (respectLocks) {
        return c.json({
          error: 'feature_locked',
          feature_id: chat.feature_id,
          taken_by: featureLock.taken_by,
          taken_at: featureLock.taken_at,
          expires_at: featureLock.expires_at,
          hint: `Feature is currently being worked on autonomously by ${featureLock.taken_by}. Wait for the lock to release, or drop a note via POST /api/harness/${slug}/features/${chat.feature_id}/notes if you want guidance picked up on the next worker tick. Disable strict mode by removing parallelChat.respectFeatureLocks from .harness/config.json.`,
        }, 409);
      }
    }

    // Append user turn before streaming so a client reload sees it.
    const userTurn: TranscriptTurn = { role: 'user', content: userContent, ts: new Date().toISOString() };
    const baseTranscript = [...chat.transcript, userTurn];
    try {
      const db = dbForSlug(slug);
      await db.prepare(
        `UPDATE agent_chats SET transcript = ?::jsonb, updated_at = now() WHERE id = ?`,
      ).run(JSON.stringify(baseTranscript), chatId);
    } catch (e) {
      return c.json({ error: `failed to persist user turn: ${(e as Error).message}` }, 500);
    }

    // Assemble the role's prompt + prior transcript history into a single
    // string fed to claude on stdin.
    let assembled: { text: string; runId: string };
    try {
      const r = assembleRolePrompt({
        slug,
        role: chat.role,
        featureId: chat.feature_id ?? undefined,
        mode: 'chat',
      });
      const lockNotice = featureLock?.active
        ? `\n---\n\n## ⚠ Concurrent autonomous run\n\nFeature ${chat.feature_id} is currently being worked on autonomously (taken_by=${featureLock.taken_by}, taken_at=${featureLock.taken_at}). The autonomous loop holds the worktree lock; you do not. **Do not propose code changes**; the user is asking you for advice or context. If they want guidance the autonomous worker should pick up, tell them to add a note (it lands in \`.harness/notes/${chat.feature_id}.md\`, which the next worker tick reads).\n`
        : '';
      const historyBlock = baseTranscript.length > 1
        ? '\n---\n\n## Conversation history\n\n' +
          baseTranscript.slice(0, -1).map((t) => `${t.role === 'user' ? 'User' : 'You (assistant)'}: ${t.content}`).join('\n\n') +
          '\n'
        : '';

      // mem0 workspace-scope memory injection. The role is folded into
      // `queryContext` so retrievals favor role-relevant memories without
      // requiring a helper-level role parameter. Failure modes (no client
      // or search throws) degrade silently — chat still runs.
      const memBlock = await buildMemoryContextBlock({
        userId: null,
        workspaceId: activeWorkspaceId(),
        queryContext: `${chat.role} agent: ${userContent}`,
        heading: 'Agent memory (relevant entries)',
      }).catch(() => null);
      const memorySection = memBlock ? `\n---\n\n${memBlock}\n` : '';

      const promptText = `${r.text}${lockNotice}${memorySection}${historyBlock}\n---\n\n## User\n\n${userContent}\n`;
      assembled = { text: promptText, runId: r.meta.runId };
    } catch (e) {
      return c.json({ error: `failed to assemble prompt: ${(e as Error).message}` }, 500);
    }

    activeChats.set(chatId, { startedAt: Date.now() });

    // Spawn claude with cwd set to the harness project directory so its
    // session-scoped path restriction allows reading harness state and
    // feature docs. Without this, claude is locked to the dev-server's
    // cwd and cannot read any of the inputs the role prompt references.
    const projectDir = await projectDirForSlug(slug);

    const tool = lookupByMcpName('agent_chats:chat');
    if (!tool) {
      activeChats.delete(chatId);
      return c.json({ error: 'agent_chats:chat tool not registered' }, 500);
    }

    return sseResponse({
      signal: c.req.raw.signal,
      setup: async (sink) => {
        let assistantText = '';
        let tokensIn = 0;
        let tokensOut = 0;
        let costUsd = 0;
        let lastErrorMessage: string | null = null;
        let lastErrorStderr: string | undefined;
        let toolError: { code: string; message: string } | null = null;

        try {
          const ctx = {
            workspaceId: activeWorkspaceId(),
            harnessSlug: slug,
            role: 'operator' as const,
            runId: assembled.runId,
            spawnId: `agent_chats-${chatId}`,
            log: () => { /* */ },
            progress: () => { /* */ },
            emit: () => { /* overridden by dispatcher */ },
            signal: c.req.raw.signal,
            spawn: async () => { throw new Error('spawn not available in agent_chats shim'); },
            secret: async () => null,
            projectDir: projectDir ?? '',
            stateDir: '',
          };

          for await (const ev of dispatchProjectedToolStream(
            tool,
            'agent_chats:chat',
            { promptText: assembled.text, cwd: projectDir ?? undefined },
            ctx as never,
            undefined as never,
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
              // ToolResult.content carries the rollup the route needs to persist.
              try {
                const blob = ev.result?.content?.[0];
                if (blob && 'text' in blob && typeof blob.text === 'string') {
                  const parsed = JSON.parse(blob.text) as {
                    finalText?: string;
                    tokensIn?: number;
                    tokensOut?: number;
                    costUsd?: number;
                  };
                  if (parsed.finalText && parsed.finalText.length > assistantText.length) {
                    assistantText = parsed.finalText;
                  }
                  tokensIn = parsed.tokensIn ?? 0;
                  tokensOut = parsed.tokensOut ?? 0;
                  costUsd = parsed.costUsd ?? 0;
                }
              } catch { /* malformed tool result; fall through to whatever we accumulated */ }
            } else if (ev.kind === 'error') {
              toolError = ev.error;
            }
          }
        } finally {
          activeChats.delete(chatId);
        }

        if (toolError) {
          sink.event('error', { message: toolError.message });
          sink.close();
          return;
        }
        if (lastErrorMessage) {
          sink.event('error', { message: lastErrorMessage, stderr: lastErrorStderr });
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
                   updated_at = now()
             WHERE id = ?`,
          ).run(
            JSON.stringify(finalTranscript),
            tokensIn,
            tokensOut,
            finalAssistantTurn.cost_cents ?? 0,
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
  });
}
