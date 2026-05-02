/**
 * /api/harness/:slug/agent-chats — multi-turn conversational sessions with
 * role-scoped agents.
 *
 * Phase B "Pair" primitive. Each chat is a transcript stored in the
 * per-harness `agent_chats` table; on each user message the server
 * assembles the role's full prompt (same as autonomous dispatches via
 * `assembleRolePrompt`) plus the prior transcript, spawns `claude -p`,
 * and streams the response back via SSE.
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
import { stream, streamSSE } from 'hono/streaming';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getLegacyClient } from '@restart/db-org';
import { assembleRolePrompt } from '@papercusp/orchestrator/role-prompt';
import { runClaudeChat } from '@/lib/claude-chat-stream';
import { projectDirForSlug } from '../../../lib/operator-notes';

interface TranscriptTurn {
  role: 'user' | 'assistant';
  content: string;
  ts: string;
  tokens_in?: number;
  tokens_out?: number;
  cost_cents?: number;
}

interface ChatRow {
  id: string;
  role: string;
  feature_id: string | null;
  title: string | null;
  transcript: TranscriptTurn[];
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_usd_cents: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

interface FeatureLockState {
  /** Worker that's currently holding the feature lock, or null if free. */
  taken_by: string | null;
  /** When the lock was acquired. */
  taken_at: string | null;
  /** When the lock auto-expires (orphan recovery). */
  expires_at: string | null;
  /** Convenience flag: true iff an autonomous run is currently in flight. */
  active: boolean;
}

const VALID_ROLES = new Set([
  'orchestrator', 'scoper', 'worker', 'validator',
  'plan-gate', 'reviewer', // 'reviewer' is the legacy alias for 'plan-gate'; both accepted during deprecation
  'documenter', 'summarizer', 'architect', 'curator', 'debugger',
  'crosscheck', 'ui-qa', 'project_manager',
  'director', 'coordinator', 'auditor',
  // Instanced role: chat needs feature_id="EXP-NNN" to identify which expert
  // instance is being chatted with. `feedback` is intentionally absent —
  // ephemeral, no chat surface.
  'expert',
]);

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
 * status) on an expert instance. Called when the chat opens (engaged=true) and
 * when the chat is archived (engaged=false).
 *
 * Reads + writes `.harness/experts/<id>/identity.json` directly. Tolerates a
 * missing file (no-op).
 */
async function flipExpertEngaged(slug: string, expertId: string, engaged: boolean): Promise<void> {
  const home = process.env.HOME ?? homedir();
  const reg = join(home, '.restart-harness-projects.json');
  if (!existsSync(reg)) return;
  const data = JSON.parse(readFileSync(reg, 'utf8'));
  const projectDir = data.projects?.find((p: { slug?: string; path?: string }) => p.slug === slug)?.path;
  if (!projectDir) return;
  const identityPath = join(projectDir, '.harness', 'experts', expertId, 'identity.json');
  if (!existsSync(identityPath)) return;
  const identity = JSON.parse(readFileSync(identityPath, 'utf8'));
  const terminal = new Set(['final', 'max_rounds', 'cancelled', 'superseded', 'error']);
  identity.userEngaged = engaged;
  if (engaged) {
    if (!terminal.has(identity.status)) identity.status = 'awaiting_user';
  } else {
    if (identity.status === 'awaiting_user') identity.status = 'gathering_feedback';
  }
  identity.updatedAt = new Date().toISOString();
  await writeFile(identityPath, JSON.stringify(identity, null, 2), 'utf8');
}

/**
 * Read the current lock state of a feature row. Used to surface a "this
 * feature is currently being autonomously worked" hint in chat responses
 * — the UI can render a warning, the chat agent's prompt gets a preamble.
 *
 * Returns `null` if the feature row doesn't exist.
 */
async function readFeatureLockState(slug: string, featureId: string): Promise<FeatureLockState | null> {
  try {
    const db = dbForSlug(slug);
    const row = (await db
      .prepare('SELECT taken_by, taken_at, expires_at FROM harness_features WHERE harness_slug = ? AND feature_id = ? LIMIT 1')
      .get(slug, featureId)) as { taken_by: string | null; taken_at: string | null; expires_at: string | null } | undefined;
    if (!row) return null;
    return {
      taken_by: row.taken_by,
      taken_at: row.taken_at,
      expires_at: row.expires_at,
      active: row.taken_by !== null,
    };
  } catch {
    return null;
  }
}

/**
 * Read the per-harness chat cost cap from `.harness/config.json`. Two keys
 * supported: `maxChatCostUsd` (per-chat) and `maxAggregateChatCostUsd`
 * (across all chats in the harness). Both default to undefined = uncapped.
 */
