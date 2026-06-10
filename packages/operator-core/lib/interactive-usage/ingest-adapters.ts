/**
 * Codex + OMP transcript adapters for the interactive-usage ingester
 * (token-usage-reduction-audit-2026-06-09 P-015).
 *
 * Both backends turn out to write append-only JSONL rollouts just like Claude
 * Code (the OMP sqlite `agent.db` only INDEXES threads — its `rollout_path`
 * column points at `~/.omp/agent/sessions/**.jsonl`), so both adapters reuse
 * the same byte-watermark machinery as the Claude parser; only the per-line
 * shapes differ:
 *
 *   codex (`~/.codex/sessions/**.jsonl`):
 *     - `turn_context` lines carry `payload.model` — tracked as last-seen
 *       (chunk-local; a watermark landing between a turn_context and its
 *       token_count falls back to the default model — rare + low-volume).
 *     - `event_msg` lines with `payload.type === 'token_count'` carry
 *       `payload.info.last_token_usage` = the PER-TURN usage
 *       ({input_tokens, cached_input_tokens, output_tokens}). `info` is null
 *       on rate-limit-only updates. `input_tokens` INCLUDES the cached
 *       subset, so uncached input = input − cached, cache-read = cached.
 *
 *   omp (`~/.omp/agent/sessions/**.jsonl`):
 *     - `message` lines with `message.role === 'assistant'` carry
 *       `message.usage` = {input, output, cacheRead, cacheWrite, cost:{total}}
 *       (anthropic-shaped: `input` is already the uncached residue) plus
 *       `message.model`. Deduped by line `id` (max-merge), mirroring the
 *       Claude parser's message.id discipline.
 */
import os from 'node:os';
import path from 'node:path';
import type { ParsedChunk, TranscriptDelta } from './ingest-claude-transcripts';
import { parseTranscriptChunk } from './ingest-claude-transcripts';

const emptyDelta = (): TranscriptDelta => ({
  turns: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
});

/** Consume complete lines only; return [consumedText, consumedBytes]. */
function completeLines(chunk: string): { text: string; bytes: number } {
  const lastNewline = chunk.lastIndexOf('\n');
  if (lastNewline === -1) return { text: '', bytes: 0 };
  const text = chunk.slice(0, lastNewline + 1);
  return { text, bytes: Buffer.byteLength(text, 'utf8') };
}

const CODEX_DEFAULT_MODEL = 'gpt-5.5';

/** Parse a codex rollout chunk. Exported for unit tests. */
export function parseCodexChunk(chunk: string): ParsedChunk {
  const perModel = new Map<string, TranscriptDelta>();
  const { text, bytes } = completeLines(chunk);
  if (bytes === 0) return { perModel, consumedBytes: 0 };
  let model = CODEX_DEFAULT_MODEL;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let j: unknown;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    const evt = j as {
      type?: string;
      payload?: {
        type?: string;
        model?: string;
        info?: {
          last_token_usage?: {
            input_tokens?: number;
            cached_input_tokens?: number;
            output_tokens?: number;
          } | null;
        } | null;
      };
    };
    if (evt?.type === 'turn_context' && typeof evt.payload?.model === 'string' && evt.payload.model) {
      model = evt.payload.model;
      continue;
    }
    if (evt?.type !== 'event_msg' || evt.payload?.type !== 'token_count') continue;
    const u = evt.payload?.info?.last_token_usage;
    if (!u) continue; // rate-limit-only token_count update
    const input = u.input_tokens ?? 0;
    const cached = u.cached_input_tokens ?? 0;
    const acc = perModel.get(model) ?? emptyDelta();
    acc.turns += 1;
    acc.inputTokens += Math.max(0, input - cached); // input INCLUDES the cached subset
    acc.cacheReadTokens += cached;
    acc.outputTokens += u.output_tokens ?? 0;
    perModel.set(model, acc);
  }
  return { perModel, consumedBytes: bytes };
}

interface OmpUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** Parse an OMP rollout chunk. Exported for unit tests. */
export function parseOmpChunk(chunk: string): ParsedChunk {
  const perModel = new Map<string, TranscriptDelta>();
  const { text, bytes } = completeLines(chunk);
  if (bytes === 0) return { perModel, consumedBytes: 0 };
  // line id → max-merged usage (the Claude parser's message.id discipline).
  const byMsg = new Map<string, { model: string; u: Required<OmpUsage> }>();
  let anonSeq = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let j: unknown;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    const evt = j as {
      type?: string;
      id?: string;
      message?: { role?: string; model?: string; usage?: OmpUsage };
    };
    if (evt?.type !== 'message' || evt.message?.role !== 'assistant') continue;
    const model = evt.message?.model;
    const u = evt.message?.usage;
    if (!model || !u) continue;
    const key = evt.id ?? `anon-${anonSeq++}`;
    const acc = byMsg.get(key) ?? {
      model,
      u: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    acc.u.input = Math.max(acc.u.input, u.input ?? 0);
    acc.u.output = Math.max(acc.u.output, u.output ?? 0);
    acc.u.cacheRead = Math.max(acc.u.cacheRead, u.cacheRead ?? 0);
    acc.u.cacheWrite = Math.max(acc.u.cacheWrite, u.cacheWrite ?? 0);
    byMsg.set(key, acc);
  }
  for (const { model, u } of byMsg.values()) {
    const acc = perModel.get(model) ?? emptyDelta();
    acc.turns += 1;
    acc.inputTokens += u.input;
    acc.outputTokens += u.output;
    acc.cacheReadTokens += u.cacheRead;
    acc.cacheCreationTokens += u.cacheWrite;
    perModel.set(model, acc);
  }
  return { perModel, consumedBytes: bytes };
}

/** Provider bucket for a model id (drives `provider` + `bucket_key`). */
export function providerForModel(model: string): 'anthropic' | 'openai' {
  return /gpt|codex|^o\d/i.test(model) ? 'openai' : 'anthropic';
}

export interface TranscriptAdapter {
  /** Adapter name — for logs/errors only. */
  name: string;
  /** Transcript root to walk recursively for `*.jsonl`. */
  root: string;
  /** Chunk parser (complete-lines-only; returns the watermark advance). */
  parse: (chunk: string) => ParsedChunk;
}

/** The default adapter set: Claude Code + codex + OMP rollouts. */
export function defaultAdapters(): TranscriptAdapter[] {
  const home = os.homedir();
  return [
    {
      name: 'claude',
      root: path.join(home, '.claude', 'projects'),
      parse: parseTranscriptChunk,
    },
    {
      name: 'codex',
      root: path.join(home, '.codex', 'sessions'),
      parse: parseCodexChunk,
    },
    {
      name: 'omp',
      root: path.join(home, '.omp', 'agent', 'sessions'),
      parse: parseOmpChunk,
    },
  ];
}
