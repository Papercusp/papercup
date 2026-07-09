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
import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';
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
  // 'prompt' = a real user/wake message (the input that STARTS a turn) — the
  // frontend groups the timeline into turns on these boundaries.
  kind: 'text' | 'tool_use' | 'tool_result' | 'status' | 'result' | 'prompt';
  text?: string;
  toolName?: string;
  toolInput?: unknown;
  toolId?: string;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
  /** ISO timestamp of the source record (when it carries one — transcript
   *  records do; some live stream deltas don't). Rendered as the per-entry
   *  header time in the thinking pane. For accumulated text/thinking it's the
   *  START of that span (the first delta's time). */
  ts?: string;
};

/** Per-entry text cap for UI-bound thinking entries. A single tool_result can
 *  carry a whole file (hundreds of KB); the pane renders it in a ~120px scroll
 *  box, so ship a bounded excerpt — this also keeps the one-shot `backfill`
 *  lean over the desktop IPC hop. Pure — exported for tests. */
export const THINKING_ENTRY_TEXT_CAP = 8_000;
export function capEntryText(e: AgentTimelineEntry): AgentTimelineEntry {
  if (typeof e.text !== 'string' || e.text.length <= THINKING_ENTRY_TEXT_CAP) return e;
  return {
    ...e,
    text: `${e.text.slice(0, THINKING_ENTRY_TEXT_CAP)}… [truncated ${e.text.length - THINKING_ENTRY_TEXT_CAP} chars]`,
  };
}

