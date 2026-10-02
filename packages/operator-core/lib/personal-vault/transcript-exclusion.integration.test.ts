/**
 * Transcript exclusion against real Postgres (WI-10005552, plan
 * personal-data-reader-set-labels-2026-10-01 P-013, D-006 point 3, D-009, BAR R-9).
 *
 * A turn agent A recorded inside one of its disclosure windows
 * [delivered_at, released_at) is withheld from every caller but A; an
 * unattributed turn inside ANY other agent's window is withheld too. This suite
 * drives the real sessions:read and sessions:search handlers through projected
 * dispatch on the migrated throwaway database and asserts:
 *
 *  - the SQL rule (restrictedTurnSql) and the TypeScript rule
 *    (TranscriptExclusion.withholds) agree on every fixture turn, window
 *    boundaries included;
 *  - a withheld turn's text never reaches another caller, by read, verbatim or
 *    hybrid search, a context window, or the tool-part caveat;
 *  - the withheld count a search reports does not depend on the query (D-009):
 *    a query that matches only a restricted turn and a query that matches
 *    nothing report the same receipt;
 *  - the recording agent still sees its own turns, and an unreadable ledger
 *    refuses the read instead of serving it unfiltered.
 *
 * Seams pinned: the feature gate, the live-transcript refresh, the archive
 * fall-through, filter resolution and the query embedder (none of them decide
 * exclusion). Consult routing is covered in consult/relevance-router.integration.test.ts.
 */
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const WS = 'transcript-excl-test';
const PEER = 'su-tx-peer';
const READER = 'su-tx-reader';
const OTHER = 'su-tx-other';
const SECRET = 'zebracopper: Alice says the merger closes Friday';
const TOOL_ONLY = 'toolonlyquasar';

// The peer's disclosure window is [T1, T3).
const T0 = '2026-01-01T00:30:00Z';
const T1 = '2026-01-01T01:00:00Z';
const T2 = '2026-01-01T02:00:00Z';
const T3 = '2026-01-01T03:00:00Z';

vi.mock('../agent-tools/sessions/_shared', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  sessionSearchEnabled: vi.fn(async () => true),
  refreshTargetSessionBeforeRead: vi.fn(async () => ({ attempted: 0, refreshed: 0 })),
  refreshLiveSessionsBeforeRead: vi.fn(async () => ({ attempted: 0, refreshed: 0 })),
}));
vi.mock('../agent-tools/search/filters', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveSearchFilters: vi.fn(async () => ({ filters: undefined, selfSession: null })),
}));
vi.mock('../session-archive-read', () => ({ readArchivedSessionTurns: vi.fn(async () => null) }));
// The caller identity is the coordination ownerId; tests name it as uiClientId.
vi.mock('../agent-tools/coordination/identity', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveAgentIdentity: (ctx: { uiClientId?: string | null }) => ({ ownerId: ctx?.uiClientId ?? null, ownerLabel: 'test' }),
}));
// No embedding service here: hybrid search runs its lexical leg only.
vi.mock('../agent-tools/search/embedder', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  buildQueryEmbedder: vi.fn(async () => null),
}));

const { createOrgTestDb } = await import('../../test/_org-test-db');
const {
  loadTranscriptExclusion,
  restrictedTurnSql,
  countRestrictedTurnsInScope,
  D006_TRANSCRIPT_RULE,
} = await import('./transcript-exclusion');
await import('../agent-tools/sessions/read');
await import('../agent-tools/sessions/search');
const { dispatchProjectedTool, lookupByMcpName } = await import('@papercusp/agent-mcp');
type OrgTestDb = import('../../test/_org-test-db').OrgTestDb;

