/**
 * agent-facts projection (F1-1, federated-scout-gym-learning-2026-07-02) —
 * hermetic tests for the wire validators + the H6 source-partitioning
 * properties: a remote op lands in ITS OWN source partition; a remote delete
 * can never touch the local partition.
 */
import { describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { buildAgentFactsProjection, _testing, type AgentFactWireRow } from './agent-facts';

const { composeKey, decodeValue } = _testing;

const row = (over: Partial<AgentFactWireRow> = {}): AgentFactWireRow => ({
  harness_slug: 'papercusp',
  scope: 'harness',
  scope_ref: 'papercusp',
  key: 'tests-need-docker',
  body: 'This harness integration tests require Docker (testcontainers).',
  source_ref: 'WI-42',
  expires_at: new Date(86_400_000).toISOString(),
  retracted_at: null,
  created_by: 'bee-7',
  ...over,
});

/** Tagged-template sql fake capturing interpolated values per call. */
function fakeSql(): { sql: postgres.Sql; calls: unknown[][]; texts: string[] } {
  const calls: unknown[][] = [];
  // The statement text too, so a test can assert the STATEMENT SHAPE (which
  // columns a conflict updates wholesale vs. COALESCEs). That is a structural
  // check, not a DB-semantics one — the real behavior is covered by the
  // federated-column-completeness guard against a migrated schema.
  const texts: string[] = [];
  const fn = (s: TemplateStringsArray, ...vals: unknown[]) => {
    calls.push(vals);
    texts.push(s.join('?'));
    return Promise.resolve([]);
  };
  return { sql: fn as unknown as postgres.Sql, calls, texts };
}

describe('composeKey — matches mig 462 fed_key exactly', () => {
  it('scope/ref/key, with empty string for a null ref', () => {
    expect(composeKey(row())).toBe('harness/papercusp/tests-need-docker');
    expect(composeKey(row({ scope: 'workspace', scope_ref: null, key: 'k' }))).toBe('workspace//k');
  });
});

describe('decodeValue — defensive on every field', () => {
  it('accepts a well-formed wire row (extra to_jsonb fields tolerated)', () => {
    expect(decodeValue({ ...row(), shareable: true, origin: 'local', fed_key: 'x' })).not.toBeNull();
  });
  it('rejects malformed rows', () => {
    expect(decodeValue(null)).toBeNull();
    expect(decodeValue(row({ harness_slug: '' }))).toBeNull();
    expect(decodeValue(row({ scope: 'galaxy' as never }))).toBeNull();
    expect(decodeValue(row({ body: 'x'.repeat(501) }))).toBeNull();
    expect(decodeValue({ ...row(), key: undefined as never })).toBeNull();
    expect(decodeValue(row({ measurement: { subjectVolatile: false, measuredAt: '2026-08-11T20:50:00Z' } }))).toBeNull();
    expect(
      decodeValue(row({ measurement: { subjectVolatile: true, measuredAt: '2026-08-11T20:50:00Z' } })),
    ).not.toBeNull();
    expect(decodeValue(row({ retracted_by: 'su-1', retraction_reason: 'superseded by live evidence' }))).not.toBeNull();
    expect(decodeValue({ ...row(), retraction_reason: 42 })).toBeNull();
    expect(decodeValue(row({ recheck: { probe: 'run status', falsifier: 'pin differs' } }))).not.toBeNull();
    expect(decodeValue({ ...row(), recheck: { probe: 'only half' } })).toBeNull();
    expect(decodeValue({ ...row(), recheck: { probe: 'run', falsifier: 'no', extra: true } })).toBeNull();
    expect(decodeValue(row({ recheck: { probe: 'x'.repeat(501), falsifier: 'no' } }))).toBeNull();
  });
});

describe('writeToPg — H6 source partitioning', () => {
  const opts = (sql: postgres.Sql) => ({ workspaceId: 'ws', harnessSlug: 'papercusp', sql });

  it('drops ops for a different hive home (demux guard) — no SQL issued', async () => {
    const { sql, calls } = fakeSql();
    await buildAgentFactsProjection(opts(sql)).writeToPg(row({ harness_slug: 'other-hive' }), {
      authorPubkey: 'k1',
      origin: 'remote',
    } as never);
    expect(calls.length).toBe(0);
  });

  it('a REMOTE op lands in its receiver-stamped source partition', async () => {
    const { sql, calls } = fakeSql();
    await buildAgentFactsProjection(opts(sql)).writeToPg(
      row({ measurement: { subjectVolatile: true, measuredAt: '2026-08-11T20:50:00Z' } }),
      {
        authorPubkey: 'stamped-source-log-key',
        origin: 'remote',
      } as never,
    );
    expect(calls.length).toBe(1);
    // source_hive (the partition) must be the RECEIVER-stamped author key.
    expect(calls[0]).toContain('stamped-source-log-key');
    expect(calls[0]).toContain('remote');
    expect(calls[0].some((v) => typeof v === 'string' && v.includes('subjectVolatile'))).toBe(true);
  });

  it('a LOCAL echo keeps the NULL (local) partition', async () => {
    const { sql, calls } = fakeSql();
    await buildAgentFactsProjection(opts(sql)).writeToPg(row(), {
      authorPubkey: 'own-device',
      origin: 'local',
    } as never);
    expect(calls.length).toBe(1);
    // The local partition: source_hive interpolates as null.
    expect(calls[0]).toContain(null);
  });

  // ── EI-21474421983228518: the two tests below verify the RECEIVE half ONLY,
  // and are named for that. They previously read "carries X across federation",
  // which claimed a property no test in this file can hold: nothing here can
  // detect an absent SENDER, because the test supplies the wire row itself and
  // so passes whether or not any mapper ever produces those keys.
  //
  // That is not hypothetical. `toAgentFactValue` emitted none of retracted_by /
  // retraction_reason / recheck for a long stretch, so those columns were
  // permanently NULL across real federation while both tests sat green under
  // end-to-end names — reassurance sitting directly beside the defect.
  //
  // The SEND half lives in ../feature-issue-op-keys.test.ts (the mapper emits
  // the keys, and its output is asserted to pass isAgentFactWireRow — the
  // cheapest true end-to-end assertion available without a DB). The
  // column -> mapper-key correspondence itself is enforced by the
  // federated-column-completeness drift guard, which is what actually caught
  // the gap.
  it('writeToPg binds the retraction actor and reason (receive half — see note above)', async () => {
    const { sql, calls } = fakeSql();
    await buildAgentFactsProjection(opts(sql)).writeToPg(
      row({ retracted_at: new Date().toISOString(), retracted_by: 'su-author', retraction_reason: 'condition cleared' }),
      { authorPubkey: 'stamped-source-log-key', origin: 'remote' } as never,
    );
    expect(calls[0]).toContain('su-author');
    expect(calls[0]).toContain('condition cleared');
  });

  it('writeToPg binds the recheck pair (receive half — see note above)', async () => {
    const { sql, calls } = fakeSql();
    const recheck = { probe: 'run release status', falsifier: 'the pins differ' };
    await buildAgentFactsProjection(opts(sql)).writeToPg(row({ recheck }), {
      authorPubkey: 'stamped-source-log-key',
      origin: 'remote',
    } as never);
    expect(calls[0]).toContain(JSON.stringify(recheck));
  });

  // ── EI-21467654382027859
  describe('claim-substance + liveness columns', () => {
    it('binds kind / claim / enforcement / settled_by / depends_on / evicted_at', async () => {
      const { sql, calls } = fakeSql();
      const claim = { subject: 'cell:deploy.3070.sha', assertion: 'unchanged' };
      const enforcement = { tier: 'detector', floor: 0.9, reviewBy: '2026-12-01' };
      const dependsOn = [{ cell: 'deploy.3070.sha', observedAt: '2026-08-01T00:00:00.000Z', digest: 'abc' }];
      await buildAgentFactsProjection(opts(sql)).writeToPg(
        row({
          kind: 'undecidable',
          claim,
          enforcement,
          settled_by: 'a blob-containment check',
          depends_on: dependsOn,
          evicted_at: '2026-08-02T00:00:00.000Z',
        }),
        { authorPubkey: 'stamped-source-log-key', origin: 'remote' } as never,
      );
      expect(calls[0]).toContain('undecidable');
      expect(calls[0]).toContain(JSON.stringify(claim));
      expect(calls[0]).toContain(JSON.stringify(enforcement));
      expect(calls[0]).toContain('a blob-containment check');
      expect(calls[0]).toContain(JSON.stringify(dependsOn));
      expect(calls[0]).toContain('2026-08-02T00:00:00.000Z');
    });

    it('a SUPERSEDED op is not applied to the live partition — no SQL issued', async () => {
      const { sql, calls } = fakeSql();
      await buildAgentFactsProjection(opts(sql)).writeToPg(
        row({ superseded_at: '2026-08-02T00:00:00.000Z', body: 'the PRIOR version of this identity' }),
        { authorPubkey: 'stamped-source-log-key', origin: 'remote' } as never,
      );
      // This projection holds one row per identity × source — the peer's CURRENT
      // observation — so a prior version has no row to land in. Applying it
      // would overwrite the live row with stale content, and could not even be
      // idempotent: agent_facts_identity_current is PARTIAL (WHERE superseded_at
      // IS NULL), so a non-NULL proposed row can never match the ON CONFLICT
      // arbiter and every replay would insert another copy.
      expect(calls.length).toBe(0);
    });

    it('a LIVE op (superseded_at explicitly null) is still applied', async () => {
      // The negative control for the guard above — it must key on non-NULL, not
      // on the field merely being present.
      const { sql, calls } = fakeSql();
      await buildAgentFactsProjection(opts(sql)).writeToPg(row({ superseded_at: null }), {
        authorPubkey: 'stamped-source-log-key',
        origin: 'remote',
      } as never);
      expect(calls.length).toBe(1);
    });

    it('write-once audit provenance COALESCEs; claim substance replaces wholesale', async () => {
      const { sql, texts } = fakeSql();
      await buildAgentFactsProjection(opts(sql)).writeToPg(row(), {
        authorPubkey: 'stamped-source-log-key',
        origin: 'remote',
      } as never);
      const stmt = texts[0].replace(/\s+/g, ' ');
      // A peer still on pre-fix code sends NULL for these three; a bare EXCLUDED
      // would let its next ordinary content update ERASE the actor, the reason
      // and the eviction marker from a row that already has them.
      for (const col of ['retracted_by', 'retraction_reason', 'evicted_at']) {
        expect(stmt, `${col} must COALESCE, not overwrite`).toContain(
          `${col} = COALESCE(EXCLUDED.${col}, harness_shared.agent_facts.${col})`,
        );
      }
      // Claim substance is real authoring content: clearing it is a change and
      // must propagate as one.
      for (const col of ['kind', 'claim', 'enforcement', 'settled_by', 'depends_on']) {
        expect(stmt, `${col} must replace wholesale`).toContain(`${col} = EXCLUDED.${col}`);
      }
      // superseded_at is never inserted: the guard above means every row this
      // statement writes is live, so it takes its NULL default.
      expect(stmt).not.toContain('superseded_at =');
    });
  });
});

describe('decodeValue — EI-21467654382027859 additions', () => {
  it('accepts rows omitting all of them (pre-existing history ops)', () => {
    expect(decodeValue(row())).not.toBeNull();
  });

  it('accepts well-formed values', () => {
    expect(
      decodeValue(
        row({
          kind: 'convention',
          claim: { subject: 's', assertion: 'a' },
          enforcement: { tier: 'gate', floor: 1, reviewBy: '2026-12-01' },
          settled_by: 'a probe',
          depends_on: [{ cell: 'deploy.3070.sha' }],
          superseded_at: null,
          evicted_at: null,
        }),
      ),
    ).not.toBeNull();
  });

  it('REFUSES an unrecognized kind or enforcement tier rather than letting it raise on INSERT', () => {
    // Both columns carry DB CHECK constraints, so an unrecognized sender value
    // would abort the projection write; refusing the single op is the softer
    // failure. Same stance the confidence tier already takes.
    expect(decodeValue(row({ kind: 'made-up-modality' } as never))).toBeNull();
    expect(decodeValue(row({ enforcement: { tier: 'prompt' } } as never))).toBeNull();
    expect(decodeValue(row({ enforcement: { floor: 0.9 } } as never))).toBeNull();
  });

  it('REFUSES the wrong JSON container shape in either direction', () => {
    // depends_on is an array and claim/enforcement are objects — a swap is the
    // easy mistake, and each would land in a jsonb column that then reads wrong.
    expect(decodeValue(row({ depends_on: { cell: 'x' } } as never))).toBeNull();
    expect(decodeValue(row({ claim: [{ subject: 's' }] } as never))).toBeNull();
    expect(decodeValue(row({ superseded_at: 12345 } as never))).toBeNull();
  });
});

describe('deleteFromPg — local partition immunity', () => {
  it('issues the retract-update only for parseable keys', async () => {
    const { sql, calls } = fakeSql();
    const proj = buildAgentFactsProjection({ workspaceId: 'ws', harnessSlug: 'papercusp', sql });
    await proj.deleteFromPg!('harness/papercusp/tests-need-docker', 123, undefined);
    expect(calls.length).toBe(1);
    expect(calls[0]).toContain('tests-need-docker');
    await proj.deleteFromPg!('', undefined, undefined);
    expect(calls.length).toBe(1); // blank key = no-op
  });

  it('registers with the echo-breaker + the right tag', () => {
    const proj = buildAgentFactsProjection({ workspaceId: 'ws', harnessSlug: 'papercusp' });
    expect(proj.tableTag).toBe('agent-facts-by-key');
    expect((proj as { skipOwnOps?: boolean }).skipOwnOps).toBe(true);
  });
});

describe('onRefusedOp — per-source refused-op counter (F1-4 / P-012)', () => {
  const mkOpts = (sql: postgres.Sql) => ({ workspaceId: 'ws', harnessSlug: 'papercusp', sql });

  it('bumps a malformed counter for a REMOTE declined fact op with the source', async () => {
    const { sql, calls } = fakeSql();
    await buildAgentFactsProjection(mkOpts(sql)).onRefusedOp!(
      { totally: 'not-a-fact' },
      { authorPubkey: 'peer-log-key', origin: 'remote' },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(['ws', 'papercusp', 'peer-log-key', 'agent-facts-by-key', 'malformed']);
  });

  it('does NOT count a LOCAL decode failure', async () => {
    const { sql, calls } = fakeSql();
    await buildAgentFactsProjection(mkOpts(sql)).onRefusedOp!(
      { x: 1 },
      { authorPubkey: 'self', origin: 'local' },
    );
    expect(calls).toHaveLength(0);
  });
});
