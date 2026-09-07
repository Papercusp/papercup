import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { SU_SESSION_SCHEMA, type SuSessionDescriptor } from '@papercusp/chat-protocol';
import type { OrgTestDb } from '../test/_org-test-db';

const fixture = vi.hoisted(() => ({ sql: null as unknown }));
vi.mock('@papercusp/db-org', async (original) => ({
  ...(await original<object>()), getOrgPg: () => ({ sql: fixture.sql }),
}));

const { createOrgTestDb } = await import('../test/_org-test-db');
const { pgSuSessionCommandStore } = await import('./su-session-commands');
const { SuSessionHost, _resetSuSessionHostsForTest, registerSuSessionHost } = await import('./su-session-host');
const { suSessionRoutes } = await import('./endpoint-route/routes/agent-chats/su-session');
const { runWithWorkspace } = await import('./workspace-als');

const workspaceId = 'papercusp-workspace';
const harnessSlug = 'papercusp';
const agentChatId = 'pui-durable-command-test';
let db: OrgTestDb;
let sql: Sql;
let advSessionId: number;

beforeAll(async () => {
  db = await createOrgTestDb();
  sql = db.adminSql;
  fixture.sql = sql;
}, 180_000);
afterAll(async () => { await db?.cleanup(); });
afterEach(() => { _resetSuSessionHostsForTest(); });
beforeEach(async () => {
  await sql`DELETE FROM harness_shared.adv_sessions WHERE workspace_id = ${workspaceId}`;
  await sql`DELETE FROM harness_shared.agent_chats_consolidated WHERE workspace_id = ${workspaceId}`;
  await sql`
    INSERT INTO harness_shared.agent_chats_consolidated
      (workspace_id, harness_slug, id, role, transcript, created_at, updated_at, su_runtime_class)
    VALUES (${workspaceId}, ${harnessSlug}, ${agentChatId}, 'operator', '[]'::jsonb,
            ${Date.now()}, ${Date.now()}, 'su-session')`;
  const [row] = await sql<{ id: number }[]>`
    INSERT INTO harness_shared.adv_sessions (workspace_id, mode, agent, coord_owner_id, su_agent_chat_id)
    VALUES (${workspaceId}, 'console', 'claude', 'su-command-fixture', ${agentChatId}) RETURNING id`;
  advSessionId = Number(row.id);
});

function descriptor(): SuSessionDescriptor<'claude'> {
  const supported = { state: 'supported', implementation: 'host' } as const;
  return {
    identity: { workspaceId, harnessSlug, agentChatId, advSessionId, backend: 'claude',
      ownerId: 'su-command-fixture', nativeSessionId: 'native-command-fixture' },
    lifecycle: 'ready', runtimeGeneration: 1, role: 'su', carry: 'warm',
    model: null, accountRoute: 'default', modes: [],
    capabilities: {
      commands: { owner_turn: supported, interrupt: supported, resume: supported, fork: supported, focus: supported, end: supported },
      features: { 'tool-events': supported, 'interactive-cards': supported, 'reasoning-stream': supported, usage: supported, compaction: supported },
    },
    backendExtension: { backend: 'claude', configDir: null, configDirSource: 'unknown' },
  };
}

function ownerTurn(commandId = 'durable-first-turn') {
  return {
    schema: SU_SESSION_SCHEMA, protocolVersion: 1 as const, type: 'owner_turn' as const,
    commandId, issuedAt: '2026-09-07T00:00:00.000Z', target: descriptor().identity,
    turnId: `turn-${commandId}`, content: '  Exact Unicode text λ\nsecond line  ',
  };
}

async function storedTurns() {
  const [row] = await sql<{ transcript: Array<{ content: string; su_command: { command: unknown; outcome?: unknown } }> }[]>`
    SELECT transcript FROM harness_shared.agent_chats_consolidated
     WHERE workspace_id = ${workspaceId} AND id = ${agentChatId}`;
  return row.transcript;
}

