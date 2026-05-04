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

import { spawn } from 'node:child_process';
import { setClaudeSessionSummary, setClaudeSessionTitle } from './claude-sessions';

const HAIKU_MODEL = process.env.PAPERCUSP_HAIKU_MODEL ?? 'claude-haiku-4-5';

/**
 * Spawn `claude -p --model haiku` to summarize a transcript. Returns the
 * text or null if it fails. Doesn't throw — title/summary generation is
 * best-effort.
 */
async function runHaiku(prompt: string, maxTokens = 200): Promise<string | null> {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    const child = spawn(
      'claude',
      ['-p', '--model', HAIKU_MODEL, '--output-format', 'text', '--no-session-persistence'],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('close', (code) => {
      if (code === 0) resolve(out.trim() || null);
      else {
        console.warn(`[claude-session-summary] haiku exited ${code}:`, err.slice(0, 300));
        resolve(null);
      }
    });
    child.on('error', () => resolve(null));
    child.stdin.end(prompt);
    // Bound runtime — title gen should be sub-2s.
    setTimeout(() => {
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
    }, 5000);
  });
}

export async function generateSessionTitle(opts: {
  workspace: string;
  claudeSessionId: string;
  initiatorMsg: string;
  firstResponse?: string;
}): Promise<void> {
  const prompt = `Generate a 5-10 word descriptive title for this Claude conversation. Just the title — no quotes, no preamble.

User asked: ${opts.initiatorMsg}
${opts.firstResponse ? `\nClaude responded (excerpt): ${opts.firstResponse.slice(0, 400)}` : ''}

Title:`;
  const title = await runHaiku(prompt, 50);
  if (title && title.length <= 80) {
    await setClaudeSessionTitle(opts.workspace, opts.claudeSessionId, title).catch(() => {});
  } else if (opts.initiatorMsg) {
    // Fallback: first 8 words of the initiator message.
    const fallback = opts.initiatorMsg.split(/\s+/).slice(0, 8).join(' ');
    await setClaudeSessionTitle(opts.workspace, opts.claudeSessionId, fallback).catch(() => {});
  }
}

export async function generateSessionSummary(opts: {
  workspace: string;
  claudeSessionId: string;
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
    await setClaudeSessionSummary(opts.workspace, opts.claudeSessionId, summary).catch(() => {});
  }
}
