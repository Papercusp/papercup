/**
 * SSE streams for the harness UI:
 *
 *   GET /api/harness/:slug/agents/:runId/stream   — live "thinking" timeline for one agent run
 *   GET /api/harness/:slug/stream                 — text log + feature-diff heartbeats
 *   GET /api/harness/:slug/log/stream             — structured JSONL log stream
 *
 * Relocated from `_hono/harness.ts` (endpoint-hono-elimination-2026-05-21
 * A4 batch 38). All three share the `activeStreams` registry from
 * `lib/harness-active-streams.ts` (carved out in b36) and use the
 * `@papercusp/sse` `sseResponse` helper.
 */
import { join } from 'node:path';
import { statSync, readFileSync, openSync, readSync, closeSync } from 'node:fs';
import { sseResponse } from '@papercusp/sse';
import { resolvePhasedProject, harnessDir, parseFeatures, tailFile } from '../../../harness-core';
import { phasePhaseLabel } from '../../../harness-phases';
import {
  activeStreams,
  HARNESS_STREAM_TOTAL_CAP,
  type StreamToken,
} from '../../../harness-active-streams';
import { defineTool } from '@papercusp/agent-mcp';

function remoteIpFrom(req: Request): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0].trim() ??
    req.headers.get('x-real-ip') ??
    req.headers.get('cf-connecting-ip') ??
    'unknown'
  );
}

export type AgentTimelineEntry = {
  kind: 'text' | 'tool_use' | 'tool_result' | 'status' | 'result';
  text?: string;
  toolName?: string;
  toolInput?: unknown;
  toolId?: string;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
};

export function createAgentTimelineParser() {
  let pendingText = '';
  let pendingThinking = '';
  const flushText = (out: AgentTimelineEntry[]) => {
    if (pendingText) { out.push({ kind: 'text', text: pendingText }); pendingText = ''; }
  };
  const flushThinking = (out: AgentTimelineEntry[]) => {
    if (pendingThinking) {
      out.push({ kind: 'status', text: `[thinking] ${pendingThinking}` });
      pendingThinking = '';
    }
  };
  return {
    parseLine(raw: string): AgentTimelineEntry[] {
      const out: AgentTimelineEntry[] = [];
      let obj: any;
      try { obj = JSON.parse(raw); } catch { return out; }
      const type = obj.type;

      if (type === 'stream_event' && obj.event?.type === 'content_block_delta') {
        const delta = obj.event?.delta;
        if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
          pendingText += delta.text;
        }
      } else if (type === 'assistant' && obj.message?.content) {
        flushText(out);
        for (const block of obj.message.content) {
          if (block.type === 'text') out.push({ kind: 'text', text: block.text });
          else if (block.type === 'tool_use') out.push({ kind: 'tool_use', toolName: block.name, toolInput: block.input, toolId: block.id });
        }
      } else if (type === 'user' && obj.message?.content) {
        for (const block of obj.message.content) {
          if (block.type === 'tool_result') {
            const contentStr = typeof block.content === 'string'
              ? block.content
              : Array.isArray(block.content)
                ? block.content.map((p: any) => p.text ?? '').join('')
                : '';
            out.push({ kind: 'tool_result', toolId: block.tool_use_id, text: contentStr });
          }
        }
      } else if (type === 'result') {
        flushText(out);
        out.push({
          kind: 'result',
          text: obj.result ?? '',
          costUsd: obj.total_cost_usd,
          inputTokens: obj.usage?.input_tokens,
          outputTokens: obj.usage?.output_tokens,
          durationMs: obj.duration_ms,
        });
      } else if (type === 'system' && obj.subtype === 'status') {
        out.push({ kind: 'status', text: obj.status });
      }
      // ── omp (oh-my-pi) format ────────────────────────────────
      else if (type === 'message_update' && obj.assistantMessageEvent) {
        const ev = obj.assistantMessageEvent;
        if (ev.type === 'text_delta' && typeof ev.delta === 'string') {
          flushThinking(out);
          pendingText += ev.delta;
        } else if (ev.type === 'thinking_delta' && typeof ev.delta === 'string') {
          pendingThinking += ev.delta;
        } else if (ev.type === 'thinking_end') {
          flushThinking(out);
        }
      } else if (type === 'tool_execution_start') {
        flushText(out);
        flushThinking(out);
        out.push({
          kind: 'tool_use',
          toolName: obj.toolName ?? 'tool',
          toolInput: obj.args,
          toolId: obj.toolCallId,
        });
      } else if (type === 'tool_execution_end') {
        const result = obj.result;
        const text = typeof result === 'string'
          ? result
          : Array.isArray(result)
            ? result.map((p: any) => (typeof p === 'string' ? p : (p?.text ?? JSON.stringify(p)))).join('')
            : result != null
              ? JSON.stringify(result)
              : '';
        out.push({ kind: 'tool_result', toolId: obj.toolCallId, text });
      } else if (type === 'turn_end' && obj.message?.content) {
        flushText(out);
        flushThinking(out);
        const lastText: string[] = [];
        for (const block of obj.message.content) {
          if (block.type === 'text' && typeof block.text === 'string') {
            lastText.push(block.text);
          }
        }
        if (lastText.length > 0) {
          out.push({ kind: 'result', text: lastText.join('\n').slice(0, 500) });
        }
      } else if (type === 'message_end') {
        flushText(out);
        flushThinking(out);
      }
      return out;
    },
    flush(): AgentTimelineEntry[] {
      const out: AgentTimelineEntry[] = [];
      flushText(out);
      flushThinking(out);
      return out;
    },
  };
}

