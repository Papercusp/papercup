/**
 * voice-utterance-log.integration.test.ts — real testcontainer PG.
 *
 * logVoiceUtterance is the append-only persona-drift audit writer. The MCP-tool
 * test only mocks it; this exercises the real INSERT against the actual
 * harness_shared.voice_utterances schema (migration 004) so a column/JSONB drift
 * is caught. Covers: a full-field insert round-trips; the source allow-list
 * collapses unknown values to 'legacy'; modifications defaults to []; omitted
 * optionals land NULL/false; and a missing table degrades gracefully.
 *
 * P-013 of plan voice-production-test-coverage-2026-06-01.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';

const h = vi.hoisted(() => ({ sql: null as unknown as import('postgres').Sql }));

// withWorkspace runs the callback with a workspace-scoped tx; point it at the
// throwaway DB. activeWorkspaceId is pinned. (Partial mock keeps every other
// db-org export intact.)
vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/db-org')>();
  return {
    ...actual,
    withWorkspace: async <T>(_ws: string, cb: (tx: unknown) => Promise<T>): Promise<T> => cb(h.sql),
  };
});
vi.mock('./workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));

import { logVoiceUtterance } from './voice-utterance-log';

const DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.voice_utterances (
    id            BIGSERIAL PRIMARY KEY,
    ts            TIMESTAMPTZ NOT NULL DEFAULT now(),
    workspace_id  TEXT,
    source        TEXT NOT NULL,
    mode          TEXT,
    length_chars  INT,
    name_used     BOOLEAN NOT NULL DEFAULT FALSE,
    had_backstory BOOLEAN NOT NULL DEFAULT FALSE,
    modifications JSONB
  );
  CREATE INDEX IF NOT EXISTS voice_utterances_ts_idx ON harness_shared.voice_utterances (ts DESC);
  CREATE INDEX IF NOT EXISTS voice_utterances_mode_idx ON harness_shared.voice_utterances (mode, ts DESC);
`;

let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('voiceutt');
  h.sql = db.sql;
  await db.sql.unsafe(DDL);
}, 60_000);

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  await db.sql.unsafe('TRUNCATE harness_shared.voice_utterances RESTART IDENTITY');
});

async function rows() {
  return db.sql`SELECT * FROM harness_shared.voice_utterances ORDER BY id`;
}

// The production-faithful test client (prepare:false) returns jsonb as raw
// text; normalize so we assert on the logical value.
function parseMods(m: unknown): unknown {
  return typeof m === 'string' ? JSON.parse(m) : m;
}

describe('logVoiceUtterance — real PG insert', () => {
  it('round-trips a full-field utterance into the audit table', async () => {
    const res = await logVoiceUtterance({
      source: 'elevenlabs-conv',
      mode: 'assertive',
      lengthChars: 42,
      nameUsed: true,
      hadBackstory: false,
      modifications: [{ kind: 'strip-preamble' }],
    });
    expect(res).toEqual({ ok: true });
    const r = await rows();
    expect(r).toHaveLength(1);
    expect(r[0].workspace_id).toBe('ws-test');
    expect(r[0].source).toBe('elevenlabs-conv');
    expect(r[0].mode).toBe('assertive');
    expect(r[0].length_chars).toBe(42);
    expect(r[0].name_used).toBe(true);
    expect(r[0].had_backstory).toBe(false);
    expect(parseMods(r[0].modifications)).toEqual([{ kind: 'strip-preamble' }]); // JSONB round-trip
    expect(r[0].ts).toBeTruthy(); // server default applied
  });

  it('collapses an unknown source to "legacy" (allow-list)', async () => {
    await logVoiceUtterance({ source: 'totally-made-up', mode: 'default' });
    const r = await rows();
    expect(r[0].source).toBe('legacy');
  });

  it('defaults modifications to [] and optionals to NULL/false when omitted', async () => {
    await logVoiceUtterance({ source: 'realtime' });
    const r = await rows();
    expect(parseMods(r[0].modifications)).toEqual([]);
    expect(r[0].mode).toBeNull();
    expect(r[0].length_chars).toBeNull();
    expect(r[0].name_used).toBe(false);
    expect(r[0].had_backstory).toBe(false);
  });

  it('accepts all three valid sources', async () => {
    for (const source of ['legacy', 'elevenlabs-conv', 'realtime']) {
      await logVoiceUtterance({ source });
    }
    const r = await rows();
    expect(r.map((x) => x.source)).toEqual(['legacy', 'elevenlabs-conv', 'realtime']);
  });
});

describe('logVoiceUtterance — degraded path', () => {
  it('returns {ok:true, degraded:true} when the table is absent', async () => {
    await db.sql.unsafe('DROP TABLE harness_shared.voice_utterances');
    const res = await logVoiceUtterance({ source: 'legacy', mode: 'wry' });
    expect(res).toEqual({ ok: true, degraded: true });
    // restore for any later runs / afterAll symmetry
    await db.sql.unsafe(DDL);
  });
});