export function createAgentTimelineParser() {
  let pendingText = '';
  let pendingThinking = '';
  // The timestamp of the FIRST delta of the current pending span, so a flushed
  // text/thinking entry reports when the agent STARTED saying it (not flush time).
  let pendingTextTs: string | undefined;
  let pendingThinkingTs: string | undefined;
  const flushText = (out: AgentTimelineEntry[]) => {
    if (pendingText) { out.push({ kind: 'text', text: pendingText, ts: pendingTextTs }); pendingText = ''; pendingTextTs = undefined; }
  };
  const flushThinking = (out: AgentTimelineEntry[]) => {
    if (pendingThinking) {
      out.push({ kind: 'status', text: `[thinking] ${pendingThinking}`, ts: pendingThinkingTs });
      pendingThinking = '';
      pendingThinkingTs = undefined;
    }
  };
  return {
    parseLine(raw: string): AgentTimelineEntry[] {
      const out: AgentTimelineEntry[] = [];
      let obj: any;
      try { obj = JSON.parse(raw); } catch { return out; }
      const type = obj.type;
      // Source-record ISO timestamp, when present — stamped onto every entry this
      // line emits (drives the per-entry header time in the thinking pane).
      const ts: string | undefined = typeof obj.timestamp === 'string' ? obj.timestamp : undefined;

      if (type === 'stream_event' && obj.event?.type === 'content_block_delta') {
        const delta = obj.event?.delta;
        if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
          if (!pendingText) pendingTextTs = ts;
          pendingText += delta.text;
        }
      } else if (type === 'assistant' && obj.message?.content) {
        flushText(out);
        for (const block of obj.message.content) {
          if (block.type === 'text') out.push({ kind: 'text', text: block.text, ts });
          else if (block.type === 'tool_use') out.push({ kind: 'tool_use', toolName: block.name, toolInput: block.input, toolId: block.id, ts });
        }
      } else if (type === 'user' && obj.message?.content != null) {
        const content = obj.message.content;
        if (typeof content === 'string') {
          // A real user/wake message (plain text) → a turn boundary.
          const t = content.trim();
          if (t) out.push({ kind: 'prompt', text: t.slice(0, 2000), ts });
        } else if (Array.isArray(content)) {
          const promptTexts: string[] = [];
          let hadToolResult = false;
          for (const block of content) {
            if (block.type === 'tool_result') {
              hadToolResult = true;
              const contentStr = typeof block.content === 'string'
                ? block.content
                : Array.isArray(block.content)
                  ? block.content.map((p: any) => p.text ?? '').join('')
                  : '';
              out.push({ kind: 'tool_result', toolId: block.tool_use_id, text: contentStr, ts });
            } else if (block.type === 'text' && typeof block.text === 'string') {
              promptTexts.push(block.text);
            }
          }
          // Text-only user record (no tool_result) = a wake/prompt → turn boundary.
          if (!hadToolResult && promptTexts.length > 0) {
            out.push({ kind: 'prompt', text: promptTexts.join('\n').slice(0, 2000), ts });
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
          ts,
        });
      } else if (type === 'system' && obj.subtype === 'status') {
        out.push({ kind: 'status', text: obj.status, ts });
      }
      // ── omp (oh-my-pi) format ────────────────────────────────
      else if (type === 'message_update' && obj.assistantMessageEvent) {
        const ev = obj.assistantMessageEvent;
        if (ev.type === 'text_delta' && typeof ev.delta === 'string') {
          flushThinking(out);
          if (!pendingText) pendingTextTs = ts;
          pendingText += ev.delta;
        } else if (ev.type === 'thinking_delta' && typeof ev.delta === 'string') {
          if (!pendingThinking) pendingThinkingTs = ts;
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
          ts,
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
        out.push({ kind: 'tool_result', toolId: obj.toolCallId, text, ts });
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
          out.push({ kind: 'result', text: lastText.join('\n').slice(0, 500), ts });
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
  // SECURITY (auth: 'loopback', WI-1388): reads a harness run's "thinking" timeline
  // (tool inputs/RESULTS, which can hold file contents + secrets) by raw caller-supplied
  // slug/runId with NO workspace/ownership scoping — unauthenticated data exposure on a
  // network-exposed bind. The only consumer is the loopback desktop webview via a relative
  // /api URL (AgentThinkingPopover); the mobile path has its own device-JWT endpoint
  // (/device/harnesses/:slug/log/stream) and does not touch this one. Gate loopback-only:
  // non-loopback → 403 (enforced under ENDPOINT_AUTH_TIERS / fail-closed if the flag layer
  // is down; PAPERCUSP_ALLOW_REMOTE_ADMIN=1 is the deliberate remote opt-out). A per-principal
  // + workspace-scoped check is the follow-up for a genuine multi-tenant/exposed deployment.
  auth: 'loopback',
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
  // SECURITY (auth: 'loopback', WI-1388): tails a harness run.log (can hold tool
  // outputs + secrets) by raw caller-supplied slug with NO ownership scoping. The only
  // consumer is the loopback desktop webview via a relative /api URL (the Run-view);
  // the mobile path uses its own device-JWT endpoint. Gate loopback-only (non-loopback
  // → 403; PAPERCUSP_ALLOW_REMOTE_ADMIN=1 is the deliberate remote opt-out).
  auth: 'loopback',
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
  // SECURITY (auth: 'loopback', WI-1388): tails a harness run.log.jsonl (structured
  // log; can hold tool outputs + secrets) by raw caller-supplied slug with NO ownership
  // scoping. The only consumer is the loopback desktop webview via a relative /api URL
  // (RealLogsPanel); the mobile path has its OWN device-JWT /device/harnesses/:slug/log/stream
  // (which re-implements the tail, not a proxy to this one). Gate loopback-only (non-loopback
  // → 403; PAPERCUSP_ALLOW_REMOTE_ADMIN=1 is the deliberate remote opt-out).
  auth: 'loopback',
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
 * GET /api/adv/session/thinking — a LIVE-FOLLOWED view of an INTERACTIVE
 * (non-bee) session's thinking timeline, for the agents-roster inspector.
 * Keyed by exactly one of:
 *   ?sessionId=<uuid>[&owner=<coord-owner>] — a CLAUDE session's transcript jsonl
 *   ?codexSessionKey=<adv-row-id>           — a CODEX session's rollout jsonl
 *   ?ompThreadId=<uuid>                     — an OMP session's jsonl
 * Unlike a spawned bee (whose harness run-log the /agents/:runId/stream reads),
 * an interactive session keeps its timeline in a per-backend jsonl; we resolve
 * that file, parse the tail with the backend's timeline parser, emit it as one
 * `backfill`, then POLL the file for appended records — emitting each new entry
 * as `event` (the current turn streams in live) plus a `thinking` status
 * ({active}) when the agent starts/stops writing.
 * It does NOT emit `done` while the session merely goes idle (only if the transcript
 * vanishes); the client closes the stream when the pane closes. A session whose
 * transcript hasn't been WRITTEN yet (a live agent pre-first-turn) gets an empty
 * backfill and the stream KEEPS polling until the file appears — `done` there
 * would misread a live agent as "run ended". Empty backfill + `done` only when
 * no sessionId was supplied.
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
    // The agent's coord owner id — the per-session isolation dir key. Lets
    // findSessionTranscript jump straight to `session-claude/<owner>/projects`
    // (1 readdir, plus the global root) instead of sweeping every isolation
    // root. Sanitized; absent ⇒ the full-scan fallback still resolves it.
    const owner = (url.searchParams.get('owner') ?? '').replace(/[^A-Za-z0-9_.-]/g, '') || undefined;
    // Non-claude backends ("every roster agent has a history"): a codex session
    // streams its rollout jsonl (CODEX_HOME keyed by the adv-session row id),
    // an omp session its ~/.omp/agent/sessions jsonl (keyed by thread id). Same
    // tail-backfill + poll-follow machinery — only resolver + parser differ.
    const codexSessionKey = (url.searchParams.get('codexSessionKey') ?? '').replace(/[^A-Za-z0-9_-]/g, '');
    const ompThreadId = (url.searchParams.get('ompThreadId') ?? '').replace(/[^A-Za-z0-9_-]/g, '');
    // A codex session keyed by its ROLLOUT UUID (the session-turns index key) —
    // the transcript-search deep-link for codex sessions with no adv-row key.
    const codexRolloutId = (url.searchParams.get('codexRolloutId') ?? '').replace(/[^A-Za-z0-9-]/g, '');
    // Deep-link anchor (agents-pill-inactive-search-2026-07-09 P-005): `find` =
    // the search term (a plain substring for entry matching, never a
    // path/pattern — length-capped only) and `anchorTs` = the matched turn's
    // timestamp. When `find` is present the backfill window CENTERS on the
    // matched entry instead of tailing the file, and an `anchor` event tells
    // the client which backfill index to scroll to.
    const find = (url.searchParams.get('find') ?? '').slice(0, 300);
    const anchorTsRaw = (url.searchParams.get('anchorTs') ?? '').trim();
    const anchorTs = anchorTsRaw && !Number.isNaN(Date.parse(anchorTsRaw)) ? anchorTsRaw : null;
    return sseResponse({
      signal: req.signal,
      heartbeatMs: 15_000,
      setup: async (sink) => {
        const { resolveInteractiveTranscript, SESSION_THINKING_ACTIVE_MS } = await import('../../../claude-sessions');
        const { findCodexRolloutPath, findCodexRolloutPathByUuid, findOmpSessionPath } = await import('../../../session-transcript-resolvers');
        const { createCodexTimelineParser, createOmpTimelineParser } = await import('../../../session-timeline-parsers');
        const source = codexSessionKey
          ? { resolve: () => findCodexRolloutPath(codexSessionKey), newParser: createCodexTimelineParser }
          : codexRolloutId
            ? { resolve: () => findCodexRolloutPathByUuid(codexRolloutId), newParser: createCodexTimelineParser }
          : ompThreadId
            ? { resolve: () => findOmpSessionPath(ompThreadId), newParser: createOmpTimelineParser }
            : sessionId
              // P-016 fallback (WI-2680): resolve the exact recorded session_id first,
              // then — on a miss — the newest transcript under the owner root, so a
              // session that RESUMED (fresh uuid ⇒ stale recorded id) still streams its
              // CURRENT transcript instead of an empty "waiting/stalled" pane.
              ? { resolve: () => resolveInteractiveTranscript(sessionId, { owner }), newParser: createAgentTimelineParser }
              : null;
        if (!source) { sink.event('backfill', []); sink.done({}); return; }
        let path = await source.resolve();

        // ── Follow state (shared by the backfill + the live-follow tick) ──
        let pos = 0;
        let lineBuf = '';
        let lastActive: boolean | null = null;
        let lastAppendMs = Date.now();
        let handle: ManagedHandle | null = null;
        let followParser = source.newParser();
        const emitThinking = (active: boolean) => {
          if (active !== lastActive) { lastActive = active; sink.event('thinking', { active }); }
        };

        // ── 1) Backfill: the last 1 MiB tail as a snapshot. Returns whether the
        //       transcript was appended recently (the initial thinking state). ──
        const backfillFrom = (p: string): boolean => {
          try {
            const stat = statSync(p);
            const tailBytes = 1024 * 1024;
            const start = Math.max(0, stat.size - tailBytes);
            const len = stat.size - start;
            const buf = Buffer.alloc(len);
            const fd = openSync(p, 'r');
            try { readSync(fd, buf, 0, len, start); } finally { closeSync(fd); }
            let chunk = buf.toString('utf8');
            if (start > 0) {
              const firstNl = chunk.indexOf('\n');
              if (firstNl >= 0) chunk = chunk.slice(firstNl + 1);
            }
            const parser = source.newParser();
            const entries: AgentTimelineEntry[] = [];
            for (const rawLine of chunk.split('\n')) {
              const line = rawLine.trim();
              if (!line) continue;
              for (const e of parser.parseLine(line)) entries.push(e);
            }
            entries.push(...parser.flush());
            const capped = (entries.length > 200 ? entries.slice(-200) : entries).map(capEntryText);
            sink.event('backfill', capped);
            pos = stat.size;
            return Date.now() - stat.mtimeMs < SESSION_THINKING_ACTIVE_MS;
          } catch {
            sink.event('backfill', []);
            return false;
          }
        };

        // ── 1b) Anchored backfill (deep-link from a transcript-search hit):
        //       stream the WHOLE file through the AnchorWindowCollector and
        //       backfill a window CENTERED on the matched entry, then emit
        //       `anchor` with the in-backfill index for the client to scroll
        //       to. Memory-bounded (only the window region is retained) and —
        //       with an anchorTs — stops reading once the trailing context is
        //       collected. No match ⇒ fall back to the tail backfill and say
        //       so (`anchor {found:false}`), never a dead pane. ──
        const anchoredBackfillFrom = async (p: string): Promise<boolean> => {
          try {
            const { AnchorWindowCollector } = await import('../../../session-anchor-window');
            const { StringDecoder } = await import('node:string_decoder');
            const stat = statSync(p);
            const collector = new AnchorWindowCollector({ find, anchorTs });
            const parser = source!.newParser();
            const decoder = new StringDecoder('utf8');
            const chunk = Buffer.alloc(1024 * 1024);
            let lineRest = '';
            let offset = 0;
            const fd = openSync(p, 'r');
            try {
              while (offset < stat.size && !collector.done) {
                const n = readSync(fd, chunk, 0, chunk.length, offset);
                if (n <= 0) break;
                offset += n;
                lineRest += decoder.write(chunk.subarray(0, n));
                let nl: number;
                while ((nl = lineRest.indexOf('\n')) !== -1 && !collector.done) {
                  const line = lineRest.slice(0, nl).trim();
                  lineRest = lineRest.slice(nl + 1);
                  if (!line) continue;
                  for (const e of parser.parseLine(line)) collector.push(e);
                }
              }
              if (!collector.done) {
                const last = (lineRest + decoder.end()).trim();
                if (last) for (const e of parser.parseLine(last)) collector.push(e);
                for (const e of parser.flush()) collector.push(e);
              }
            } finally {
              closeSync(fd);
            }
            const res = collector.result();
            if (!res) {
              // Term not found (transcript rotated / truncated at ingest) —
              // honest fallback: normal tail backfill + a found:false anchor.
              const active = backfillFrom(p);
              sink.event('anchor', { found: false });
              return active;
            }
            sink.event('backfill', res.entries.map(capEntryText));
            sink.event('anchor', { found: true, index: res.anchorIndex });
            // Live-follow continues from EOF: entries between the window and
            // the file end are elided from the pane (it is a jumped-to view).
            pos = stat.size;
            return Date.now() - stat.mtimeMs < SESSION_THINKING_ACTIVE_MS;
          } catch {
            sink.event('backfill', []);
            sink.event('anchor', { found: false });
            return false;
          }
        };

        if (path) {
          emitThinking(find ? await anchoredBackfillFrom(path) : backfillFrom(path));
        } else {
          // No transcript file YET — for a LIVE session that hasn't taken its
          // first turn this is "waiting", NOT "run ended": send the empty
          // backfill (the pane shows its waiting/stalled state, no eternal
          // "connecting…") and keep the stream open — the tick below re-resolves
          // until the file appears, then backfills + follows it. `done` here
          // (the old behavior) misread every just-launched queen as ended.
          sink.event('backfill', []);
          emitThinking(false);
        }

        // ── 2) Live-follow the CURRENT turn: poll for appended records, emit each
        //       as `event`, and a `thinking` status when the agent starts/stops
        //       writing. Unlike a bee run this never emits `done` on its own — an
        //       interactive session's transcript just goes quiet when idle; the
        //       client closes the stream when the pane closes (onClose → stop). ──
        let resolving = false;
        const tick = () => {
          if (sink.closed) { handle?.stop(); return; }
          if (!path) {
            // Still waiting on the first transcript write. Cheap for every
            // backend (a handful of readdirs, never a sweep).
            if (resolving) return;
            resolving = true;
            void source.resolve()
              .then(async (p) => {
                if (sink.closed || path || !p) return;
                path = p;
                followParser = source.newParser();
                emitThinking(find ? await anchoredBackfillFrom(p) : backfillFrom(p));
              })
              .finally(() => { resolving = false; });
            return;
          }
          let stat;
          try { stat = statSync(path); } catch { sink.done({}); handle?.stop(); return; }
          if (stat.size > pos) {
            const len = stat.size - pos;
            const buf = Buffer.alloc(len);
            const fd = openSync(path, 'r');
            try { readSync(fd, buf, 0, len, pos); } finally { closeSync(fd); }
            pos = stat.size;
            lineBuf += buf.toString('utf8');
            let nl: number;
            while ((nl = lineBuf.indexOf('\n')) !== -1) {
              const line = lineBuf.slice(0, nl).trim();
              lineBuf = lineBuf.slice(nl + 1);
              if (!line) continue;
              for (const e of followParser.parseLine(line)) sink.event('event', capEntryText(e));
            }
            lastAppendMs = Date.now();
            emitThinking(true);
          } else if (Date.now() - lastAppendMs >= SESSION_THINKING_ACTIVE_MS) {
            emitThinking(false);
          }
        };
        handle = managedSetInterval('adv-session-thinking-follow', 1000, tick, {
          category: 'lifecycle',
          instanced: true,
        });
        sink.onClose(() => handle?.stop());
      },
    });
  },
});

export default [agentRunStream, slugStream, logStream, sessionThinkingStream];