export function parseAgentTimelineChunks(chunks: Iterable<string>): { entries: AgentTimelineEntry[]; done: boolean } {
  const parser = createAgentTimelineParser();
  const entries: AgentTimelineEntry[] = [];
  let lineBuf = '';
  let done = false;
  for (const chunk of chunks) {
    lineBuf += chunk;
    let nl: number;
    while ((nl = lineBuf.indexOf('\n')) !== -1) {
      const line = lineBuf.slice(0, nl).trim();
      lineBuf = lineBuf.slice(nl + 1);
      if (!line) continue;
      for (const e of parser.parseLine(line)) {
        entries.push(e);
        if (e.kind === 'result') done = true;
      }
    }
  }
  const tail = lineBuf.trim();
  if (tail) {
    for (const e of parser.parseLine(tail)) {
      entries.push(e);
      if (e.kind === 'result') done = true;
    }
  }
  for (const e of parser.flush()) {
    entries.push(e);
    if (e.kind === 'result') done = true;
  }
  return { entries, done };
}

async function readRunChunkBackfill(harnessSlug: string, runId: string): Promise<{ chunks: string[]; lastSeq: number } | null> {
  try {
    const { sql } = (await import('@papercusp/db-org')).getOrgPg();
    const rows = await sql<{ seq: number; chunk_data: string }[]>`
      SELECT seq, chunk_data
        FROM (
          SELECT seq, chunk_data
            FROM harness_shared.harness_run_chunks
           WHERE harness_slug = ${harnessSlug}
             AND run_id = ${runId}
           ORDER BY seq DESC
           LIMIT 500
        ) AS recent
       ORDER BY seq ASC
    `;
    return rows.length > 0
      ? { chunks: rows.map((r) => r.chunk_data), lastSeq: rows[rows.length - 1].seq }
      : null;
  } catch {
    return null;
  }
}

/**
 * SSE: live stream of one agent run's "thinking" — text deltas, tool
 * uses, tool results, and the terminal `result` event.
 *
 * Powers the hover popover on Now-running agent pills. On connect,
 * backfills the parsed timeline so the popover paints immediately,
 * then appends new events from the run-chunk bus. Closes when the
 * agent emits its `result` event or the client disconnects.
 */