describe('SU command acceptance through real PostgreSQL', () => {
  it('commits the exact owner turn before the HTTP acknowledgement and replays after host replacement', async () => {
    const execute = vi.fn(async () => {
      expect((await storedTurns())[0].content).toBe(ownerTurn().content);
      return { status: 'completed' as const };
    });
    const host = new SuSessionHost({ descriptor: descriptor(), executeCommand: execute });
    registerSuSessionHost(host);
    const response = await runWithWorkspace(workspaceId, () => suSessionRoutes[2].handler(
      new Request('http://localhost/api/su-session/commands', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(ownerTurn()),
      }),
      { params: { slug: harnessSlug, chatId: agentChatId } } as never,
    ));
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ ok: true, accepted: { status: 'accepted' } });
    const dispatch = await host.acceptCommand(ownerTurn());
    expect((await dispatch.terminal).status).toBe('completed');
    _resetSuSessionHostsForTest();
    const replacement = new SuSessionHost({ descriptor: descriptor(), executeCommand: execute });
    const replay = await replacement.acceptCommand(ownerTurn());
    expect(replay.replayed).toBe(true);
    expect((await replay.terminal).status).toBe('completed');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(await storedTurns()).toHaveLength(1);
  });

  it('reserves one turn under concurrent connections and refuses changed command text', async () => {
    const store = pgSuSessionCommandStore({ sql });
    const reservations = await Promise.all(Array.from({ length: 6 }, () => store.reserve(ownerTurn(), 'exact-payload')));
    expect(reservations.filter((r) => r.created)).toHaveLength(1);
    expect(await storedTurns()).toHaveLength(1);
    const execute = vi.fn(async () => ({ status: 'completed' as const }));
    const host = new SuSessionHost({ descriptor: descriptor(), executeCommand: execute });
    await expect(host.acceptCommand({ ...ownerTurn(), content: 'changed' }, store)).rejects.toMatchObject({
      code: 'command_id_conflict',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('survives a restart between reservation and dispatch without silently re-executing', async () => {
    // Crash injection at the only safe handoff point: committed, not dispatched.
    const store = pgSuSessionCommandStore({ sql });
    const execute = vi.fn(async () => ({ status: 'completed' as const }));
    const interruptedStore = {
      ...store,
      reserve: async (...args: Parameters<typeof store.reserve>) => {
        await store.reserve(...args);
        throw new Error('injected host exit before acknowledgement');
      },
    };
    const host = new SuSessionHost({ descriptor: descriptor(), executeCommand: execute });
    await expect(host.acceptCommand(ownerTurn(), interruptedStore)).rejects.toThrow('injected host exit');
    host.dispose();
    const replacement = new SuSessionHost({ descriptor: descriptor(), executeCommand: execute });
    const replay = await replacement.acceptCommand(ownerTurn(), store);
    expect(replay.replayed).toBe(true);
    expect(await replay.terminal).toMatchObject({ refusal: { code: 'command_delivery_unknown' } });
    expect(execute).not.toHaveBeenCalled();
    expect(await storedTurns()).toHaveLength(1);
  });

  it('rejects cross-workspace, wrong-owner and archived targets without persisting text', async () => {
    const store = pgSuSessionCommandStore({ sql });
    for (const target of [
      { ...ownerTurn().target, workspaceId: 'another-workspace' },
      { ...ownerTurn().target, ownerId: 'another-owner' },
      { ...ownerTurn().target, harnessSlug: 'another-project' },
    ]) {
      await expect(store.reserve({ ...ownerTurn(), target }, 'payload')).rejects.toThrow('identity-bound');
    }
    await sql`UPDATE harness_shared.agent_chats_consolidated SET archived_at = ${Date.now()}
      WHERE workspace_id = ${workspaceId} AND id = ${agentChatId}`;
    await expect(store.reserve(ownerTurn(), 'payload')).rejects.toThrow('identity-bound');
    expect(await storedTurns()).toHaveLength(0);
  });
});
