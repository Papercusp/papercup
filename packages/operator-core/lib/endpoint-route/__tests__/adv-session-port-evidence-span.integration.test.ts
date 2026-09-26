import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
import { SESSION_PORT_PROTOCOL_VERSION, SESSION_PORT_TOKEN_ESTIMATOR, SESSION_PORT_TRANSFORM_VERSION } from '../../session-port/types';

const state = vi.hoisted(() => ({
  sql: null as unknown,
  sourceRow: null as unknown,
  inspectArgs: null as unknown,
  /** The row the port acquired its transcript for (WI-10003198). */
  acquiredRow: null as unknown,
}));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: state.sql }) as never,
}));
vi.mock('../../adv-sessions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../adv-sessions')>()),
  getAdvSessionInWorkspace: async () => state.sourceRow,
}));
vi.mock('../../workspace-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../workspace-registry')>()),
  activeWorkspaceId: () => 'evidence-span-ws',
}));
vi.mock('../../role-launch-spec', () => ({ buildLaunchSpec: async () => ({ promptText: 'fixture launch prompt' }) }));
vi.mock('../../model-context-budget.mjs', () => ({
  readLaunchContextText: () => '',
  appendCodexLaunchContextPrompt: (prompt: string) => prompt,
  buildContextBudget: () => ({ level: 'ok', window: 200_000, availableInputTokens: 100_000 }),
}));
vi.mock('../../session-port/store', () => ({ assertSessionPortStorageReady: async () => {} }));
vi.mock('../../session-port/service', () => ({
  acquireTrackedClaudeSource: async (row: unknown) => {
    state.acquiredRow = row;
    return {
      bytes: Buffer.from('fixture'), sha256: 'a'.repeat(64), highWaterBytes: 7,
      completeBytes: 7, source: 'archive-manifest', relpath: 'projects/source.jsonl',
    };
  },
  // This is synchronous in production. Keeping the fake synchronous is load-bearing:
  // the inspect route immediately reads the returned inspection's source identity.
  inspectAcquiredSessionPort: (args: unknown) => {
    state.inspectArgs = args;
    return {
      protocolVersion: SESSION_PORT_PROTOCOL_VERSION,
      source: {
        advSessionId: 41, nativeSessionId: 'source-native-session', backend: 'claude',
        workspaceId: 'evidence-span-ws', cwd: '/repo', planSlug: null,
        snapshotKind: 'archive-manifest', highWaterBytes: 7, completeBytes: 7, sha256: 'a'.repeat(64),
      },
      target: {
        backend: 'codex', provider: 'openai', model: null, account: 'default', contextWindow: 200_000,
        availableInputTokens: 100_000, contextSize: 'trimmed', launchContextHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      },
      fullHistoryEstimatedTokens: 7, fullPayloadEstimatedTokens: 7,
      tokenEstimator: SESSION_PORT_TOKEN_ESTIMATOR, requiresSummary: false,
      stats: {
        sourceRecords: 1, activePathRecords: 1, malformedRecords: 0, sidechainRecords: 0, compactedAncestors: 0,
        toolCalls: 0, toolResults: 0, unlinkedToolResults: 0, truncatedToolNarratives: 0, omittedAttachments: 0,
        textAttachments: 0, truncatedAttachments: 0, omittedThinkingBlocks: 0, omittedSignatureBlocks: 0,
        unsupportedBlocks: 0, syntheticRecords: 0, redactions: 0, controlBytesRemoved: 0, delimiterEscapes: 0,
      },
      warnings: [],
      disclosure: { newTargetSession: true, sourceUntouched: true, authorityCarried: true, targetEgress: 'openai/default', summarizerEgress: null },
      internal: {} as never,
    };
  },
  publicSessionPortInspection: (inspection: unknown) => inspection,
}));
vi.mock('../../session-port/telemetry', () => ({
  telemetryFromInspection: () => ({}),
  recordSessionPortTelemetry: async () => {},
}));

type Route = { method: string; path: string; handler: (request: Request, context?: unknown) => Promise<Response> };
const WS = 'evidence-span-ws';
const SESSION = 'source-native-session';
let db: FreshPgDb;
let sql: postgres.Sql;

beforeAll(async () => {
  db = await createFreshPgDb('session-port-evidence-span');
  sql = db.sql;
  state.sql = sql;
  await sql.unsafe(`CREATE TABLE IF NOT EXISTS harness_shared.session_turns (
    workspace_id text NOT NULL DEFAULT 'default', source_kind text NOT NULL, session_id text NOT NULL,
    turn_idx integer NOT NULL, ts timestamptz, speaker text NOT NULL, text text NOT NULL,
    ingested_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (workspace_id, source_kind, session_id, turn_idx)
  )`);
  // The owner bridge an earlier carry-respawn incarnation is resolved through (WI-10003198).
  await sql.unsafe(`ALTER TABLE harness_shared.session_turns ADD COLUMN IF NOT EXISTS owner text`);
}, 120_000);

afterAll(async () => { await db?.cleanup(); });