const agentRunStream = defineTool({
  method: 'GET',
  path: '/harness/:slug/agents/:runId/stream',
  auth: 'public',
  sampleRate: 0,
  async handler(req, ctx) {
    const url = new URL(req.url);
    const project = await resolvePhasedProject(
      ctx.params.slug as string,
      phasePhaseLabel(url.searchParams.get('phase') ?? undefined),
    );
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const runId = (ctx.params.runId as string).replace(/[^A-Za-z0-9_.-]/g, '');
    const logDir = join(harnessDir(project), 'logs');
    const jsonlPath = join(logDir, `${runId}.jsonl`);

    const remoteIP = remoteIpFrom(req);
    const streamKey = `agent|${remoteIP}|${project.slug}|${runId}`;
    if (!activeStreams.has(streamKey) && activeStreams.size >= HARNESS_STREAM_TOTAL_CAP) {
      return Response.json(
        { error: 'too many active streams', cap: HARNESS_STREAM_TOTAL_CAP },
        { status: 503 },
      );
    }
    const previous = activeStreams.get(streamKey);
    if (previous) previous.abort();

    const parser = createAgentTimelineParser();

    return sseResponse({
      signal: req.signal,
      heartbeatMs: 15_000,
      setup: async (sink) => {
        const token: StreamToken = {
          abort: () => { sink.close(); },
          createdAt: Date.now(),
          remoteIP,
          slug: project.slug,
        };
        activeStreams.set(streamKey, token);
        sink.onClose(() => {
          if (activeStreams.get(streamKey) === token) activeStreams.delete(streamKey);
        });

        let lineBuf = '';
        let done = false;

        const emitChunk = (chunk: string) => {
          lineBuf += chunk;
          let nl: number;
          while ((nl = lineBuf.indexOf('\n')) !== -1) {
            const line = lineBuf.slice(0, nl).trim();
            lineBuf = lineBuf.slice(nl + 1);
            if (!line) continue;
            const entries = parser.parseLine(line);
            for (const e of entries) {
              sink.event('event', e);
              if (e.kind === 'result') {
                done = true;
                sink.event('done', {});
                sink.close();
                return;
              }
            }
          }
        };

        let backfillRaw: string | null = null;
        let backfillChunks: string[] | null = null;
        let backfillChunkLastSeq = -1;
        try {
          const { sql } = (await import('@papercusp/db-org')).getOrgPg();
          const rows = await sql<{ jsonl_body: string }[]>`
            SELECT jsonl_body FROM harness_shared.harness_run_output
             WHERE harness_slug = ${project.slug} AND run_id = ${runId}
             LIMIT 1
          `;
          if (rows.length > 0 && rows[0].jsonl_body) {
            backfillRaw = rows[0].jsonl_body;
          }
        } catch { /* fall through to disk */ }
        if (backfillRaw === null) {
          const chunkBackfill = await readRunChunkBackfill(project.slug, runId);
          if (chunkBackfill) {
            backfillChunks = chunkBackfill.chunks;
            backfillChunkLastSeq = chunkBackfill.lastSeq;
          }
        }
        if (backfillRaw === null) {
          try {
            const stat = statSync(jsonlPath);
            if (stat.size > 0) {
              backfillRaw = readFileSync(jsonlPath, 'utf8');
            }
          } catch { /* no file yet either */ }
        }

        if (backfillChunks && backfillChunks.length > 0) {
          const parsed = parseAgentTimelineChunks(backfillChunks);
          done = parsed.done;
          const capped = parsed.entries.length > 200 ? parsed.entries.slice(-200) : parsed.entries;
          sink.event('backfill', capped);
          if (done) { sink.event('done', {}); sink.close(); return; }
        } else if (backfillRaw && backfillRaw.length > 0) {
          const backfill: AgentTimelineEntry[] = [];
          for (const rawLine of backfillRaw.split('\n')) {
            const line = rawLine.trim();
            if (!line) continue;
            for (const e of parser.parseLine(line)) {
              backfill.push(e);
              if (e.kind === 'result') done = true;
            }
          }
          backfill.push(...parser.flush());
          const capped = backfill.length > 200 ? backfill.slice(-200) : backfill;
          sink.event('backfill', capped);
          if (done) { sink.event('done', {}); sink.close(); return; }
        } else {
          sink.event('backfill', []);
        }

        const { subscribe: busSubscribe } = await import('../../../run-chunk-bus');
        const channelKey = `${project.slug}:${runId}`;
        const busSub = busSubscribe(channelKey, (env) => {
          if (sink.closed) return;
          if (env.seq <= backfillChunkLastSeq) return;
          emitChunk(env.data);
        });
        for (const env of busSub.recent) {
          if (env.seq <= backfillChunkLastSeq) continue;
          emitChunk(env.data);
          if (sink.closed) break;
        }
        void busSub.whenDone.then(() => {
          if (!done && !sink.closed) {
            done = true;
            sink.event('done', {});
            sink.close();
          }
        });
        sink.onClose(() => busSub.unsubscribe());
      },
    });
  },
});

/**
 * SSE: tail run.log + push feature-diff heartbeats. Legacy text-log
 * stream consumed by the harness Run-view.
 */