let org: OrgTestDb;
let sql: postgres.Sql;
let userId: string;

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO harness_shared.users (username, display_name)
    VALUES (${'transcript-excl-' + Date.now()}, 'Transcript Exclusion')
    RETURNING id`;
  userId = user.id;
  await sql`
    INSERT INTO harness_shared.personal_disclosures
      (workspace_id, user_id, agent_owner_id, document_id, source, level, reader_set,
       delivered_via, delivered_at, released_at, released_by, release_ref)
    VALUES (${WS}, ${userId}::uuid, ${PEER}, gen_random_uuid(), 'gmail', 'participants',
            ${['owner@me.example']}::text[], 'personal:search', ${T1}::timestamptz,
            ${T3}::timestamptz, 'owner', 'test-release')`;
  await sql`
    INSERT INTO harness_shared.session_turns
      (workspace_id, source_kind, session_id, turn_idx, ts, owner, speaker, text)
    VALUES
      (${WS}, 'claude', 'peer-sess', 0, ${T0}::timestamptz, ${PEER}, 'assistant', 'alpha public preface'),
      (${WS}, 'claude', 'peer-sess', 1, ${T1}::timestamptz, ${PEER}, 'assistant', 'boundary start note'),
      (${WS}, 'claude', 'peer-sess', 2, ${T2}::timestamptz, ${PEER}, 'assistant', ${'alpha ' + SECRET}),
      (${WS}, 'claude', 'peer-sess', 3, ${T3}::timestamptz, ${PEER}, 'assistant', 'alpha after release'),
      (${WS}, 'claude', 'other-sess', 0, ${T2}::timestamptz, ${OTHER}, 'assistant', 'alpha other agent'),
      (${WS}, 'claude', 'orphan-sess', 0, ${T2}::timestamptz, NULL, 'assistant', 'alpha orphan line')`;
  await sql`
    INSERT INTO harness_shared.session_turn_parts
      (workspace_id, source_kind, session_id, part_idx, ts, owner, speaker, part_kind, tool_name, text)
    VALUES (${WS}, 'claude', 'peer-sess', 5, ${T2}::timestamptz, ${PEER}, 'assistant', 'tool_result', 'Bash',
            ${'output: ' + TOOL_ONLY})`;
}, 120_000);

afterAll(async () => {
  if (org && userId) await org.adminSql`DELETE FROM harness_shared.users WHERE id = ${userId}`.catch(() => {});
  await org?.cleanup();
});

function ctxFor(caller: string) {
  return {
    log: vi.fn(), signal: new AbortController().signal, progress: vi.fn(), emit: vi.fn(),
    workspaceId: WS, uiClientId: caller, isSuperuser: true,
    runId: `transcript-exclusion-${caller}`, role: 'operator',
    gateBypass: { role: true, capability: true, quota: true },
    transport: 'mcp', requestedFormat: 'json', requestedStructured: true,
    tx: sql,
  } as never;
}

async function dispatch(tool: 'sessions:read' | 'sessions:search', caller: string, args: Record<string, unknown>) {
  return dispatchProjectedTool(lookupByMcpName(tool)!, tool, args, ctxFor(caller), {});
}

interface Receipt { restricted_turns: number; unattributed_turns?: number; rule: string; [k: string]: number | string | undefined }
interface ReadOut { ok: boolean; turn_count: number; turns: Array<{ turn_idx: number; text: string }>; withheld?: Receipt }
interface SearchOut {
  ok: boolean;
  total_hits: number;
  hint?: string;
  results: Array<{ ref?: string; excerpt?: string }>;
  withheld?: Receipt;
}

async function call<T>(tool: 'sessions:read' | 'sessions:search', caller: string, args: Record<string, unknown>): Promise<T> {
  const result = await dispatch(tool, caller, args);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  return result.result!.structuredContent as unknown as T;
}

/** `session_id:turn_idx` of every fixture turn the SQL rule withholds from `caller`. */
async function sqlWithheld(caller: string): Promise<string[]> {
  const rows = await sql<Array<{ key: string }>>`
    SELECT st.session_id || ':' || st.turn_idx AS key
      FROM harness_shared.session_turns st
     WHERE st.workspace_id = ${WS} AND ${restrictedTurnSql(sql, 'st', [caller])}
     ORDER BY 1`;
  return rows.map((r) => r.key);
}

describe('D-006 transcript rule — SQL and TypeScript agree', () => {
  it('withholds the peer’s in-window turns and the unattributed in-window turn from another reader, boundaries included', async () => {
    // [T1, T3): the turn AT delivered_at is in, the turn AT released_at is out.
    expect(await sqlWithheld(READER)).toEqual(['orphan-sess:0', 'peer-sess:1', 'peer-sess:2']);
    // The recording agent sees its own turns; no OTHER agent's window covers the orphan.
    expect(await sqlWithheld(PEER)).toEqual([]);
  });

  it.each([READER, PEER, OTHER])('restrictedTurnSql matches TranscriptExclusion.withholds for caller %s', async (caller) => {
    const rows = await sql<Array<{ owner: string | null; at: Date; withheld: boolean }>>`
      SELECT st.owner, COALESCE(st.ts, st.ingested_at) AS at,
             ${restrictedTurnSql(sql, 'st', [caller])} AS withheld
        FROM harness_shared.session_turns st
       WHERE st.workspace_id = ${WS}`;
    expect(rows.length).toBe(6);
    const exclusion = await loadTranscriptExclusion(sql, {
      selfOwnerIds: [caller],
      stamps: rows.map((r) => ({ owner: r.owner, at: r.at })),
    });
    for (const row of rows) {
      expect(exclusion.withholds({ owner: row.owner, at: row.at }) !== null, JSON.stringify(row)).toBe(row.withheld);
    }
  });

  it('countRestrictedTurnsInScope counts both reasons, and nothing for the recording agent', async () => {
    const scope = sql`st.workspace_id = ${WS}`;
    expect(await countRestrictedTurnsInScope(sql, { selfOwnerIds: [READER], scope })).toEqual({
      turns: 3,
      byReason: { 'disclosure-window': 2, unattributed: 1 },
    });
    expect((await countRestrictedTurnsInScope(sql, { selfOwnerIds: [PEER], scope })).turns).toBe(0);
  });
});

describe('sessions:read', () => {
  it('serves another reader only the turns outside the window and counts the rest', async () => {
    const out = await call<ReadOut>('sessions:read', READER, { session: 'peer-sess', source_kind: 'claude' });
    expect(out.turns.map((t) => t.turn_idx)).toEqual([0, 3]);
    expect(out.withheld).toMatchObject({ restricted_turns: 2, rule: D006_TRANSCRIPT_RULE });
    expect(JSON.stringify(out)).not.toContain('zebracopper');
    expect(JSON.stringify(out)).not.toContain('boundary start');
  });

  it('serves the recording agent its whole transcript', async () => {
    const out = await call<ReadOut>('sessions:read', PEER, { session: 'peer-sess', source_kind: 'claude' });
    expect(out.turns.map((t) => t.turn_idx)).toEqual([0, 1, 2, 3]);
    expect(out.withheld).toBeUndefined();
  });
});

describe('sessions:search', () => {
  it('a query that matches only a restricted turn and a query that matches nothing report the same receipt (no oracle)', async () => {
    const onlySecret = await call<SearchOut>('sessions:search', READER, { query: 'zebracopper', mode: 'verbatim', context: 0 });
    const nothing = await call<SearchOut>('sessions:search', READER, { query: 'nomatchxylophage', mode: 'verbatim', context: 0 });
    expect(onlySecret.total_hits).toBe(0);
    expect(nothing.total_hits).toBe(0);
    expect(onlySecret.withheld).toMatchObject({ restricted_turns: 3, unattributed_turns: 1, in_search_scope: 3 });
    expect(nothing.withheld).toEqual(onlySecret.withheld);
    expect(JSON.stringify(onlySecret)).not.toContain('merger');
  });

  it('a broad verbatim query returns every visible match and none of the withheld ones', async () => {
    const out = await call<SearchOut>('sessions:search', READER, { query: 'alpha', mode: 'verbatim', context: 0 });
    expect(out.total_hits).toBe(3);
    const body = JSON.stringify(out.results);
    expect(body).toContain('alpha public preface');
    expect(body).toContain('alpha after release');
    expect(body).toContain('alpha other agent');
    expect(body).not.toContain('zebracopper');
    expect(body).not.toContain('alpha orphan line');
    expect(out.withheld?.in_search_scope).toBe(3);
  });

  it('the recording agent finds its own restricted turn', async () => {
    const out = await call<SearchOut>('sessions:search', PEER, { query: 'zebracopper', mode: 'verbatim', context: 0 });
    expect(out.total_hits).toBe(1);
    expect(JSON.stringify(out.results)).toContain('zebracopper');
    expect(out.withheld).toBeUndefined();
  });

  it('a context window around a visible hit drops the restricted neighbour and counts it', async () => {
    const out = await call<SearchOut>('sessions:search', READER, { query: 'preface', mode: 'verbatim', context: 1 });
    expect(out.total_hits).toBe(1);
    expect(JSON.stringify(out)).not.toContain('boundary start');
    expect(out.withheld).toMatchObject({ from_context_windows: 1 });
  });

  it('the tool-part caveat does not count another agent’s restricted tool output', async () => {
    const reader = await call<SearchOut>('sessions:search', READER, { query: TOOL_ONLY, mode: 'verbatim', context: 0 });
    expect(reader.total_hits).toBe(0);
    expect(JSON.stringify(reader)).not.toContain('FOUND, JUST NOT IN A TEXT TURN');
    // Control: the recording agent is told the string sits in a tool part.
    const peer = await call<SearchOut>('sessions:search', PEER, { query: TOOL_ONLY, mode: 'verbatim', context: 0 });
    expect(JSON.stringify(peer)).toContain('FOUND, JUST NOT IN A TEXT TURN');
  });

  it('hybrid search excludes the restricted turn inside the query', async () => {
    // Control first: the lexical leg does find the turn for its recording agent.
    const peer = await call<SearchOut>('sessions:search', PEER, { query: 'zebracopper', mode: 'hybrid', context: 0 });
    expect(JSON.stringify(peer.results)).toContain('zebracopper');
    const reader = await call<SearchOut>('sessions:search', READER, { query: 'zebracopper', mode: 'hybrid', context: 0 });
    expect(JSON.stringify(reader.results)).not.toContain('zebracopper');
    expect(reader.withheld?.in_search_scope).toBe(3);
  });
});

describe('an unreadable ledger refuses the read', () => {
  it('sessions:search and sessions:read refuse rather than serve unfiltered', async () => {
    await sql.unsafe('ALTER TABLE harness_shared.personal_disclosures RENAME TO personal_disclosures_gone');
    try {
      const search = await dispatch('sessions:search', READER, { query: 'alpha', mode: 'verbatim', context: 0 });
      expect(JSON.stringify(search)).toContain('disclosure_ledger_unavailable');
      expect(JSON.stringify(search)).not.toContain('alpha public preface');
      const read = await dispatch('sessions:read', READER, { session: 'peer-sess', source_kind: 'claude' });
      expect(JSON.stringify(read)).toContain('disclosure_ledger_unavailable');
      expect(JSON.stringify(read)).not.toContain('alpha public preface');
    } finally {
      await sql.unsafe('ALTER TABLE harness_shared.personal_disclosures_gone RENAME TO personal_disclosures');
    }
  });
});
