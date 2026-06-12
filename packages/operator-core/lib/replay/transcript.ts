/**
 * Transcript loading for the replay harness (P-020 / FB-06): a tolerant
 * jsonl → {@link ReplayTranscript} parser over the three agent stream shapes
 * the fleet writes (the same family `extractRunUsage` in
 * `@papercusp/orchestrator`'s cost-cap parses for usage):
 *
 *   claude  — `{"type":"assistant"|"user","message":{content:[blocks]}}` +
 *             `{"type":"system","subtype":"init","model"}` + terminal `result`;
 *   omp     — session files `{"type":"message","message":{role,content}}` (+
 *             top-level `function_call`), stream files `message_end` /
 *             terminal `agent_end.messages` (fallback when nothing else parsed);
 *   codex   — `{"type":"item.completed","item":{...}}` + terminal
 *             `turn.completed` (best-effort).
 *
 * Tolerant by design: unparseable lines and unknown event types are SKIPPED,
 * never fatal — a replay over a partially-recognized transcript is still
 * useful, and FB-07's selection heuristics can filter on turn counts.
 * Thinking/reasoning blocks are dropped (not part of the visible trajectory).
 *
 * `cutTranscript` + `renderTurns` are the deterministic seams the battery
 * builds on: same transcript + same cut ⇒ byte-identical context/continuation.
 */
import { readFile } from 'node:fs/promises';
import type { ReplayTranscript, ReplayTurn, ReplayTurnRole, TranscriptSource } from './types';

const TOOL_INPUT_CAP = 2000;

type Json = Record<string, unknown>;

function asObj(v: unknown): Json | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function eventTs(obj: Json): number | undefined {
  const iso = str(obj.timestamp);
  if (iso) {
    const t = Date.parse(iso);
    if (Number.isFinite(t)) return t;
  }
  return typeof obj.ts === 'number' && Number.isFinite(obj.ts) ? obj.ts : undefined;
}

/** Flatten a tool_result-style content payload (string | block list) to text. */
function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      const b = asObj(block);
      if (!b) continue;
      const t = str(b.text);
      if (t) parts.push(t);
    }
    return parts.join('\n');
  }
  return '';
}

interface PendingTurn {
  role: ReplayTurnRole;
  text: string;
  toolName?: string;
  ts?: number;
}

/** One message envelope (claude assistant/user wrapper, omp message) → turns. */
function messageTurns(message: Json, ts: number | undefined): PendingTurn[] {
  const role = str(message.role);
  const baseRole: ReplayTurnRole = role === 'assistant' ? 'assistant' : role === 'system' ? 'system' : 'user';
  const content = message.content;

  if (typeof content === 'string') {
    return content.trim() ? [{ role: baseRole, text: content, ts }] : [];
  }
  if (!Array.isArray(content)) return [];

  const out: PendingTurn[] = [];
  let textAcc: string[] = [];
  const flushText = () => {
    const text = textAcc.join('\n').trim();
    if (text) out.push({ role: baseRole, text, ts });
    textAcc = [];
  };

  for (const block of content) {
    const b = asObj(block);
    if (!b) continue;
    const type = str(b.type) ?? '';
    if (type === 'text' || type === 'output_text' || type === 'summary_text') {
      const t = str(b.text);
      if (t) textAcc.push(t);
    } else if (type === 'tool_use' || type === 'function_call') {
      flushText();
      const input = b.input ?? b.arguments;
      const rendered = typeof input === 'string' ? input : input === undefined ? '' : JSON.stringify(input);
      out.push({
        role: 'tool_use',
        text: rendered.slice(0, TOOL_INPUT_CAP),
        toolName: str(b.name),
        ts,
      });
    } else if (type === 'tool_result') {
      flushText();
      const text = contentToText(b.content);
      out.push({ role: 'tool_result', text, ts });
    }
    // thinking / reasoning / redacted_thinking / images: dropped by design.
  }
  flushText();
  return out;
}