beforeEach(async () => {
  state.sourceRow = {
    id: 41, workspaceId: WS, planSlug: null, agent: 'claude', role: null, sessionId: SESSION,
    coordOwnerId: 'su-source', cwd: '/repo', startedAt: '2026-09-23T08:00:00.000Z', endedAt: '2026-09-23T08:30:00.000Z',
  };
  state.inspectArgs = null;
  state.acquiredRow = null;
  await sql`TRUNCATE harness_shared.session_turns CASCADE`;
  await sql`
    INSERT INTO harness_shared.session_turns (workspace_id, source_kind, session_id, turn_idx, ts, speaker, text)
    VALUES
      (${WS}, 'claude', ${SESSION}, 2, '2026-09-23T08:01:00.000Z'::timestamptz, 'user', 'first evidence'),
      (${WS}, 'claude', ${SESSION}, 4, '2026-09-23T08:02:00.000Z'::timestamptz, 'assistant', 'second evidence'),
      (${WS}, 'claude', 'other-session', 2, '2026-09-23T08:01:00.000Z'::timestamptz, 'user', 'wrong source'),
      ('other-workspace', 'claude', ${SESSION}, 2, '2026-09-23T08:01:00.000Z'::timestamptz, 'user', 'wrong workspace')
  `;
});

async function inspect(body: Record<string, unknown>): Promise<Response> {
  const routes = (await import('../routes/adv/sessions')).default as Route[];
  const route = routes.find((candidate) => candidate.method === 'POST' && candidate.path === '/adv/sessions/port/inspect');
  if (!route) throw new Error('session-port inspection route was not registered');
  return route.handler(new Request('http://localhost:3170/api/adv/sessions/port/inspect', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      protocolVersion: SESSION_PORT_PROTOCOL_VERSION, transformVersion: SESSION_PORT_TRANSFORM_VERSION,
      workspace: WS, sourceAdvSessionId: 41, targetBackend: 'codex',
      consultEvidenceSpan: { sessionId: SESSION, turnIndices: [4, 2], contextTurns: 2 }, ...body,
    }),
  }));
}

describe('session-port evidence-span route (P-007)', () => {
  it('resolves turns only from the exact source workspace/session and passes them to inspection', async () => {
    const response = await inspect({});
    expect(response.status).toBe(200);
    const args = state.inspectArgs as { evidenceSpan?: {
      sessionId: string; turnIndices: number[]; contextTurns: number;
      evidenceTurns: Array<{ turnIdx: number; speaker: string; text: string }>;
    } };
    expect(args.evidenceSpan).toMatchObject({ sessionId: SESSION, turnIndices: [4, 2], contextTurns: 2 });
    expect(args.evidenceSpan?.evidenceTurns.map((turn) => [turn.turnIdx, turn.speaker, turn.text]).sort((a, b) => Number(a[0]) - Number(b[0])))
      .toEqual([[2, 'user', 'first evidence'], [4, 'assistant', 'second evidence']]);
  });

  it('refuses evidence refs that name another tracked source session', async () => {
    const response = await inspect({ consultEvidenceSpan: { sessionId: 'wrong-session', turnIndices: [2], contextTurns: 2 } });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('exact source session') });
    expect(state.inspectArgs).toBeNull();
  });
});

describe('session-port evidence in an earlier carry-respawn incarnation (WI-10003198)', () => {
  // A carry-respawn rewrites its owner's row in place, so the router's matched
  // turns routinely live in a session the row no longer names. Measured shape:
  // fa2b9674 is an earlier incarnation of su-5078d176, whose row carries f56ecb13.
  const EARLIER = 'fa2b9674-2646-42fa-9135-3909f93fcd9a';
  const seedEarlier = async (owner: string) => {
    await sql`
      INSERT INTO harness_shared.session_turns (workspace_id, source_kind, session_id, turn_idx, ts, speaker, text, owner)
      VALUES
        (${WS}, 'claude', ${EARLIER}, 2, '2026-09-23T07:01:00.000Z'::timestamptz, 'user', 'earlier evidence', ${owner}),
        (${WS}, 'claude', ${EARLIER}, 4, '2026-09-23T07:02:00.000Z'::timestamptz, 'assistant', 'earlier answer', ${owner})
    `;
  };

  it('ports the earlier incarnation when session_turns names the row owner as its latest owner', async () => {
    await seedEarlier('su-source');
    const response = await inspect({ consultEvidenceSpan: { sessionId: EARLIER, turnIndices: [2, 4], contextTurns: 2 } });
    expect(response.status).toBe(200);
    // The transcript acquired and inspected is the earlier incarnation's, under
    // the row's own identity — never the row's current session.
    expect(state.acquiredRow).toMatchObject({ id: 41, coordOwnerId: 'su-source', sessionId: EARLIER });
    const args = state.inspectArgs as { sourceRow: { sessionId: string }; evidenceSpan: { sessionId: string; evidenceTurns: unknown[] } };
    expect(args.sourceRow.sessionId).toBe(EARLIER);
    expect(args.evidenceSpan.sessionId).toBe(EARLIER);
    expect(args.evidenceSpan.evidenceTurns).toHaveLength(2);
  });

  it('refuses a session latest-owned by a different owner, before acquiring anything', async () => {
    await seedEarlier('su-someone-else');
    const response = await inspect({ consultEvidenceSpan: { sessionId: EARLIER, turnIndices: [2, 4], contextTurns: 2 } });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('earlier incarnation of its owner') });
    expect(state.acquiredRow).toBeNull();
    expect(state.inspectArgs).toBeNull();
  });
});
