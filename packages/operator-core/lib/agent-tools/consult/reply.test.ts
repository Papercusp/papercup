import { describe, expect, it } from 'vitest';
import type { ToolResult } from '@papercusp/tooldef';
import consultReplyTool from './reply';

const result = (payload: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
}) as unknown as ToolResult;

describe('consult:reply abort completion receipt', () => {
  it('surfaces the exact post recorded before a late cascade completion', () => {
    expect(consultReplyTool.idempotent).not.toBe(true);
    expect(consultReplyTool.abortCompletionReceipt).toEqual(expect.any(Function));

    const receipt = consultReplyTool.abortCompletionReceipt?.(
      { conversation_id: 'conv-123' },
      result({ data: { ok: true, post_id: 1151100 } }),
      { callId: 'call-123', toolName: 'consult:reply' },
    );

    expect(receipt).toEqual({
      status: 'recorded',
      effectRef: 'consult-reply:conv-123:1151100',
    });
  });

  it('fails closed when a completed response has no durable post identity', () => {
    const receipt = consultReplyTool.abortCompletionReceipt?.(
      { conversation_id: 'conv-123' },
      result({ data: { ok: true, role: 'responder' } }),
      { callId: 'call-124', toolName: 'consult:reply' },
    );

    expect(receipt).toMatchObject({
      status: 'recovery-incomplete',
      failures: ['missing-post-id'],
    });
  });
});
