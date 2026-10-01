import type { ToolResult } from '@papercusp/tooldef';
import { describe, expect, it } from 'vitest';
import decline from './decline';
import reply from './reply';

function result(payload: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ data: payload }) }] };
}

describe('consult post abort-completion receipts', () => {
  const args = { conversation_id: 'conv-1' };
  const completedPost = result({ ok: true, post_id: 42 });
  const attempt = { callId: 'call-1', toolName: 'consult:decline' };

  it('reports a late completed decline by its committed post identity', () => {
    expect(decline.abortCompletionReceipt?.(args, completedPost, attempt)).toEqual({
      status: 'recorded',
      effectRef: 'consult-decline:conv-1:42',
    });
  });

  it('preserves the existing reply receipt identity while sharing the parser', () => {
    expect(reply.abortCompletionReceipt?.(args, completedPost, { ...attempt, toolName: 'consult:reply' })).toEqual({
      status: 'recorded',
      effectRef: 'consult-reply:conv-1:42',
    });
  });

  it('fails closed when completion does not prove a post id or conversation', () => {
    expect(decline.abortCompletionReceipt?.(args, result({ ok: true }), attempt)).toMatchObject({
      status: 'recovery-incomplete',
      failures: ['missing-post-id'],
    });
    expect(decline.abortCompletionReceipt?.({}, completedPost, attempt)).toMatchObject({
      status: 'recovery-incomplete',
      failures: ['missing-conversation-id'],
    });
  });
});