const slugStream = defineTool({
  method: 'GET',
  path: '/harness/:slug/stream',
  auth: 'public',
  sampleRate: 0,
  async handler(req, ctx) {
    const url = new URL(req.url);
    const project = await resolvePhasedProject(
      ctx.params.slug as string,
      phasePhaseLabel(url.searchParams.get('phase') ?? undefined),
    );
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const runLogPath = join(harnessDir(project), 'logs', 'run.log');

    const remoteIP = remoteIpFrom(req);
    const streamKey = `${remoteIP}|${project.slug}`;

    if (!activeStreams.has(streamKey) && activeStreams.size >= HARNESS_STREAM_TOTAL_CAP) {
      return Response.json(
        { error: 'too many active streams', cap: HARNESS_STREAM_TOTAL_CAP },
        { status: 503 },
      );
    }
    const previous = activeStreams.get(streamKey);
    if (previous) previous.abort();

    return sseResponse({
      signal: req.signal,
      heartbeatMs: 15_000,
      setup: async (sink) => {
        const token: StreamToken = {
          abort: () => { sink.close(); },
          createdAt: Date.now(),
          remoteIP,
          slug: project.slug,
        };
        activeStreams.set(streamKey, token);
        sink.onClose(() => {
          if (activeStreams.get(streamKey) === token) activeStreams.delete(streamKey);
        });

        let lastFeatureState = '';

        try {
          const chunk = tailFile(runLogPath, 256 * 1024);
          if (chunk) sink.eventRaw('log', chunk);
        } catch { /* no log file yet */ }

        const { subscribe: logSubscribe } = await import('../../../harness-log-bus');
        const sub = logSubscribe(`${project.slug}:raw`, (env) => {
          if (sink.closed) return;
          sink.eventRaw('log', env.line + '\n');
        });
        for (const env of sub.recent) {
          if (sink.closed) break;
          sink.eventRaw('log', env.line + '\n');
        }
        sink.onClose(() => sub.unsubscribe());

        const pushFeatures = async () => {
          if (sink.closed) return;
          const feats = await parseFeatures(project);
          const state = JSON.stringify(feats.map((f) => [f.id, f.status, f.attempts]));
          if (state !== lastFeatureState) {
            lastFeatureState = state;
            sink.event('features', feats);
          }
        };
        while (!sink.closed) {
          await pushFeatures();
          if (sink.closed) break;
          await new Promise((r) => setTimeout(r, 3000));
        }
      },
    });
  },
});

/**
 * SSE: structured JSONL log stream. Tails run.log.jsonl (no polling),
 * emits one SSE event per JSON line. On connect, backfills the last
 * `tail` events.
 */
const logStream = defineTool({
  method: 'GET',
  path: '/harness/:slug/log/stream',
  auth: 'public',
  sampleRate: 0,
  async handler(req, ctx) {
    const url = new URL(req.url);
    const project = await resolvePhasedProject(
      ctx.params.slug as string,
      phasePhaseLabel(url.searchParams.get('phase') ?? undefined),
    );
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const jsonlPath = join(harnessDir(project), 'logs', 'run.log.jsonl');
    const tailSize = Math.min(
      Math.max(parseInt(url.searchParams.get('tail') ?? '500', 10) || 500, 1),
      5000,
    );

    const remoteIP = remoteIpFrom(req);
    const streamKey = `jsonl|${remoteIP}|${project.slug}`;
    if (!activeStreams.has(streamKey) && activeStreams.size >= HARNESS_STREAM_TOTAL_CAP) {
      return Response.json(
        { error: 'too many active streams', cap: HARNESS_STREAM_TOTAL_CAP },
        { status: 503 },
      );
    }
    const previous = activeStreams.get(streamKey);
    if (previous) previous.abort();

    return sseResponse({
      signal: req.signal,
      heartbeatMs: 15_000,
      setup: async (sink) => {
        const token: StreamToken = {
          abort: () => { sink.close(); },
          createdAt: Date.now(),
          remoteIP,
          slug: project.slug,
        };
        activeStreams.set(streamKey, token);
        sink.onClose(() => {
          if (activeStreams.get(streamKey) === token) activeStreams.delete(streamKey);
        });

        try {
          const stat = statSync(jsonlPath);
          const tailBytes = 1024 * 1024;
          const start = Math.max(0, stat.size - tailBytes);
          const len = stat.size - start;
          const buf = Buffer.alloc(len);
          const fd = openSync(jsonlPath, 'r');
          try { readSync(fd, buf, 0, len, start); }
          finally { closeSync(fd); }
          let chunk = buf.toString('utf8');
          if (start > 0) {
            const firstNl = chunk.indexOf('\n');
            if (firstNl >= 0) chunk = chunk.slice(firstNl + 1);
          }
          const allLines = chunk.split('\n').filter(Boolean);
          const toReplay = allLines.slice(-tailSize);
          let count = 0;
          for (const raw of toReplay) {
            if (sink.closed) break;
            try { JSON.parse(raw); }
            catch { continue; }
            sink.eventRaw('log', raw);
            count++;
          }
          sink.eventRaw('backfill-done', String(count));
        } catch {
          sink.eventRaw('backfill-done', '0');
        }

        const { subscribe: logSubscribe } = await import('../../../harness-log-bus');
        const sub = logSubscribe(`${project.slug}:log`, (env) => {
          if (sink.closed) return;
          try { JSON.parse(env.line); }
          catch { return; }
          sink.eventRaw('log', env.line);
        });
        for (const env of sub.recent) {
          if (sink.closed) break;
          try { JSON.parse(env.line); }
          catch { continue; }
          sink.eventRaw('log', env.line);
        }
        sink.onClose(() => sub.unsubscribe());
      },
    });
  },
});

