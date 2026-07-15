import type { PortableTurn } from './types';
import { renderPortableTurns } from './render';

export const SESSION_PORT_SUMMARY_PROMPT_VERSION = 1;
export const MAX_SUMMARIZER_INPUT_CHARS = 400_000;

export type SessionPortSummarizer = (input: {
  text: string;
  promptVersion: number;
  chunk: number;
  chunks: number;
  signal: AbortSignal;
}) => Promise<{ text: string; model: string; provider: string; costUsd?: number | null }>;

const estimatedTokens = (text: string): number => Math.ceil(Buffer.byteLength(text, 'utf8') / 3.7);

function atomicTurnGroups(turns: PortableTurn[]): PortableTurn[][] {
  const groups: PortableTurn[][] = [];
  for (const turn of turns) {
    const hasResult = turn.blocks.some((block) => block.type === 'tool_narrative' && block.event === 'result');
    const previous = groups.at(-1);
    const previousHasCall = previous?.some((candidate) => candidate.blocks.some((block) => block.type === 'tool_narrative' && block.event === 'call'));
    if (hasResult && previousHasCall) previous!.push(turn);
    else groups.push([turn]);
  }
  return groups;
}

export async function fitPortableTurns(input: {
  turns: PortableTurn[];
  availableTokens: number;
  summarizer?: SessionPortSummarizer | null;
  timeoutMs?: number;
}): Promise<{
  fidelity: 'full' | 'summary-tail';
  transcript: string;
  estimatedTokens: number;
  summary?: { model: string; provider: string; costUsd: number; chunks: number; promptVersion: number };
}> {
  const full = renderPortableTurns(input.turns).text;
  if (estimatedTokens(full) <= input.availableTokens) {
    return { fidelity: 'full', transcript: full, estimatedTokens: estimatedTokens(full) };
  }
  if (!input.summarizer) throw new Error('session port requires summarization, but no summarizer is available');

  const groups = atomicTurnGroups(input.turns);
  const tail: PortableTurn[] = [];
  let tailTokens = 0;
  const tailBudget = Math.max(1, Math.floor(input.availableTokens * 0.55));
  while (groups.length) {
    const group = groups.at(-1)!;
    const tokens = estimatedTokens(renderPortableTurns(group).text);
    if (tail.length && tailTokens + tokens > tailBudget) break;
    groups.pop();
    tail.unshift(...group);
    tailTokens += tokens;
  }
  const older = renderPortableTurns(groups.flat()).text;
  if (!older) throw new Error('session port cannot fit even the most recent atomic turn group');
  const chunks: string[] = [];
  for (let offset = 0; offset < older.length; offset += MAX_SUMMARIZER_INPUT_CHARS) {
    chunks.push(older.slice(offset, offset + MAX_SUMMARIZER_INPUT_CHARS));
  }
  const summaries: string[] = [];
  let model = '';
  let provider = '';
  let costUsd = 0;
  for (const [index, chunk] of chunks.entries()) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), input.timeoutMs ?? 45_000);
    try {
      const result = await input.summarizer({
        text: chunk,
        promptVersion: SESSION_PORT_SUMMARY_PROMPT_VERSION,
        chunk: index + 1,
        chunks: chunks.length,
        signal: ac.signal,
      });
      const safe = renderPortableTurns([{
        id: `summary-${index}`, parentId: null, role: 'system', timestamp: null,
        blocks: [{ type: 'text', text: result.text }],
      }]).text;
      if (!safe.trim() || estimatedTokens(safe) > Math.max(2_000, Math.floor(input.availableTokens * 0.35))) {
        throw new Error('summarizer returned empty or oversized output');
      }
      summaries.push(safe);
      model = result.model;
      provider = result.provider;
      costUsd += Number(result.costUsd ?? 0);
    } finally {
      clearTimeout(timer);
    }
  }
  const transcript = [
    '### SYSTEM · CROSS-BACKEND SUMMARY OF OLDER HISTORY',
    ...summaries,
    '### SYSTEM · RECENT VERBATIM TAIL',
    renderPortableTurns(tail).text,
  ].join('\n\n');
  const total = estimatedTokens(transcript);
  if (total > input.availableTokens) throw new Error(`session port still exceeds target budget (${total} > ${input.availableTokens})`);
  return {
    fidelity: 'summary-tail',
    transcript,
    estimatedTokens: total,
    summary: { model, provider, costUsd, chunks: chunks.length, promptVersion: SESSION_PORT_SUMMARY_PROMPT_VERSION },
  };
}
