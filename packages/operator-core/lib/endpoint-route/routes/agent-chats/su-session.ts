/** P-003: typed SU-session attachment on the existing agent-chats transport. */
import { defineTool } from '@papercusp/agent-mcp';
import { activeWorkspaceId } from '../../../workspace-registry';
import { SuSessionHostError, createSuSessionEventResponse, getRegisteredSuSessionHost } from '../../../su-session-host';

function hostFor(slug: string, chatId: string) {
  return getRegisteredSuSessionHost({
    workspaceId: activeWorkspaceId(),
    harnessSlug: slug,
    agentChatId: chatId,
  });
}

const snapshotRoute = defineTool({
  method: 'GET',
  path: '/harness/:slug/agent-chats/:chatId/su-session',
  auth: 'public',
  handler(_request, context) {
    const host = hostFor(context.params.slug, context.params.chatId);
    if (!host) {
      return Response.json(
        {
          error: 'no SU session is attached to this agent chat',
          code: 'su_session_not_attached',
        },
        { status: 404 },
      );
    }
    return Response.json({ ok: true, ...host.snapshot() });
  },
});

const eventsRoute = defineTool({
  method: 'GET',
  path: '/harness/:slug/agent-chats/:chatId/su-session/events',
  auth: 'public',
  handler(request, context) {
    const host = hostFor(context.params.slug, context.params.chatId);
    if (!host) {
      return Response.json(
        {
          error: 'no SU session is attached to this agent chat',
          code: 'su_session_not_attached',
        },
        { status: 404 },
      );
    }
    return createSuSessionEventResponse(request, host);
  },
});

const commandRoute = defineTool({
  method: 'POST',
  path: '/harness/:slug/agent-chats/:chatId/su-session/commands',
  auth: 'public',
  async handler(request, context) {
    const host = hostFor(context.params.slug, context.params.chatId);
    if (!host) {
      return Response.json(
        {
          error: 'no SU session is attached to this agent chat',
          code: 'su_session_not_attached',
        },
        { status: 404 },
      );
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: 'invalid JSON command body', code: 'invalid_command' }, { status: 400 });
    }
    try {
      const dispatch = host.startCommand(body);
      if (!dispatch.accepted) {
        return Response.json(
          {
            ok: false,
            replayed: dispatch.replayed,
            terminal: await dispatch.terminal,
          },
          { status: 409 },
        );
      }
      return Response.json(
        {
          ok: true,
          replayed: dispatch.replayed,
          accepted: dispatch.accepted,
        },
        { status: 202 },
      );
    } catch (error) {
      if (error instanceof SuSessionHostError) {
        return Response.json({ error: error.message, code: error.code }, { status: error.status });
      }
      return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
    }
  },
});

export const suSessionRoutes = [snapshotRoute, eventsRoute, commandRoute];

export default suSessionRoutes;
