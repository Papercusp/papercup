/**
 * Claude session title + summary generators.
 *
 * See plan §5 — three-layer memory:
 *   1. Title (5-10 words) — generated once after the first turn via haiku
 *   2. Summary (40-60 words) — regenerated every 5 turns via haiku
 *   3. The actual claude --resume conversation
 *
 * Both run in the background — never block the user. Costs are negligible
 * (haiku ~$0.001 per regen, ~$0.035/day for typical use).
 */

import { runHaiku } from './haiku';
import { setDelegateSummary, setDelegateTitle } from './delegates';

export async function generateSessionTitle(opts: {
  workspace: string;
  agentSessionId: string;
  initiatorMsg: string;
  firstResponse?: string;
}): Promise<void> {
  const prompt = `Generate a 5-10 word descriptive title for this Claude conversation. Just the title — no quotes, no preamble.

User asked: ${opts.initiatorMsg}
${opts.firstResponse ? `\nClaude responded (excerpt): ${opts.firstResponse.slice(0, 400)}` : ''}

Title:`;
  const title = await runHaiku(prompt, 50);
  if (title && title.length <= 80) {
    await setDelegateTitle(opts.workspace, opts.agentSessionId, title).catch(() => {});
  } else if (opts.initiatorMsg) {
    // Fallback: first 8 words of the initiator message.
    const fallback = opts.initiatorMsg.split(/\s+/).slice(0, 8).join(' ');
    await setDelegateTitle(opts.workspace, opts.agentSessionId, fallback).catch(() => {});
  }
}

export async function generateSessionSummary(opts: {
  workspace: string;
  agentSessionId: string;
  transcript: Array<{ role: 'user' | 'assistant'; text: string }>;
}): Promise<void> {
  if (opts.transcript.length === 0) return;
  const formatted = opts.transcript
    .slice(-12)
    .map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.text.slice(0, 600)}`)
    .join('\n\n');
  const prompt = `Summarize this Claude conversation in 40-60 words. Focus on: what was decided, what's open, and what the user/agent are working on. No quotes, no preamble.

${formatted}

Summary:`;
  const summary = await runHaiku(prompt, 150);
  if (summary && summary.length <= 600) {
    await setDelegateSummary(opts.workspace, opts.agentSessionId, summary).catch(() => {});
  }
}
