/** Opt-in acceptance against the current source, real SU bootstrap and engine.
 * Creates one named test conversation in the selected project and archives it.
 * No UI/PTY is launched. Provider tokens are spent only with the explicit flag;
 * backend is Claude and account defaults to `auto` so the gateway can choose
 * from its provider pool.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { SU_SESSION_PROTOCOL_VERSION, SU_SESSION_SCHEMA, type SuSessionEvent } from '@papercusp/chat-protocol';
import { confirmedProviderRateLimit } from './su-session-attached-live-rate-limit';

describe.skipIf(process.env.PAPERCUSP_REAL_ATTACHED_ENGINE !== '1')('live attached SU engine', () => {
  it('creates through launch-su, commits an owner turn, proves scoped SU tools, and ends the child', async (ctx) => {
    const [{ createChat, archiveChat, getChat }, { default: launchRoutes }, { suSessionRoutes }, { getRegisteredSuSessionHost }, { readSuperuserToken }, { activeWorkspaceId }, { readDurableSuSession }] = await Promise.all([
      import('./agent-chats-data'), import('./endpoint-route/routes/adv/launch-su'),
      import('./endpoint-route/routes/agent-chats/su-session'), import('./su-session-host'),
      import('./superuser-token'), import('./workspace-registry'), import('./su-session-persistence'),
    ]);
    const harness = process.env.PAPERCUSP_ATTACHED_TEST_HARNESS ?? 'papercusp';
    const backend = 'claude' as const;
    const account = process.env.PAPERCUSP_ATTACHED_TEST_ACCOUNT?.trim() || 'auto';
    const workspaceId = activeWorkspaceId();
    const created = await createChat({ slug: harness, role: 'operator', title: `PUI attached acceptance ${randomUUID()}` });
    expect(created.ok, !created.ok ? created.error : '').toBe(true);
    if (!created.ok) return;
    const chatId = created.data.id;
    const key = { workspaceId, harnessSlug: harness, agentChatId: chatId };
    const headers = { 'content-type': 'application/json', host: 'localhost', authorization: `Bearer ${readSuperuserToken()}` };
    const context = { params: { slug: harness, chatId } } as never;
    let host: ReturnType<typeof getRegisteredSuSessionHost>;
    let engineTaskId: string | undefined;
    let iterator: AsyncIterator<{ id: number; event: SuSessionEvent }> | undefined;
    try {
      const response = await launchRoutes.find((route) => route.method === 'POST')!.handler(new Request(
        'http://localhost/api/adv/sessions/launch-su', {
          method: 'POST', headers,
          body: JSON.stringify({ agent: backend, attached_engine: true, agent_chat_id: chatId,
            harness_slug: harness, account, carry: 'warm' }),
        }), context);
      const launched = await response.json() as { status: string; transport?: string; advSessionId: number; ownerId?: string };
      expect(response.status, JSON.stringify(launched)).toBe(200);
      expect(launched).toMatchObject({ status: 'ok', transport: 'structured' });
      const advSessionId = launched.advSessionId;
      const durable = await readDurableSuSession({ workspaceId, agentChatId: chatId });
      expect(durable).toMatchObject({ advSessionId, agentChatId: chatId, backend, harnessSlug: harness });
      host = getRegisteredSuSessionHost(key);
      if (!host) throw new Error('No live host after attached launch');
      const readyDeadline = Date.now() + 120_000;
      while (Date.now() < readyDeadline) {
        const snapshot = host.snapshot();
        if (snapshot.terminal) {
          const events = host.recent.map((entry) => entry.event);
          const rateLimit = confirmedProviderRateLimit(events);
          if (rateLimit.confirmed) {
            ctx.skip(`NOT MEASURED: provider account limit during engine startup (${rateLimit.signals[0]})`);
          }
          const failures = events.flatMap((event) => event.type === 'error' ? [`${event.code}: ${event.message}`] : []);
          throw new Error(`Attached ${backend} engine ended before ready: lifecycle=${host.descriptor().lifecycle}; errors=${JSON.stringify(failures)}; snapshot=${JSON.stringify(snapshot)}`);
        }
        if (snapshot.executorAttached && snapshot.streamReady) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const readySnapshot = host.snapshot();
      if (!readySnapshot.executorAttached || !readySnapshot.streamReady || readySnapshot.terminal) {
        const events = host.recent.map((entry) => entry.event);
        const rateLimit = confirmedProviderRateLimit(events);
        if (rateLimit.confirmed) {
          ctx.skip(`NOT MEASURED: provider account limit during engine startup (${rateLimit.signals[0]})`);
        }
        const failures = events.flatMap((event) => event.type === 'error' ? [`${event.code}: ${event.message}`] : []);
        throw new Error(`Attached ${backend} engine did not become ready in 120s: lifecycle=${host.descriptor().lifecycle}; errors=${JSON.stringify(failures)}; snapshot=${JSON.stringify(readySnapshot)}`);
      }
      const identity = host.descriptor().identity;
      expect(identity).toMatchObject({ workspaceId, harnessSlug: harness, ownerId: launched.ownerId });
      expect(identity.nativeSessionId).toBeTruthy();
      const { listTasks } = await import('./task-manager/store');
      const tasks = await listTasks({ workspaceId, sessionId: identity.nativeSessionId!, coordOwnerId: identity.ownerId, classes: ['agent-session'] });
      expect(tasks).toHaveLength(1);
      engineTaskId = tasks[0].taskId;
      expect(tasks[0].argv.length).toBeGreaterThan(0);
      expect(tasks[0].detail).toMatchObject({ coordOwnerId: identity.ownerId, transport: 'structured' });
      iterator = host.subscribe()[Symbol.asyncIterator]();
      const nonce = `PUI-ATTACHED-${randomUUID()}`;
      const content = `This is a bounded, read-only PUI transport acceptance test. Call the Papercusp coord:whoami tool exactly once (use tools:invoke if deferred), then reply with ${nonce} and the returned ownerId and workspaceId. Do not change files, send messages, register work, or start other work.`;
      const command = { schema: SU_SESSION_SCHEMA, protocolVersion: SU_SESSION_PROTOCOL_VERSION,
        type: 'owner_turn', commandId: `command-${randomUUID()}`, turnId: `turn-${randomUUID()}`,
        issuedAt: new Date().toISOString(), target: identity, content };
      const commandRoute = suSessionRoutes.find((route) => route.method === 'POST')!;
      const accepted = await commandRoute.handler(new Request('http://localhost/commands', { method: 'POST', headers, body: JSON.stringify(command) }), context);
      expect(accepted.status, JSON.stringify(await accepted.json())).toBe(202);
      const saved = await getChat({ slug: harness, chatId });
      expect(saved.ok && saved.data.transcript.some((turn) => turn.content === content)).toBe(true);
      const observedEvents: SuSessionEvent[] = [];
      let toolIdentity = false;
      let reply = false;
      const deadline = Date.now() + 120_000;
      while ((!toolIdentity || !reply) && Date.now() < deadline) {
        let timer: ReturnType<typeof setTimeout>;
        let next: IteratorResult<{ id: number; event: SuSessionEvent }>;
        try {
          next = await Promise.race([iterator.next(), new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('Timed out waiting for the scoped SU tool and reply')), Math.max(1, deadline - Date.now()));
          })]).finally(() => clearTimeout(timer));
        } catch (error) {
          const buffered = host.recent.map((entry) => entry.event);
          const rateLimit = confirmedProviderRateLimit([...observedEvents, ...buffered]);
          if (rateLimit.confirmed) {
            ctx.skip(`NOT MEASURED: provider account limit during the owner turn (${rateLimit.signals[0]})`);
          }
          const recentTypes = buffered.slice(-8).map((event) => event.type).join(',') || 'none';
          throw new Error(`${String(error)}; lifecycle=${host.descriptor().lifecycle}; bufferedEvents=${buffered.length}; recentTypes=${recentTypes}`);
        }
        if (next.done) throw new Error('SU stream ended before acceptance');
        const event = next.value.event;
        observedEvents.push(event);
        if (event.type === 'error') {
          const rateLimit = confirmedProviderRateLimit(observedEvents);
          if (rateLimit.confirmed) {
            ctx.skip(`NOT MEASURED: provider account limit during the owner turn (${rateLimit.signals[0]})`);
          }
          throw new Error(`${event.code}: ${event.message}`);
        }
        if (event.type === 'tool' && event.phase === 'completed' && !event.isError) {
          const output = JSON.stringify(event.output);
          toolIdentity ||= output.includes(identity.ownerId) && output.includes(workspaceId);
        }
        if (event.type === 'transcript' && 'content' in event && event.role === 'assistant' && event.content?.includes(nonce)) {
          expect(event.turnId).toBe(command.turnId);
          reply = true;
        }
      }
      const rateLimit = confirmedProviderRateLimit(observedEvents);
      if (rateLimit.confirmed) {
        ctx.skip(`NOT MEASURED: provider account limit during the owner turn (${rateLimit.signals[0]})`);
      }
      expect({ toolIdentity, reply }).toEqual({ toolIdentity: true, reply: true });
      const replay = await commandRoute.handler(new Request('http://localhost/commands', { method: 'POST', headers, body: JSON.stringify(command) }), context);
      expect(await replay.json()).toMatchObject({ ok: true, replayed: true });
      console.log(JSON.stringify({ acceptance: 'attached-su-identity', workspaceId, harness, chatId, ownerId: identity.ownerId, nativeSessionId: identity.nativeSessionId, toolIdentity, reply }));
    } finally {
      host ??= getRegisteredSuSessionHost(key);
      if (host && !host.snapshot().terminal) {
        const terminal = await host.startCommand({ schema: SU_SESSION_SCHEMA, protocolVersion: SU_SESSION_PROTOCOL_VERSION,
          type: 'end', commandId: `end-${randomUUID()}`, issuedAt: new Date().toISOString(), target: host.descriptor().identity }).terminal;
        expect(terminal.status).toBe('completed');
      }
      host?.dispose('live acceptance finished');
      await iterator?.return?.();
      if (engineTaskId) {
        const { getTask } = await import('./task-manager/store');
        await vi.waitFor(async () => expect((await getTask(engineTaskId!))?.endedAt).toBeTruthy(), { timeout: 5_000 });
      }
      expect((await archiveChat({ slug: harness, chatId })).ok).toBe(true);
    }
  }, 240_000);
});