/**
 * GET /api/adv/session/thinking?sessionId=<id> — a snapshot of an INTERACTIVE
 * (non-bee) Claude session's thinking timeline, for the agents-roster inspector.
 * Unlike a spawned bee (whose harness run-log the /agents/:runId/stream reads), an
 * su/queen/sentinel session keeps its timeline in its transcript jsonl; we resolve
 * that by sessionId (findSessionTranscript), parse the tail with the SAME timeline
 * parser bees use, and emit it as one `backfill` then `done` — a snapshot (no live
 * follow yet). Empty backfill when the session id is unknown/unreadable.
 *
 * SECURITY (auth: 'loopback'): an interactive session's transcript carries the
 * FULL agent reasoning + tool inputs/results (which can hold file contents +
 * secrets) and is resolved by a raw caller-supplied sessionId with NO
 * workspace/ownership scoping — a cross-session IDOR if network-reachable. The
 * sole consumer is the loopback desktop webview (AgentInspectorModal's
 * streamUrl), so gate it loopback-only: a non-loopback caller gets 403 instead
 * of an arbitrary session's transcript. (Enforced when ENDPOINT_AUTH_TIERS is
 * on / fail-closed if the flag layer is down; PAPERCUSP_ALLOW_REMOTE_ADMIN=1 is
 * the deliberate remote opt-out.) A per-principal + workspace-scoped check is
 * the follow-up for a multi-tenant/exposed deployment.
 */
const sessionThinkingStream = defineTool({
  method: 'GET',
  path: '/adv/session/thinking',
  auth: 'loopback',
  sampleRate: 0,
  async handler(req) {
    const url = new URL(req.url);
    const sessionId = (url.searchParams.get('sessionId') ?? '').replace(/[^A-Za-z0-9_.-]/g, '');
    return sseResponse({
      signal: req.signal,
      heartbeatMs: 15_000,
      setup: async (sink) => {
        const parser = createAgentTimelineParser();
        const entries: AgentTimelineEntry[] = [];
        try {
          const { findSessionTranscript } = await import('../../../claude-sessions');
          const path = sessionId ? await findSessionTranscript(sessionId) : null;
          if (path) {
            const stat = statSync(path);
            // Tail the last 1 MiB so a long session doesn't blow the response.
            const tailBytes = 1024 * 1024;
            const start = Math.max(0, stat.size - tailBytes);
            const len = stat.size - start;
            const buf = Buffer.alloc(len);
            const fd = openSync(path, 'r');
            try { readSync(fd, buf, 0, len, start); } finally { closeSync(fd); }
            let chunk = buf.toString('utf8');
            if (start > 0) {
              const firstNl = chunk.indexOf('\n');
              if (firstNl >= 0) chunk = chunk.slice(firstNl + 1);
            }
            for (const rawLine of chunk.split('\n')) {
              const line = rawLine.trim();
              if (!line) continue;
              for (const e of parser.parseLine(line)) entries.push(e);
            }
            entries.push(...parser.flush());
          }
        } catch { /* unreadable / not found → empty backfill */ }
        const capped = entries.length > 200 ? entries.slice(-200) : entries;
        sink.event('backfill', capped);
        sink.event('done', {});
        sink.close();
      },
    });
  },
});

export default [agentRunStream, slugStream, logStream, sessionThinkingStream];
