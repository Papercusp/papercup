/** Real SQL/disclosure boundaries; only the permanent archive transport is supplied. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
import { DISCLOSURE_LEDGER_FIXTURE_DDL } from '../../../test/_disclosure-ledger-fixture';
import { resolveDiscoveryAuditContext } from './plan-declaration-resolvers';
import { fetchSourceTurns, type TurnSql } from '../../activation-item-provenance';
import { resolveSessionTurnRefs } from '../sessions/_shared';
import type { ArchivedTurn } from '../../session-archive-read';

const readArchive = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<{
  sourceKind: 'codex'; owner: string | null; turns: ArchivedTurn[]; errors: [];
} | null>>(async () => null));
vi.mock('../../session-archive-read', () => ({ readArchivedSessionTurns: readArchive }));

const workspaceId = 'ws-discovery-turn-source';
const ownerId = 'su-discovery-reader';
const ref = 'session_turn:codex:original:7';
const declaration = { questions: [], findings: [{ id: 'F-1', questions: [],
  conclusion: 'Retain the original source observation.', evidenceRefs: [ref],
  dispositions: [{ target: 'section:Discovery', decision: 'unchanged', reason: 'The source supports this bounded finding.' }] }],
  notApplicable: 'The source observation has no remaining material unknown.' };
const content = `## Discovery\n\n\`\`\`discovery\n${JSON.stringify(declaration)}\n\`\`\`\n`;
let db: FreshPgDb;
let sql: postgres.Sql;
const context = () => resolveDiscoveryAuditContext(content, null, {
  repoRoot: null, sql, workspaceId, ownerId, harnessSlug: 'papercusp', planSlug: 'discovery-source-fixture',
});

beforeAll(async () => {
  db = await createFreshPgDb('discovery-turn-source');
  sql = db.sql;
  await sql.unsafe(DISCLOSURE_LEDGER_FIXTURE_DDL);
  await sql.unsafe(`CREATE TABLE harness_shared.session_turns (
    workspace_id text NOT NULL, source_kind text NOT NULL, session_id text NOT NULL, turn_idx integer NOT NULL,
    text text NOT NULL, speaker text NOT NULL, owner text, ts timestamptz, ingested_at timestamptz DEFAULT now(),
    turn_origin text, turn_origin_verdict text, PRIMARY KEY (workspace_id, source_kind, session_id, turn_idx)
  )`);
}, 60_000);
beforeEach(async () => {
  readArchive.mockReset();
  readArchive.mockResolvedValue(null);
  await sql`TRUNCATE harness_shared.session_turns, harness_shared.personal_disclosures`;
});
afterAll(async () => { await db?.cleanup(); });

async function seed(workspace = workspaceId, text = 'Keep the measured source observation.') {
  await sql`INSERT INTO harness_shared.session_turns
    (workspace_id, source_kind, session_id, turn_idx, text, speaker, owner, ts, turn_origin_verdict)
    VALUES (${workspace}, 'codex', 'original', 7, ${text}, 'user', 'su-source-author',
      '2026-11-01T00:00:00Z', 'unenrolled-origin')`;
}

describe('canonical discovery source resolution', () => {
  it('fingerprints the selected indexed text and preserves its existing origin verdict', async () => {
    await seed();
    const first = (await context()).evidence[0]!;
    expect(first).toMatchObject({ ref, state: 'current', usable: true, fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(first.reason).toContain('origin unknown');
    expect((await fetchSourceTurns(sql as unknown as TurnSql, workspaceId, [ref])).get(ref)?.verdict).toBe('unknown');
    await sql`UPDATE harness_shared.session_turns SET text='Changed source observation' WHERE workspace_id=${workspaceId}`;
    expect((await context()).evidence[0]?.fingerprint).not.toBe(first.fingerprint);
    const [stored] = await sql`SELECT turn_origin_verdict FROM harness_shared.session_turns WHERE workspace_id=${workspaceId}`;
    expect(stored?.turn_origin_verdict).toBe('unenrolled-origin');
  });

  it('excludes foreign workspaces and prefers the current workspace over a legacy duplicate', async () => {
    await seed('foreign-workspace', 'Foreign source');
    expect((await context()).evidence[0]).toMatchObject({ state: 'unknown', usable: false, fingerprint: null });
    await seed('default', 'Legacy source');
    const legacy = (await context()).evidence[0]?.fingerprint;
    await seed();
    expect((await context()).evidence[0]?.fingerprint).not.toBe(legacy);
    await sql`DELETE FROM harness_shared.session_turns WHERE workspace_id IN ('default', 'foreign-workspace')`;
    const selected = (await context()).evidence[0]?.fingerprint;
    expect(selected).toBe((await context()).evidence[0]?.fingerprint);
  });

  it('resolves the archive-only machine turn without granting owner authority', async () => {
    readArchive.mockResolvedValue({ sourceKind: 'codex', owner: 'su-source-author', errors: [], turns: [{
      source_kind: 'codex', turn_idx: 7, text: '⟦turn-origin:loop-fire⟧ Continue the saved task.',
      speaker: 'user', owner: 'su-source-author', ts: '2026-11-01T00:00:00Z',
    }] });
    expect((await context()).evidence[0]).toMatchObject({ ref, state: 'current', usable: true,
      reason: expect.stringContaining('agent-injected') });
    expect(await fetchSourceTurns(sql as unknown as TurnSql, workspaceId, [ref])).toEqual(new Map());
    readArchive.mockResolvedValue(null);
    expect((await context()).evidence[0]).toMatchObject({ state: 'unknown', usable: false, fingerprint: null });
  });

  it('withholds indexed and archived disclosure-window text from other readers', async () => {
    await seed();
    await sql`INSERT INTO harness_shared.personal_disclosures
      (workspace_id, user_id, agent_owner_id, document_id, source, level, reader_set, delivered_via, delivered_at)
      VALUES (${workspaceId}, gen_random_uuid(), 'su-source-author', gen_random_uuid(), 'fixture',
        'restricted', ARRAY['su-source-author'], 'fixture', '2026-10-31T00:00:00Z')`;
    expect((await context()).evidence[0]).toMatchObject({ state: 'unknown', usable: false, fingerprint: null });
    expect(readArchive).not.toHaveBeenCalled();
    await sql`DELETE FROM harness_shared.session_turns`;
    readArchive.mockResolvedValue({ sourceKind: 'codex', owner: 'su-source-author', errors: [], turns: [{
      source_kind: 'codex', turn_idx: 7, text: 'Restricted original source.', speaker: 'user',
      owner: 'su-source-author', ts: '2026-11-01T00:00:00Z',
    }] });
    expect((await context()).evidence[0]).toMatchObject({ state: 'unknown', usable: false, fingerprint: null });
    expect(await resolveSessionTurnRefs(sql, workspaceId, [ref], { evidenceForOwner: 'su-source-author' }))
      .toMatchObject([{ ok: true, source: 'archive', evidence: { origin: { verdict: 'unknown' } } }]);
  });
});