/** Parse a jsonl transcript body into an ordered turn list (tolerant). */
export function parseTranscriptJsonl(body: string, ref: string): ReplayTranscript {
  const pending: PendingTurn[] = [];
  let model: string | undefined;
  let backend: string | undefined;
  let sawClaude = false;
  let sawOmp = false;
  let sawCodex = false;
  let agentEndMessages: unknown[] | null = null;

  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: Json | null = null;
    try {
      obj = asObj(JSON.parse(trimmed));
    } catch {
      continue; // tolerant: partial/garbled lines are skipped
    }
    if (!obj) continue;
    const type = str(obj.type) ?? '';
    const ts = eventTs(obj);

    if (type === 'papercusp.run_meta') {
      model = str(obj.model) ?? model;
      backend = str(obj.backend) ?? backend;
    } else if (type === 'system' && obj.subtype === 'init') {
      sawClaude = true;
      model = str(obj.model) ?? model;
    } else if ((type === 'assistant' || type === 'user') && asObj(obj.message)) {
      sawClaude = true;
      const msg = asObj(obj.message)!;
      model = str(msg.model) ?? model;
      pending.push(...messageTurns(msg, ts));
    } else if ((type === 'message' || type === 'message_end') && asObj(obj.message)) {
      sawOmp = true;
      const msg = asObj(obj.message)!;
      model = str(msg.model) ?? model;
      pending.push(...messageTurns(msg, ts));
    } else if (type === 'function_call') {
      // omp session files carry top-level function_call events.
      sawOmp = true;
      const input = obj.arguments ?? obj.input;
      const rendered = typeof input === 'string' ? input : input === undefined ? '' : JSON.stringify(input);
      pending.push({ role: 'tool_use', text: rendered.slice(0, TOOL_INPUT_CAP), toolName: str(obj.name), ts });
    } else if (type === 'agent_end' && Array.isArray(obj.messages)) {
      sawOmp = true;
      agentEndMessages = obj.messages;
    } else if (type === 'item.completed' && asObj(obj.item)) {
      sawCodex = true;
      const item = asObj(obj.item)!;
      const itemType = str(item.type) ?? '';
      const text = str(item.text);
      if (itemType === 'agent_message' && text) {
        pending.push({ role: 'assistant', text, ts });
      } else if (itemType === 'command_execution') {
        const cmd = str(item.command);
        if (cmd) pending.push({ role: 'tool_use', text: cmd.slice(0, TOOL_INPUT_CAP), toolName: 'command', ts });
      }
    } else if (type === 'turn.completed') {
      sawCodex = true;
    }
    // everything else: skipped (tool deltas, usage stamps, ui events, …)
  }

  // omp terminal fallback: agent_end carries the FULL messages list — use it
  // only when no per-event turns were parsed (mirrors cost-cap's usage rule).
  if (pending.length === 0 && agentEndMessages) {
    for (const m of agentEndMessages) {
      const msg = asObj(m);
      if (msg) pending.push(...messageTurns(msg, undefined));
    }
  }

  const turns: ReplayTurn[] = pending.map((t, index) => ({ index, ...t }));
  const inferredBackend = backend ?? (sawClaude ? 'claude-code' : sawCodex ? 'codex' : sawOmp ? 'omp' : undefined);
  return {
    ref,
    ...(inferredBackend ? { backend: inferredBackend } : {}),
    ...(model ? { model } : {}),
    turns,
  };
}

/** Cut a transcript at `turnIndex`: context = turns before it, continuation =
 *  the original trajectory from it on (the divergence anchor). */
export function cutTranscript(
  transcript: ReplayTranscript,
  turnIndex: number,
): { context: ReplayTurn[]; continuation: ReplayTurn[] } {
  if (!Number.isInteger(turnIndex) || turnIndex < 1 || turnIndex >= transcript.turns.length) {
    throw new Error(
      `cutTranscript: turnIndex ${turnIndex} out of range (1..${transcript.turns.length - 1}) for ${transcript.ref}`,
    );
  }
  return {
    context: transcript.turns.slice(0, turnIndex),
    continuation: transcript.turns.slice(turnIndex),
  };
}

export interface RenderTurnsOpts {
  maxChars: number;
  /** Which end survives the cap: 'tail' for context (most recent matters),
   *  'head' for continuations. */
  keep: 'head' | 'tail';
}

/** Deterministic plain-text rendering of a turn list, whole-turn capped. */
export function renderTurns(turns: readonly ReplayTurn[], opts: RenderTurnsOpts): string {
  const blocks = turns.map((t) => {
    const head = t.role === 'tool_use' && t.toolName ? `[#${t.index} tool_use ${t.toolName}]` : `[#${t.index} ${t.role}]`;
    return `${head}\n${t.text}`;
  });

  let kept = blocks;
  let elided = 0;
  const joined = () => kept.join('\n\n');
  while (kept.length > 1 && joined().length > opts.maxChars) {
    if (opts.keep === 'tail') kept = kept.slice(1);
    else kept = kept.slice(0, -1);
    elided++;
  }
  let text = joined();
  if (text.length > opts.maxChars) {
    text = opts.keep === 'tail' ? text.slice(text.length - opts.maxChars) : text.slice(0, opts.maxChars);
  }
  if (elided > 0) {
    text = opts.keep === 'tail' ? `[…${elided} earlier turn(s) elided…]\n\n${text}` : `${text}\n\n[…${elided} later turn(s) elided…]`;
  }
  return text;
}

/** Default judge intent for a historical case: the first user turn. */
export function intentFromTranscript(transcript: ReplayTranscript, maxChars = 2000): string {
  const firstUser = transcript.turns.find((t) => t.role === 'user');
  return (firstUser?.text ?? '').slice(0, maxChars);
}

/** The default filesystem source: a ref is a path to a `.jsonl` transcript
 *  (`.papercusp/logs/<runId>.jsonl`, an omp session file, …). */
export function fsTranscriptSource(): TranscriptSource {
  return {
    async load(ref: string): Promise<ReplayTranscript> {
      const body = await readFile(ref, 'utf8');
      return parseTranscriptJsonl(body, ref);
    },
  };
}
