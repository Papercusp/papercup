/**
 * CLAUDE CODE injection adapter.
 *
 * Migrated VERBATIM IN SEMANTICS from the two shell hooks it replaces:
 *   apps/operator/scripts/hooks/cc/userpromptsubmit-memory.sh      (turn-start)
 *   apps/operator/scripts/hooks/cc/posttoolbatch-midturn-context.sh (mid-turn)
 *
 * Claude is 100% of current injection traffic, so this adapter's job is to
 * change NOTHING observable. Any behavioural difference here is a regression,
 * however tidy it looks.
 */

/** @typedef {import('../ports.mjs').InjectionPort} InjectionPort */

import { buildDigest, clampPrompt } from '../core.mjs';

export const client = 'claude';

/**
 * ⚠ MID-TURN IS PostToolBatch, NOT PreToolUse — do NOT "fix" this back (D-027).
 *
 * PreToolUse does not inject additionalContext unless it also carries a
 * `permissionDecision`, and emitting `permissionDecision: 'allow'` from a
 * CONTEXT hook would blanket auto-approve every tool call it matched, bypassing
 * the permission system entirely. A hook that only wants to SAY something must
 * never also vote on whether the call runs.
 *
 * PostToolBatch carries no permission semantics, takes no matcher (so it fires
 * on every batch), and fires after a batch resolves BUT BEFORE THE NEXT MODEL
 * REQUEST — precisely when the agent is about to decide what to do next. This
 * was found by building the PreToolUse version first and watching it deliver
 * nothing with every unit test green.
 *
 * @param {string} nativeEvent
 * @returns {InjectionPort | null}
 */
export function portForEvent(nativeEvent) {
  if (nativeEvent === 'UserPromptSubmit') return 'turn-start';
  if (nativeEvent === 'PostToolBatch') return 'mid-turn';
  return null;
}

/**
 * @param {InjectionPort} port
 * @param {any} event  Claude's hook event JSON, as delivered on stdin.
 * @returns {object | null} null = no signal, spend nothing
 */
export function parse(port, event) {
  if (!event || typeof event !== 'object') return null;

  if (port === 'turn-start') {
    const prompt = event.prompt;
    // A non-string prompt is malformed input, not an empty one: bail rather
    // than coercing, so a client-side shape change surfaces as silence here
    // instead of as a garbage query server-side.
    if (typeof prompt !== 'string') return null;
    return { prompt: clampPrompt(prompt) };
  }

  if (port === 'mid-turn') {
    const calls = event.tool_calls;
    if (!Array.isArray(calls) || calls.length === 0) return null;
    const toolCalls = buildDigest(
      calls.map((c) => ({
        tool: c && typeof c === 'object' ? c.tool_name : undefined,
        toolInput: c && typeof c === 'object' ? c.tool_input : undefined,
        toolResponse: c && typeof c === 'object' ? c.tool_response : undefined,
      })),
    );
    if (toolCalls.length === 0) return null;
    return { toolCalls };
  }

  return null;
}

/**
 * Claude reads injected context from `hookSpecificOutput.additionalContext`,
 * and `hookEventName` must echo the event that produced it.
 * @param {InjectionPort} port
 * @param {string} text
 * @returns {string | null}
 */
export function render(port, text) {
  const hookEventName =
    port === 'turn-start' ? 'UserPromptSubmit' : port === 'mid-turn' ? 'PostToolBatch' : null;
  if (!hookEventName) return null;
  return JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: text } });
}

export default { client, portForEvent, parse, render };
