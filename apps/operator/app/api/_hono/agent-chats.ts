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
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { getLegacyClient } from '@restart/db-org';
import { assembleRolePrompt } from '@papercusp/orchestrator';

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

const VALID_ROLES = new Set([
  'orchestrator', 'scoper', 'worker', 'validator', 'reviewer',
  'documenter', 'summarizer', 'architect', 'curator', 'debugger',
  'crosscheck', 'ui-qa',
  'director', 'coordinator', 'auditor',
]);

/**
 * Per-chat in-memory lock. A second message POST while a prior one is
 * streaming returns 409. Prevents duplicate spawn-and-append races.
 */
const activeChats = new Map<string, { startedAt: number }>();

function dbForSlug(slug: string) {
  return getLegacyClient(slug);
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
    if (body.feature_id && !/^F-[A-Z0-9-]+$/i.test(body.feature_id)) {
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
      return c.json(rowToChat(row), 201);
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
      return c.json(rowToChat(row));
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
      await db.prepare('UPDATE agent_chats SET archived_at = now(), updated_at = now() WHERE id = ?').run(chatId);
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
      const historyBlock = baseTranscript.length > 1
        ? '\n---\n\n## Conversation history\n\n' +
          baseTranscript.slice(0, -1).map((t) => `${t.role === 'user' ? 'User' : 'You (assistant)'}: ${t.content}`).join('\n\n') +
          '\n'
        : '';
      const promptText = `${r.text}${historyBlock}\n---\n\n## User\n\n${userContent}\n`;
      assembled = { text: promptText, runId: r.meta.runId };
    } catch (e) {
      return c.json({ error: `failed to assemble prompt: ${(e as Error).message}` }, 500);
    }

    activeChats.set(chatId, { startedAt: Date.now() });

    return streamSSE(c, async (sseStream) => {
      const claudeCmd = process.env.CLAUDE_CMD ?? 'claude';
      const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
      const child = spawn(claudeCmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });

      let assistantText = '';
      let tokensIn = 0;
      let tokensOut = 0;
      let costUsd = 0;
      let stderrBuf = '';
      let stdoutLineBuf = '';

      const send = async (event: string, data: Record<string, unknown>) => {
        try { await sseStream.writeSSE({ event, data: JSON.stringify(data) }); }
        catch { /* client disconnected — best effort */ }
      };

      child.stdout.on('data', (chunk: Buffer) => {
        stdoutLineBuf += chunk.toString('utf8');
        let nl: number;
        // eslint-disable-next-line no-cond-assign
        while ((nl = stdoutLineBuf.indexOf('\n')) >= 0) {
          const line = stdoutLineBuf.slice(0, nl).trim();
          stdoutLineBuf = stdoutLineBuf.slice(nl + 1);
          if (!line) continue;
          try {
            const ev = JSON.parse(line);
            // Stream-json: text deltas come as content_block_delta with text_delta.
            if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
              const delta = ev.delta.text ?? '';
              assistantText += delta;
              void send('delta', { text: delta });
            } else if (ev.type === 'result') {
              if (ev.usage) {
                tokensIn = ev.usage.input_tokens ?? tokensIn;
                tokensOut = ev.usage.output_tokens ?? tokensOut;
              }
              if (typeof ev.total_cost_usd === 'number') costUsd = ev.total_cost_usd;
              if (typeof ev.result === 'string' && ev.result.length > assistantText.length) {
                assistantText = ev.result;
              }
            }
          } catch { /* non-JSON line — ignore */ }
        }
      });

      child.stderr.on('data', (chunk: Buffer) => {
        stderrBuf += chunk.toString('utf8');
      });

      // Pipe the prompt to stdin and close.
      child.stdin.write(assembled.text);
      child.stdin.end();

      const exitCode: number = await new Promise((resolve) => {
        child.on('exit', (code) => resolve(code ?? 1));
        child.on('error', () => resolve(1));
      });

      activeChats.delete(chatId);

      if (exitCode !== 0) {
        await send('error', {
          message: `claude exited ${exitCode}`,
          stderr: stderrBuf.slice(-800),
        });
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