function readChatCostCap(slug: string): { perChatUsd?: number; aggregateUsd?: number } {
  try {
    const projectDir = (() => {
      const fs = require('node:fs');
      const path = require('node:path');
      const home = process.env.HOME ?? require('node:os').homedir();
      const reg = path.join(home, '.restart-harness-projects.json');
      if (!fs.existsSync(reg)) return null;
      const data = JSON.parse(fs.readFileSync(reg, 'utf8'));
      return data.projects?.find((p: { slug?: string; path?: string }) => p.slug === slug)?.path ?? null;
    })();
    if (!projectDir) return {};
    const fs = require('node:fs');
    const path = require('node:path');
    const cfgPath = path.join(projectDir, '.harness', 'config.json');
    if (!fs.existsSync(cfgPath)) return {};
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as Record<string, unknown>;
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
function readChatLockPolicy(slug: string): boolean {
  try {
    const fs = require('node:fs');
    const path = require('node:path');
    const home = process.env.HOME ?? require('node:os').homedir();
    const reg = path.join(home, '.restart-harness-projects.json');
    if (!fs.existsSync(reg)) return false;
    const data = JSON.parse(fs.readFileSync(reg, 'utf8'));
    const projectDir = data.projects?.find((p: { slug?: string; path?: string }) => p.slug === slug)?.path ?? null;
    if (!projectDir) return false;
    const cfgPath = path.join(projectDir, '.harness', 'config.json');
    if (!fs.existsSync(cfgPath)) return false;
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as Record<string, unknown>;
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

function rowToChat(r: any): ChatRow {
  return {
    id: r.id,
    role: r.role,
    feature_id: r.feature_id ?? null,
    title: r.title ?? null,
    transcript: typeof r.transcript === 'string'
      ? JSON.parse(r.transcript)
      : (r.transcript ?? []),
    total_input_tokens: typeof r.total_input_tokens === 'bigint' ? Number(r.total_input_tokens) : (r.total_input_tokens ?? 0),
    total_output_tokens: typeof r.total_output_tokens === 'bigint' ? Number(r.total_output_tokens) : (r.total_output_tokens ?? 0),
    total_cost_usd_cents: typeof r.total_cost_usd_cents === 'bigint' ? Number(r.total_cost_usd_cents) : (r.total_cost_usd_cents ?? 0),
    created_at: r.created_at,
    updated_at: r.updated_at,
    archived_at: r.archived_at ?? null,
  };
}

export function registerAgentChats(harness: Hono): void {
  // ── List chats (active by default; ?include=archived to see all) ─────
  harness.get('/:slug/agent-chats', async (c) => {
    const slug = c.req.param('slug');
    const includeArchived = c.req.query('include') === 'archived';
    try {
      const db = dbForSlug(slug);
      const sql = includeArchived
        ? 'SELECT * FROM agent_chats ORDER BY updated_at DESC'
        : 'SELECT * FROM agent_chats WHERE archived_at IS NULL ORDER BY updated_at DESC';
      const rows = (await db.prepare(sql).all()) as any[];
      return c.json({ chats: rows.map(rowToChat) });
    } catch (e) {
      return c.json({ error: `failed to list chats: ${(e as Error).message}` }, 500);
    }
  });

  // ── Create chat ──────────────────────────────────────────────────────
  harness.post('/:slug/agent-chats', async (c) => {
    const slug = c.req.param('slug');
    let body: { role?: string; feature_id?: string; title?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    if (!body.role || !VALID_ROLES.has(body.role)) {
      return c.json({ error: `role must be one of: ${[...VALID_ROLES].join(', ')}` }, 400);
    }
    // Accept any uppercase-prefixed alphanumeric+hyphen ID. Different
    // harness templates use different prefixes (F-NNN for coding, BRIEF-BRF-NNN
    // for org briefs, DIR-D-NNN for directives, INIT-NNN, etc.). The bound
    // here is anti-injection — must look like an ID, not arbitrary text.
    if (body.feature_id && !/^[A-Z][A-Z0-9_-]*[A-Z0-9]$/i.test(body.feature_id)) {
      return c.json({ error: `invalid feature_id: ${body.feature_id}` }, 400);
    }

    const id = randomUUID();
    const title = body.title ?? (body.feature_id ? `${body.role} · ${body.feature_id}` : body.role);

    try {
      const db = dbForSlug(slug);
      await db.prepare(
        `INSERT INTO agent_chats (id, role, feature_id, title, transcript)
         VALUES (?, ?, ?, ?, ?::jsonb)`,
      ).run(id, body.role, body.feature_id ?? null, title, '[]');
      const row = (await db.prepare('SELECT * FROM agent_chats WHERE id = ?').get(id)) as any;
      const featureLock = body.feature_id ? await readFeatureLockState(slug, body.feature_id) : null;

      // Expert chat-open hook: flip userEngaged + awaiting_user so the
      // autonomous loop pauses at the next agent boundary.
      if (body.role === 'expert' && body.feature_id && /^EXP-\d{3,}$/.test(body.feature_id)) {
        await flipExpertEngaged(slug, body.feature_id, true).catch((err) => {
          console.warn(`[agent-chats] failed to flip expert engaged for ${body.feature_id}:`, err?.message ?? err);
        });
      }

      return c.json({ ...rowToChat(row), feature_lock: featureLock }, 201);
    } catch (e) {
      return c.json({ error: `failed to create chat: ${(e as Error).message}` }, 500);
    }
  });

  // ── Get chat ─────────────────────────────────────────────────────────
  harness.get('/:slug/agent-chats/:chatId', async (c) => {
    const slug = c.req.param('slug');
    const chatId = c.req.param('chatId');
    try {
      const db = dbForSlug(slug);
      const row = (await db.prepare('SELECT * FROM agent_chats WHERE id = ?').get(chatId)) as any;
      if (!row) return c.json({ error: 'chat not found' }, 404);
      const chat = rowToChat(row);
      const featureLock = chat.feature_id ? await readFeatureLockState(slug, chat.feature_id) : null;
      return c.json({ ...chat, feature_lock: featureLock });
    } catch (e) {
      return c.json({ error: `failed to load chat: ${(e as Error).message}` }, 500);
    }
  });

  // ── Archive chat ─────────────────────────────────────────────────────
  harness.delete('/:slug/agent-chats/:chatId', async (c) => {
    const slug = c.req.param('slug');
    const chatId = c.req.param('chatId');
    try {
      const db = dbForSlug(slug);
      // Capture role + feature_id BEFORE archiving so we can resume the
      // matching expert if this was an expert chat.
      const pre = (await db
        .prepare('SELECT role, feature_id FROM agent_chats WHERE id = ?')
        .get(chatId)) as { role: string; feature_id: string | null } | undefined;
      await db.prepare('UPDATE agent_chats SET archived_at = now(), updated_at = now() WHERE id = ?').run(chatId);
      if (pre?.role === 'expert' && pre.feature_id && /^EXP-\d{3,}$/.test(pre.feature_id)) {
        await flipExpertEngaged(slug, pre.feature_id, false).catch((err) => {
          console.warn(`[agent-chats] failed to flip expert engaged off for ${pre.feature_id}:`, err?.message ?? err);
        });
      }
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: `failed to archive chat: ${(e as Error).message}` }, 500);
    }
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
    const cap = readChatCostCap(slug);
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
      const respectLocks = readChatLockPolicy(slug);
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
      const promptText = `${r.text}${lockNotice}${historyBlock}\n---\n\n## User\n\n${userContent}\n`;
      assembled = { text: promptText, runId: r.meta.runId };
    } catch (e) {
      return c.json({ error: `failed to assemble prompt: ${(e as Error).message}` }, 500);
    }

    activeChats.set(chatId, { startedAt: Date.now() });

    return streamSSE(c, async (sseStream) => {
      const send = async (event: string, data: Record<string, unknown>) => {
        try { await sseStream.writeSSE({ event, data: JSON.stringify(data) }); }
        catch { /* client disconnected — best effort */ }
      };

      // Spawn claude with cwd set to the harness project directory so its
      // session-scoped path restriction allows reading harness state and
      // feature docs. Without this, claude is locked to the dev-server's
      // cwd and cannot read any of the inputs the role prompt references.
      const projectDir = projectDirForSlug(slug);

      let assistantText = '';
      let tokensIn = 0;
      let tokensOut = 0;
      let costUsd = 0;
      let lastErrorMessage: string | null = null;
      let lastErrorStderr: string | undefined;

      try {
        const stream = runClaudeChat({
          promptText: assembled.text,
          cwd: projectDir ?? undefined,
        });
        for await (const ev of stream) {
          if (ev.type === 'delta') {
            assistantText += ev.text;
            await send('delta', { text: ev.text });
          } else if (ev.type === 'result') {
            tokensIn = ev.tokensIn;
            tokensOut = ev.tokensOut;
            costUsd = ev.costUsd;
            if (ev.finalText.length > assistantText.length) {
              assistantText = ev.finalText;
            }
          } else if (ev.type === 'error') {
            lastErrorMessage = ev.message;
            lastErrorStderr = ev.stderr;
          }
          // tool_call events from agent-chats are not surfaced today —
          // role-scoped agents don't have an MCP config attached. If a
          // future role spawns with tools, add a forwarder here.
        }
      } finally {
        activeChats.delete(chatId);
      }

      if (lastErrorMessage) {
        await send('error', { message: lastErrorMessage, stderr: lastErrorStderr });
        await sseStream.close();
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
        await send('error', { message: `failed to persist assistant turn: ${(e as Error).message}` });
        await sseStream.close();
        return;
      }

      await send('done', {
        run_id: assembled.runId,
        tokens_in: tokensIn,
        tokens_out: tokensOut,
        cost_cents: finalAssistantTurn.cost_cents,
      });
      await sseStream.close();
    });
  });
}
