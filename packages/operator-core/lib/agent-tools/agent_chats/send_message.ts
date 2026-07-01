/**
 * agent_chats:send_message — append a user message to an existing
 * agent chat. The harness's chat-stream machinery (SSE) picks up the
 * insert and produces the assistant reply asynchronously; this tool
 * is fire-and-forget. Use after `agent_chats:create` to start a
 * conversation, or to follow up in an existing thread.
 *
 * Replaces the UI-bolt-on `dispatchToAgent` + `followUpInChat` paths
 * that lived in `agent-tools-shared.mjs` (oracle/delegate MCP
 * stdio servers). Those issued HTTP POSTs against
 * /api/harness/:slug/agent-chats/:chatId/messages and didn't wait
 * for the SSE response. This tool does the same — POSTs the message
 * and returns immediately. Watchers (operator dock, mobile app) see
 * the assistant reply stream via the chat's existing SSE channel.
 */

import { z } from 'zod';
import { operatorApiBase } from '../../operator-api-base';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';

export default defineTool({
  name: 'agent_chats:send_message',
  description:
    'Append a user message to an existing agent chat. The harness streams the assistant reply via SSE; this tool returns as soon as the message is accepted. Pair with agent_chats:create to start a new conversation.',
  capability: 'agent_chats:write',
  guidance: {
    when: 'Step 2 of the dispatch flow — you just called `agent_chats:create` and need to post the user\'s first message to kick off the conversation. Also for follow-up messages on an existing chat the user named.',
    notWhen: 'For broadcasting to multiple recipients (inbox-style), use `messages:send`. For the user\'s own chat with you, just speak.',
    chaining: 'Follow `agent_chats:create` (or `agent_chats:list` if resuming). Then `ui:dispatch` to take the user to the chat.',
    seeAlso: [
      'agent_chats:create (start the chat first)',
      'agent_chats:list (find the chat if resuming)',
    ],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  rolesQuota: { worker: { perChunk: 10 }, operator: { perRun: 100 } },
  args: z.object({
    slug: z.string().min(1),
    chatId: z.string().min(1),
    content: z.string().min(1),
  }),
  async handler(args) {
    const base = operatorApiBase();
    // Fire-and-forget POST — the messages endpoint starts an SSE
    // stream that drives the assistant reply. We don't consume it
    // here; the operator dock / mobile / chat UI handle that.
    // Using a 1s timeout so a hung endpoint can't tie up this tool
    // call; the message is either accepted in milliseconds (insert
    // + stream start) or it's a real failure worth surfacing.
    const url = `${base}/api/harness/${encodeURIComponent(args.slug)}/agent-chats/${encodeURIComponent(args.chatId)}/messages`;
    let initialStatus: number;
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: args.content }),
        signal: AbortSignal.timeout(2000),
      });
      initialStatus = r.status;
      // 4xx are real errors (chat archived, cost cap, in-flight reply
      // already running). 2xx + SSE body means accepted.
      if (initialStatus >= 400) {
        const errText = await r.text().catch(() => '');
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ error: `send_message failed: HTTP ${initialStatus}`, body: errText.slice(0, 400) }),
          }],
          isError: true,
        };
      }
    } catch (err) {
      // Timeout during streaming is expected — the stream stays open
      // until the assistant finishes. Anything else (network error,
      // operator down) is a real failure.
      if (err instanceof Error && err.name === 'TimeoutError') {
        // Accepted: the operator started streaming the assistant
        // reply, just hasn't finished within our 2s window. That's
        // the happy path for fire-and-forget.
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ ok: true, chatId: args.chatId, slug: args.slug, mode: 'fire-and-forget' }),
          }],
        };
      }
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ error: `send_message exception: ${err instanceof Error ? err.message : String(err)}` }),
        }],
        isError: true,
      };
    }
    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: true, chatId: args.chatId, slug: args.slug }) }],
    };
  },
});
