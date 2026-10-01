/**
 * Completion receipts for consult verbs that persist a post before finishing
 * follow-up work such as advancing the responder cascade. A receipt identifies
 * the post produced by this completed call; it does not make the write globally
 * idempotent.
 */
import { parseJsonWithTrailer, type AbortCompletionReceipt, type ToolResult } from '@papercusp/tooldef';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function consultPostPayload(result: ToolResult): Record<string, unknown> | null {
  const firstText = result.content.find(
    (item): item is Extract<ToolResult['content'][number], { type: 'text' }> => item.type === 'text',
  );
  if (!firstText) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(firstText.text);
  } catch {
    parsed = parseJsonWithTrailer(firstText.text)?.value;
  }
  const root = asRecord(parsed);
  return asRecord(root?.data) ?? root;
}

type ConsultPostingVerb = 'consult:reply' | 'consult:decline';

/**
 * If a completed consult post call returns after its deadline, let dispatch
 * report the committed post identity instead of a misleading retryable timeout.
 * Missing or malformed success evidence fails closed as recovery-incomplete.
 */
export function consultPostAbortCompletionReceipt(
  args: unknown,
  result: ToolResult,
  verb: ConsultPostingVerb,
): AbortCompletionReceipt {
  const payload = consultPostPayload(result);
  const postId = payload?.post_id;
  const conversationId = asRecord(args)?.conversation_id;
  if (payload?.ok === true && typeof postId === 'number' && Number.isSafeInteger(postId) && postId > 0) {
    if (typeof conversationId !== 'string' || conversationId.length === 0) {
      return {
        status: 'recovery-incomplete',
        reason: `${verb} args did not identify the conversation for the recorded post`,
        failures: ['missing-conversation-id'],
      };
    }
    return {
      status: 'recorded',
      effectRef: `${verb.replace(':', '-')}:${conversationId}:${String(postId)}`,
    };
  }
  return {
    status: 'recovery-incomplete',
    reason: `${verb} result did not confirm a persisted post id after abort`,
    failures: ['missing-post-id'],
  };
}
