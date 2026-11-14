/**
 * text-artifacts.integration.test.ts — the PG-canonical text-artifact store
 * (migration 035, drizzle), against a real Postgres. The disk mirror + sync are
 * seams (mocked); the SQL is real.
 *
 * Behaviors a fake-db unit test can't prove:
 *  - save→load round-trip + the `.papercusp/` rel_path normalization (a prefixed
 *    and a bare path hit the SAME row);
 *  - the (harness_slug, rel_path) upsert;
 *  - appendTextArtifact's ATOMIC PG-side `content || EXCLUDED.content` concat;
 *  - the EI-280 `adoptBlankWorkspace` guard: a save adopts the active workspace
 *    onto a BLANK-stamped legacy row, but never RE-HOMES a properly-stamped one;
 *  - delete.
 *
 * Reuses the drizzle harness from toast-log-data: `generated` stays real, a
 * drizzle(rootSql) db is injected.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import type { SecuritySourceProgress } from './coverage-census/security-source-census';
import { drizzle } from 'drizzle-orm/postgres-js';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { createArtifactPreparationStore, openBoundPreparationLedger } from '../../../scripts/lib/source-path-census.mjs';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
import type { UnifiedToolContext } from '@papercusp/tooldef';
import { packContextCandidates } from './context-doors';
import { captureContextPackingAttribution, collectContextPackingReceiptSources, loadContextPackingReceipt, pageContextPackingReceipt, saveContextPackingReceipt,
  type ContextPackingScope } from './context-packing-receipts';
import { collectFinalContextAttemptSnapshot, exportContextPackingAttemptSnapshot, sampleFinalDeliveredContext,
  joinFinalContextNativeEmissions, type FinalContextAttemptSnapshot } from './memory/injection-delivery-coverage';
import { captureNativeMcp, nativeMcpTranscriptLocators } from './memory/fixtures/native-mcp-export';
import { collectMemoryEmission, memoryFragmentOffer, withMemoryEmissionReceipt, confirmMemoryEmission, type MemoryFragmentManifest } from './memory/session-epoch-ledger';
import { configureReadCursorStore, InMemoryReadCursorStore, resetReadCursorStore } from './agent-tools/coordination/read-cursors';
import { _resetFallbackObservationsForTests } from './degradation/fallback-observations';

const WS = 'ws-art';
const h = vi.hoisted(() => ({ db: undefined as unknown, sql: undefined as unknown }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ db: h.db, sql: h.sql }) };
});
// This storage integration tests custody/SQL, not reviewer routing eligibility.
// Canonical lineage and its rejecting cases have their own maintained tests.
vi.mock('./acceptance-author-identity', () => ({ areAcceptanceLineageRelated: async () => false }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, mkdir: vi.fn(async () => {}), writeFile: vi.fn(async () => {}) };
});
vi.mock('./harness-registry', () => ({ loadHarnessRegistry: async () => ({ projects: [] }) }));
vi.mock('./sync-sse', () => ({ notifySyncInvalidate: vi.fn(async () => {}) }));
vi.mock('./workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('./workspace-registry')>('./workspace-registry');
  return { ...actual, activeWorkspaceId: () => WS };
});

const { loadTextArtifact, saveTextArtifact, compareAndSwapTextArtifact, appendTextArtifact, deleteTextArtifact,
  saveImmutableTextArtifact, loadImmutableTextArtifact,
  claimImmutableTextArtifact, loadImmutableTextArtifactClaim } = await import('./text-artifacts');
const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

let rootSql: postgres.Sql;

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `art_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    await markManagedTestDatabase(admin, dbName);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  rootSql = postgres(u.toString(), { max: 1, onnotice: () => {} });
  await rootSql.unsafe(`CREATE SCHEMA harness_shared`);
  // FAITHFUL to baseline: updated_at bigint, workspace_id NOT NULL default '', PK (harness_slug, rel_path).
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.harness_text_artifacts (
      harness_slug text NOT NULL,
      rel_path text NOT NULL,
      content text DEFAULT '' NOT NULL,
      updated_at bigint DEFAULT 0 NOT NULL,
      workspace_id text DEFAULT '' NOT NULL,
      CONSTRAINT harness_text_artifacts_pkey PRIMARY KEY (harness_slug, rel_path)
    )`);
  h.db = drizzle(rootSql);
  h.sql = rootSql;
  // Bounded attribution capture records degraded reads through the maintained
  // telemetry writer. Exercise that dependency instead of suppressing warnings
  // when the suite flushes its observations at a later test boundary.
  for (const migration of [
    '1458-fallback-observations.sql',
    '1471-retrieval-search-correlation.sql',
    '1489-fallback-observations-samples.sql',
    '1525-fallback-population-known.sql',
  ]) {
    await rootSql.unsafe(await actualFs.readFile(new URL(`../../../libs/papercusp/libs/db/sql/${migration}`, import.meta.url), 'utf8'));
  }
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.memory_session_epochs (session_id text PRIMARY KEY, epoch integer NOT NULL DEFAULT 0,
      bumped_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE harness_shared.adv_sessions (id bigint PRIMARY KEY, workspace_id text NOT NULL, coord_owner_id text,
      agent text NOT NULL, session_id text, omp_thread_id text, ended_at timestamptz, ended_by text);
    CREATE TABLE harness_shared.session_identity_activation_events (id bigint PRIMARY KEY, workspace_id text NOT NULL,
      owner_id text NOT NULL, adv_session_id bigint, native_session_id text, control_generation bigint NOT NULL,
      phase text NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now());
  `);
  await rootSql.unsafe(`CREATE TABLE harness_shared.operator_secrets (name text PRIMARY KEY, value_b64 text NOT NULL)`);
  await rootSql`INSERT INTO harness_shared.operator_secrets VALUES ('spawn-signing-key', ${randomBytes(32).toString('base64')})`;
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

beforeEach(async () => {
  _resetFallbackObservationsForTests();
  await rootSql`TRUNCATE harness_shared.harness_text_artifacts`;
  await rootSql.unsafe('TRUNCATE harness_shared.memory_session_epochs, harness_shared.adv_sessions, harness_shared.session_identity_activation_events');
});
afterEach(() => { _resetFallbackObservationsForTests(); });

const wsOf = async (slug: string, key: string) =>
  (await rootSql<{ workspace_id: string }[]>`SELECT workspace_id FROM harness_shared.harness_text_artifacts WHERE harness_slug=${slug} AND rel_path=${key}`)[0]?.workspace_id;

describe('packing attempt identity custody', () => {
  for (const [client, codexCodeMode] of [['codex', false], ['codex', true], ['claude', false], ['omp', false]] as const) it(
    `joins real PG durable ${client}${codexCodeMode ? ' functions.exec' : ''} preparations to retained installed-native transcript and stdout after cursor cleanup`, async ({ task }) => {
      const cursors = new InMemoryReadCursorStore();
      configureReadCursorStore(cursors);
      try {
        await rootSql.unsafe(`CREATE TABLE IF NOT EXISTS harness_shared.memory_session_surfaced (
          session_id text NOT NULL, epoch integer NOT NULL, memory_id uuid NOT NULL, port text,
          source_fingerprint text, source_version jsonb, surfaced_at timestamptz DEFAULT now(), PRIMARY KEY(session_id,epoch,memory_id))`);
        const ownerId = `durable-native-${client}`;
        const scope: ContextPackingScope = { workspaceId: WS, ownerId, harness: 'web', client, port: 'mcp-result' };
        const { ownerId: _owner, ...hostScope } = scope;
        await rootSql`INSERT INTO harness_shared.memory_session_epochs (session_id, epoch) VALUES (${ownerId}, 3)`;
        const row = memoryFragmentOffer('memory', '11111111-1111-1111-1111-111111111111', 3, 'orient',
          'Only after explicit final approval ☃.');
        let offer: { token: string; fragments: MemoryFragmentManifest[] } | undefined;
        const visible = JSON.stringify({ orient: row.rendered });
        const capture = await captureNativeMcp(client, [{ name: 'receipt_canary', description: 'Local durable receipt observation.' }],
          row.rendered, [], { stdioReceipt: 'memory', stdioPort: 'orient', stdioOwner: ownerId,
            codexCodeMode,
            receiptAdapter: client === 'omp' ? 'omp-rpc' : 'ptool-stdio', retainNativeTranscript: true,
            onDiagnostics: path => { Object.assign(task.meta, { nativeMcpDiagnostics: path }); },
            mcpResult: async (method, result, request, nativeSessionId) => {
              if (method !== 'tools/call' || (request.params as { name?: string })?.name !== 'receipt_canary') return result;
              expect(nativeSessionId).toBeTruthy();
              // This is the enrolled test runtime's journal, not a claim parsed
              // from model text. The retained native header/result checks it.
              await rootSql`INSERT INTO harness_shared.adv_sessions
                (id, workspace_id, coord_owner_id, agent, session_id, omp_thread_id)
                VALUES (1, ${WS}, ${ownerId}, ${client}, ${nativeSessionId}, ${nativeSessionId})`;
              await rootSql`INSERT INTO harness_shared.session_identity_activation_events
                (id, workspace_id, owner_id, adv_session_id, native_session_id, control_generation, phase)
                VALUES (1, ${WS}, ${ownerId}, 1, ${nativeSessionId}, 1, 'applied')`;
              const response = await withMemoryEmissionReceipt(rootSql, ownerId, [], async () => {
                collectMemoryEmission(ownerId, [row]);
                return { content: [{ type: 'text', text: visible }] };
              }, hostScope);
              offer = response._meta?.['papercusp/memoryEmission'] as typeof offer;
              expect(response._meta?.['papercusp/contextPreparation']).toMatchObject({ status: 'stored' });
              return response;
            } });
        expect(offer).toBeDefined();
        expect(await confirmMemoryEmission(rootSql, ownerId, offer!)).toBe(1);
        expect(await confirmMemoryEmission(rootSql, ownerId, offer!)).toBe(0);
        const census = await collectContextPackingReceiptSources(scope);
        expect(census.complete).toBe(true); expect(census.mcpSources).toHaveLength(1);
        expect(JSON.stringify(census)).not.toContain(row.rendered);
        const digest = (text: string) => createHash('sha256').update(text).digest('hex');
        const exported = exportContextPackingAttemptSnapshot(census, { snapshotId: `native-${client}`,
          sourceSchemaSha256: digest('durable-source-v1'), measuredAt: census.capturedAt,
          runtimeGeneration: capture.clientVersion, environmentSha256: digest('fixture-environment'), configurationSha256: digest('fixture-config') });
        expect(exported.complete).toBe(true);
        const snapshot = exported.snapshot!, native = capture.nativeTranscript!;
        expect(native).toBeDefined();
        expect(snapshot.attempts[0]!.nativeSessionId).toBe(native.nativeSessionId);
        expect(snapshot.attempts[0]!.context.block).toBeNull();
        const locators = nativeMcpTranscriptLocators(capture, snapshot.attempts[0]!, visible);
        expect(locators).toHaveLength(1);
        const bound = { ...native, client, recipient: ownerId, workspace: WS, epoch: 3 };
        const joined = joinFinalContextNativeEmissions(snapshot, bound, locators, capture.stdoutEmissions ?? []);
        Object.assign(task.meta, { durableNativeJoin: { census, source: native, locators,
          emissions: capture.stdoutEmissions, joins: joined.joins, snapshot: joined.snapshot,
          limits: ['fixture-enrolled-runtime', 'independent-labels-unavailable', 'task-benefit-unlabelled'] } });
        expect(joined.joins, JSON.stringify(joined.joins)).toMatchObject([{ status: 'joined', unknown: [] }]);
        expect(joined.snapshot.receipts).toHaveLength(1);
        expect(sampleFinalDeliveredContext(joined.snapshot)).toMatchObject({ attempted: 1, usefulSuccesses: 0, usefulUnknown: 1 });
      } finally { resetReadCursorStore(); }
    }, 120_000);
  it('flushes a fallback timestamp created in another Date realm through the real PG driver', async () => {
    const telemetry = await import('./degradation/fallback-observations');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const observedAt: Date = runInNewContext('new Date("2026-11-12T15:00:00.000Z")');
      expect(observedAt instanceof Date).toBe(false);
      telemetry.observeFallback('mcp-date-realm-regression', { eligible: 1, applied: 0, reason: 'fixture' },
        { sql: rootSql, workspaceId: WS, observedAt });
      expect(await telemetry.flushFallbackObservations({ sql: rootSql })).toMatchObject({ written: 1, failed: 0 });
      expect(warn).not.toHaveBeenCalled();
      const rows = await rootSql`SELECT observed_at FROM harness_shared.fallback_observations
        WHERE mechanism='mcp-date-realm-regression'`;
      expect(rows).toHaveLength(1);
      expect(new Date(rows[0]!.observed_at).toISOString()).toBe('2026-11-12T15:00:00.000Z');
    } finally { telemetry._resetFallbackObservationsForTests(); warn.mockRestore(); }
  });

  it('keeps real PG MCP attempts after successful cursor cleanup and leaves empty or unbound samples UNKNOWN', async () => {
    const cursors = new InMemoryReadCursorStore();
    const staged = vi.spyOn(cursors, 'stage'), cleared = vi.spyOn(cursors, 'clear');
    configureReadCursorStore(cursors);
    try {
      await rootSql.unsafe(`CREATE TABLE IF NOT EXISTS harness_shared.memory_session_surfaced (
        session_id text NOT NULL, epoch integer NOT NULL, memory_id uuid NOT NULL, port text,
        source_fingerprint text, source_version jsonb, surfaced_at timestamptz DEFAULT now(), PRIMARY KEY(session_id,epoch,memory_id))`);
      const scope: ContextPackingScope = { workspaceId: WS, ownerId: 'mcp-owner', harness: 'web', client: 'codex', port: 'mcp-result' };
      const row = memoryFragmentOffer('memory', '11111111-1111-1111-1111-111111111111', 3, 'orient', 'SECRET recalled ☃ source');
      const { ownerId, ...hostScope } = scope;
      const result = await withMemoryEmissionReceipt(rootSql, ownerId, [], async () => {
        collectMemoryEmission(ownerId, [row]);
        return { content: [{ type: 'text', text: row.rendered }] };
      }, hostScope);
      const receipt = result._meta?.['papercusp/memoryEmission'] as { token: string; fragments: MemoryFragmentManifest[] };
      expect(result._meta?.['papercusp/contextPreparation']).toMatchObject({ status: 'stored', attemptId: receipt.token });
      expect(staged).toHaveBeenCalledWith(ownerId, `memory-emission:${receipt.token}`, expect.objectContaining({ fragments: expect.any(Array) }));
      expect(await confirmMemoryEmission(rootSql, ownerId, receipt)).toBe(1);
      expect(cleared).toHaveBeenCalledWith(ownerId, `memory-emission:${receipt.token}`);
      expect((await cursors.ackAndRead(ownerId, `memory-emission:${receipt.token}`)).committed).toBeNull();
      await withMemoryEmissionReceipt(rootSql, ownerId, [], async () => ({ content: [] }), hostScope);
      const census = await collectContextPackingReceiptSources(scope);
      expect(census).toMatchObject({ complete: true, claimsScanned: 2, sources: [], unknown: [] });
      expect(census.mcpSources).toHaveLength(2);
      expect(JSON.stringify(census)).not.toContain('SECRET');
      expect(census.mcpSources?.find(source => source.stored.attemptId === receipt.token)?.stored.fragments[0])
        .toMatchObject({ id: row.id, bodySha256: row.bodySha256, selected: true });
      const digest = (text: string) => createHash('sha256').update(text).digest('hex');
      const exported = exportContextPackingAttemptSnapshot(census, { snapshotId: 'mcp-collected', sourceSchemaSha256: digest('schema'),
        measuredAt: census.capturedAt, runtimeGeneration: 'fixture-runtime', environmentSha256: digest('env'), configurationSha256: digest('config') });
      expect(exported.complete).toBe(true);
      expect(sampleFinalDeliveredContext(exported.snapshot!)).toMatchObject({ attempted: 2, usefulSuccesses: 0, usefulUnknown: 2 });
      const foreign = await collectContextPackingReceiptSources({ ...scope, ownerId: 'other' });
      expect(foreign.mcpSources ?? []).toEqual([]); expect(foreign.excluded).toHaveLength(2);
    } finally { resetReadCursorStore(); }
  });
  it.each(['codex', 'claude', 'omp'] as const)('captures real PG epoch and exact %s binding before later compaction/reanchor', async client => {
    const scope: ContextPackingScope = { workspaceId: WS, ownerId: 'packing-owner', harness: 'web', port: 'turn-start', client };
    const missing = await captureContextPackingAttribution(scope, rootSql);
    expect(missing).toMatchObject({ epoch: null, nativeSession: null, unknown: ['epoch-unavailable', 'native-session-unavailable'] });
    await rootSql`INSERT INTO harness_shared.memory_session_epochs (session_id, epoch) VALUES (${scope.ownerId}, 0)`;
    await rootSql`INSERT INTO harness_shared.adv_sessions (id, workspace_id, coord_owner_id, agent, session_id, omp_thread_id)
      VALUES (42, ${WS}, ${scope.ownerId}, ${client}, 'native-a', 'native-a')`;
    await rootSql`INSERT INTO harness_shared.session_identity_activation_events
      (id, workspace_id, owner_id, adv_session_id, native_session_id, control_generation, phase)
      VALUES (9, ${WS}, ${scope.ownerId}, 42, 'native-a', 3, 'applied')`;
    const attribution = await captureContextPackingAttribution(scope, rootSql);
    expect(attribution).toMatchObject({ epoch: 0, nativeSession: { backend: client, sessionId: 'native-a', activationEventId: '9' }, unknown: [] });
    const candidates = [{ sourceRef: 'private:grant', revision: 'r1', class: 'granted' as const, required: false, text: 'private plaintext' }];
    const packed = packContextCandidates({ attemptId: 'identity-attempt', budgetBytes: 100, candidates });
    const ref = await saveContextPackingReceipt(scope, packed.receipt, { createdAt: attribution.observedAt, attribution,
      text: packed.text, candidates, selectedIndexes: packed.selectedIndexes });
    await rootSql`UPDATE harness_shared.memory_session_epochs SET epoch=1, bumped_at=now()`;
    await rootSql`UPDATE harness_shared.adv_sessions SET session_id='native-b', omp_thread_id='native-b'`;
    const changed = await captureContextPackingAttribution(scope, rootSql);
    expect(changed).toMatchObject({ epoch: 1, nativeSession: null, unknown: ['native-session-unavailable'] });
    const stored = await loadContextPackingReceipt(scope, packed.receipt.attemptId);
    expect(stored?.preparation).toBeUndefined();
    expect(stored?.preparationWithheld?.attribution).toEqual(attribution);
    expect(await loadImmutableTextArtifact('web', ref.sha256)).not.toContain('private plaintext');
    const census = await collectContextPackingReceiptSources(scope);
    expect(census.sources[0]?.stored.preparationWithheld?.attribution).toEqual(attribution);
    expect(census.sources[0]?.state).toBe('withheld');
  });
});

describe('text-artifacts (drizzle, PG)', () => {
  it('inventories canonical packing claims without losing withheld, legacy, or missing attempts', async () => {
    const scope: ContextPackingScope = { workspaceId: WS, ownerId: 'census-owner', harness: 'web', port: 'turn-start', client: 'codex' };
    const save = async (attemptId: string, privateText = false, legacy = false, targetScope = scope) => {
      const candidates = [{ sourceRef: 'memory:1', revision: 'r1', class: privateText ? 'granted' as const : 'memory' as const,
        required: false, text: privateText ? 'private grant body' : 'complete condition ☃' }];
      const packed = packContextCandidates({ attemptId, budgetBytes: 100, candidates });
      return saveContextPackingReceipt(targetScope, packed.receipt, legacy ? undefined : {
        createdAt: '2026-11-12T15:00:00.000Z', text: packed.text, selectedIndexes: packed.selectedIndexes, candidates,
      });
    };
    const prepared = await save('census-prepared');
    await save('census-withheld', true);
    await save('census-legacy', false, true);
    await save('census-other-owner', false, false, { ...scope, ownerId: 'other-owner' });
    await save('census-other-port', false, false, { ...scope, port: 'mid-turn' });
    await claimImmutableTextArtifact('web', 'unrelated', 'non-packing execution claim');
    await saveImmutableTextArtifact('web', JSON.stringify({ scope, receipt: { attemptId: 'orphan-not-an-attempt' } }));
    const census = await collectContextPackingReceiptSources(scope);
    expect(census.complete).toBe(true);
    expect(census.sources.map(row => row.state).sort()).toEqual(['legacy', 'prepared', 'withheld']);
    expect(census.sources.find(row => row.sha256 === prepared.sha256)?.stored.preparation?.text).toBe('complete condition ☃');
    expect(JSON.stringify(census)).not.toContain('private grant body');
    expect(census.excluded.map(row => row.reason).sort()).toEqual(['different-scope', 'different-scope', 'other-artifact']);
    expect(census.sources.length + census.excluded.length + census.unknown.length).toBe(census.claimsScanned);
    expect(census).toMatchObject({ isolation: 'repeatable read', unknown: [] });
    // A missing source prevents a complete census; its claim stays in the partition.
    await rootSql`DELETE FROM harness_shared.harness_text_artifacts WHERE harness_slug='web' AND rel_path=${prepared.relPath}`;
    const missing = await collectContextPackingReceiptSources(scope);
    expect(missing.complete).toBe(false);
    expect(missing.unknown).toEqual([{ claimPath: prepared.path, reason: 'source-missing' }]);
    expect(missing.sources.length + missing.excluded.length + missing.unknown.length).toBe(missing.claimsScanned);
    await expect(collectContextPackingReceiptSources({ ...scope, workspaceId: 'foreign' })).rejects.toThrow('scope_invalid');
  });

  it.each(['claim', 'source', 'claim-binding', 'foreign-target'] as const)('keeps %s corruption explicit in a packing census', async fault => {
    const scope: ContextPackingScope = { workspaceId: WS, ownerId: 'census-owner', harness: 'web', port: 'mid-turn', client: 'omp' };
    const packed = packContextCandidates({ attemptId: 'census-corrupt', budgetBytes: 100, candidates: [] });
    const ref = await saveContextPackingReceipt(scope, packed.receipt);
    if (fault === 'claim') {
      await rootSql`UPDATE harness_shared.harness_text_artifacts SET content='private claim content must stay out of diagnostics' WHERE harness_slug='web' AND rel_path=${ref.path}`;
    } else if (fault === 'source') {
      await rootSql`UPDATE harness_shared.harness_text_artifacts SET content='corrupt' WHERE harness_slug='web' AND rel_path=${ref.relPath}`;
    } else if (fault === 'foreign-target') {
      await rootSql`UPDATE harness_shared.harness_text_artifacts SET workspace_id='foreign' WHERE harness_slug='web' AND rel_path=${ref.relPath}`;
    } else {
      const other = await saveImmutableTextArtifact('web', JSON.stringify({ scope, receipt: { ...packed.receipt, attemptId: 'wrong-attempt' } }));
      const content = JSON.stringify({ sha256: other.sha256 });
      const wrapper = JSON.stringify({ sha256: createHash('sha256').update(content).digest('hex'), content });
      await rootSql`UPDATE harness_shared.harness_text_artifacts SET content=${wrapper} WHERE harness_slug='web' AND rel_path=${ref.path}`;
    }
    const census = await collectContextPackingReceiptSources(scope);
    expect(census.complete).toBe(false);
    expect(census.sources).toEqual([]);
    expect(census.claimsScanned).toBe(1);
    expect(census.unknown).toEqual([{ claimPath: ref.path, reason: expect.any(String) }]);
    expect(JSON.stringify(census)).not.toContain('private claim content');
    if (fault === 'claim') expect(census.unknown[0]!.reason).toBe('claim-invalid');
  });

  it('persists replayable prepared context through the canonical packing reader without an emission claim', async () => {
    const scope: ContextPackingScope = { workspaceId: WS, ownerId: 'prepared-owner', harness: 'web', port: 'turn-start', client: 'codex' };
    const candidates = [
      { sourceRef: 'owner:1', revision: 'r1', class: 'owner' as const, required: true, text: 'Keep the complete ☃ duty' },
      { sourceRef: 'memory:2', revision: 'r2', class: 'memory' as const, required: false, text: 'Omitted condition '.repeat(30) },
    ];
    const packed = packContextCandidates({ attemptId: 'prepared-context', budgetBytes: 40, candidates,
      carrier: { client: 'codex', port: 'turn-start' } });
    const preparation = { createdAt: '2026-11-12T15:00:00.000Z', text: packed.text, selectedIndexes: packed.selectedIndexes, candidates };
    const first = await saveContextPackingReceipt(scope, packed.receipt, preparation);
    expect(await saveContextPackingReceipt(scope, packed.receipt, preparation)).toEqual(first);
    const stored = await loadContextPackingReceipt(scope, packed.receipt.attemptId);
    expect(stored?.preparation).toMatchObject({ ...preparation, emission: 'UNKNOWN', schemaVersion: 'context-packing-source-v1' });
    expect(stored?.receipt.candidates.map(row => row.reason)).toEqual(['selected', 'budget']);
    expect(JSON.parse((await loadImmutableTextArtifact('web', first.sha256))!)).toEqual(stored);
    expect(await wsOf('web', first.path)).toBe(WS);
    expect(await wsOf('web', first.relPath)).toBe(WS);
    await expect(saveContextPackingReceipt(scope, packed.receipt, { ...preparation,
      createdAt: '2026-11-12T15:00:01.000Z' })).rejects.toThrow('attempt_conflict');
    expect(await loadContextPackingReceipt(scope, packed.receipt.attemptId)).toEqual(stored);
  });

  it('collects enrolled final-context sources through real PG without certifying native emission', async () => {
    const digest = (text: string) => createHash('sha256').update(text).digest('hex');
    const source: FinalContextAttemptSnapshot = {
      schemaVersion: 'final-attempt-source-v1', snapshotId: 'pg-source', sourceSchemaSha256: digest('fixture-schema'),
      measuredAt: '2026-11-12T12:00:00.000Z', capturedAt: '2026-11-12T12:00:01.000Z',
      runtimeGeneration: 'fixture-runtime', environmentSha256: digest('fixture-env'), configurationSha256: digest('fixture-config'),
      attempts: [{ sourceStoreId: 'pg-attempts', attemptId: 'a', attemptSchemaVersion: 'prompt-v1', recordVersion: 1,
        createdAt: '2026-11-12T10:00:00.000Z', visibleAt: '2026-11-12T11:00:00.000Z',
        client: 'codex', sink: 'turn-start', recipient: 'recipient', workspace: WS, epoch: 0,
        context: { attemptId: 'a', sessionId: 'recipient', epoch: 0, port: 'turn-start', block: '字 body',
          fragments: [{ sourceRef: 'memory:m', factKey: 'f', text: '字 body' }] } }], receipts: [],
    };
    const artifact = await saveImmutableTextArtifact('web', JSON.stringify(source));
    const { attempts: _attempts, receipts: _receipts, ...metadata } = source;
    const enrollment = { snapshot: { ...metadata, snapshotId: 'pg-collected' }, recipient: 'recipient', workspace: WS,
      sources: [{ harness: 'web', sha256: artifact.sha256, sourceStoreIds: ['pg-attempts'] }] };
    const collected = await collectFinalContextAttemptSnapshot(enrollment);
    expect(collected.complete).toBe(true);
    expect(collected.snapshot?.attempts).toEqual(source.attempts);
    expect(collected.sample).toMatchObject({ attempted: 1, usefulSuccesses: 0, usefulUnknown: 1 });
    expect(collected.sample?.attempts[0]!.assessment.unknown).toContain('terminal-receipt-unmatched');
    expect(await wsOf('web', artifact.relPath)).toBe(WS);
    const missing = await collectFinalContextAttemptSnapshot({ ...enrollment,
      sources: [...enrollment.sources, { ...enrollment.sources[0]!, sha256: 'f'.repeat(64) }] });
    expect(missing).toMatchObject({ complete: false, snapshot: null, sample: null });
    expect(missing.sources[1]!.reason).toBe('source-missing');
    await rootSql`UPDATE harness_shared.harness_text_artifacts SET workspace_id='foreign'
      WHERE harness_slug='web' AND rel_path=${artifact.relPath}`;
    expect(await collectFinalContextAttemptSnapshot(enrollment)).toMatchObject({ complete: false, snapshot: null,
      sources: [{ status: 'UNKNOWN', reason: 'source-missing' }] });
    await rootSql`UPDATE harness_shared.harness_text_artifacts SET workspace_id=${WS}, content='tampered'
      WHERE harness_slug='web' AND rel_path=${artifact.relPath}`;
    expect(await collectFinalContextAttemptSnapshot(enrollment)).toMatchObject({ complete: false, snapshot: null,
      sources: [{ status: 'UNKNOWN', reason: 'read-failed' }] });
  });

  it.each([0, 1])('retains the complete packing attempt outside a B=%i context, including immutable lookup and diagnostic pages', async budgetBytes => {
    const scope: ContextPackingScope = { workspaceId: WS, ownerId: 'receipt-owner', harness: 'web', port: 'turn-start', client: 'codex' };
    const receipt = packContextCandidates({ attemptId: `packing-${budgetBytes}`, budgetBytes, candidates: [
      { sourceRef: 'control:revision-1', revision: 'r1', class: 'control', required: true, text: '⟦CTRL⟧' },
      ...Array.from({ length: 24 }, (_, i) => ({ sourceRef: `memory:${i}:` + '字'.repeat(150), revision: 'r1',
        class: 'memory' as const, required: false, text: `- complete condition ${i}` })),
    ] }).receipt;
    const [first, retry] = await Promise.all([
      saveContextPackingReceipt(scope, receipt), saveContextPackingReceipt(scope, receipt),
    ]);
    expect(first).toEqual(retry);
    expect(receipt.contextBytes).toBe(0);
    expect(receipt.status).toBe('mandatory-overflow');
    const stored = await loadContextPackingReceipt(scope, receipt.attemptId);
    expect(stored).toEqual({ scope, receipt });
    expect(await wsOf('web', first.path)).toBe(WS);
    expect(await wsOf('web', first.relPath)).toBe(WS);
    for (const path of [first.path, first.relPath]) {
      await expect(saveTextArtifact('web', path, 'replacement')).rejects.toThrow('immutable_namespace');
      await expect(appendTextArtifact('web', path, 'append')).rejects.toThrow('immutable_namespace');
      await expect(deleteTextArtifact('web', path)).rejects.toThrow('immutable_namespace');
      await expect(compareAndSwapTextArtifact('web', path, null, 'replacement')).rejects.toThrow('immutable_namespace');
    }
    const chunks: Buffer[] = [];
    let offset: number | null = 0;
    do {
      const text = pageContextPackingReceipt(stored!, offset);
      expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(6000);
      const page = JSON.parse(text);
      expect(page.offset).toBe(offset);
      chunks.push(Buffer.from(page.data, 'base64'));
      if (page.nextOffset !== null) expect(page.nextOffset).toBeGreaterThan(offset!);
      offset = page.nextOffset;
    } while (offset !== null);
    expect(chunks.length).toBeGreaterThan(1);
    expect(JSON.parse(Buffer.concat(chunks).toString('utf8'))).toEqual(stored);
    expect(await loadContextPackingReceipt({ ...scope, ownerId: 'another-owner' }, receipt.attemptId)).toBeNull();
    expect(await loadContextPackingReceipt({ ...scope, port: 'mid-turn' }, receipt.attemptId)).toBeNull();
    expect(await loadContextPackingReceipt({ ...scope, client: 'claude' }, receipt.attemptId)).toBeNull();
    await expect(loadContextPackingReceipt({ ...scope, workspaceId: 'foreign' }, receipt.attemptId)).rejects.toThrow('scope_invalid');
  });

  it('keeps one packing attempt winner under conflicting concurrent writes and detects corrupt index bytes', async () => {
    const scope: ContextPackingScope = { workspaceId: WS, ownerId: 'receipt-race', harness: 'web', port: 'mid-turn', client: 'omp' };
    const make = (budgetBytes: number) => packContextCandidates({ attemptId: 'same-attempt', budgetBytes, candidates: [] }).receipt;
    const outcomes = await Promise.allSettled([saveContextPackingReceipt(scope, make(0)), saveContextPackingReceipt(scope, make(1))]);
    const wins = outcomes.filter(row => row.status === 'fulfilled');
    const losses = outcomes.filter(row => row.status === 'rejected');
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(1);
    expect((losses[0] as PromiseRejectedResult).reason.message).toBe('context_packing_attempt_conflict');
    const winner = (wins[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof saveContextPackingReceipt>>>).value;
    const stored = await loadContextPackingReceipt(scope, 'same-attempt');
    expect(createHash('sha256').update(JSON.stringify(stored)).digest('hex')).toBe(winner.sha256);
    await rootSql`UPDATE harness_shared.harness_text_artifacts SET content=${JSON.stringify({ sha256: '0'.repeat(64), content: 'tampered' })}
      WHERE harness_slug='web' AND rel_path=${winner.path}`;
    await expect(loadContextPackingReceipt(scope, 'same-attempt')).rejects.toThrow('immutable_corrupt');
  });

  it('captures signed full host discovery through real PG without granting population closure', async () => {
    const q = await import('./coverage-census/security-qualification');
    const runtime = await import('./observability/runtime');
    const context: UnifiedToolContext = { uiClientId: 'su-discovery-producer', workspaceId: WS, harnessSlug: 'web', isSuperuser: true,
      log: () => {}, signal: new AbortController().signal, progress: async () => {}, emit: async () => {},
      principal: { kind: 'system', slug: 'system:superuser', workspaceId: WS,
        authMethod: 'bearer-token', trust: 'trusted', capabilities: new Set() } };
    const release = runtime.registerRuntimeSecurityCapture(async () => ({
      surfaces: Array.from({ length: 503 }, (_, i) => ({ kind: 'mounted-http-handler', surfaceId: `fixture:${i}`,
        fidelity: 'observed' as const, attrs: { actualEffectCoverage: 'unknown' } })),
      declaredSurfaces: [], unresolved: ['fixture-only-not-production-closure'],
    }));
    try {
      const captured = await q.captureAuthenticatedRuntimeSecurityCensus(context, 'web');
      const verified = await q.verifyAuthenticatedRuntimeSecurityCensus('web', captured);
      expect(captured).toMatchObject({ readbackVerified: true, total: 503,
        populationComplete: false, closureAccepted: false, executionAdmitted: false });
      expect(verified.snapshot.rows).toHaveLength(503);
      expect(verified.snapshot.unresolved).toContain('fixture-only-not-production-closure');
      expect(verified.receipt.actor).toBe('su-discovery-producer');
      expect(verified.receipt.snapshotSha256).toBe(captured.snapshotRef);
      expect(await loadImmutableTextArtifact('web', captured.snapshotRef)).toContain('fixture:502');
      for (const ref of [captured.snapshotRef, captured.receiptRef]) {
        await expect(saveTextArtifact('web', `immutable/sha256/${ref}.json`, 'replace')).rejects.toThrow('immutable_namespace');
      }
      const corrupted = JSON.parse((await loadImmutableTextArtifact('web', captured.snapshotRef))!);
      corrupted.rows.pop();
      await rootSql`UPDATE harness_shared.harness_text_artifacts SET content=${JSON.stringify(corrupted)}
        WHERE harness_slug='web' AND rel_path=${`immutable/sha256/${captured.snapshotRef}.json`}`;
      await expect(q.verifyAuthenticatedRuntimeSecurityCensus('web', captured)).rejects.toThrow();
    } finally { release(); }
  });

  it('commits signed review, consumes one execution and verifies exact result custody through real PG', async () => {
    const q = await import('./coverage-census/security-qualification');
    const { SECURITY_POPULATIONS, securityTupleId } = await import('./coverage-census/security-manifest');
    const context = (owner: string): UnifiedToolContext => ({ uiClientId: `su-${owner}`, workspaceId: WS, harnessSlug: 'web', isSuperuser: true,
      log: () => {}, signal: new AbortController().signal, progress: async () => {}, emit: async () => {},
      principal: { kind: 'system', slug: 'system:superuser', workspaceId: WS,
        authMethod: 'bearer-token', trust: 'trusted', capabilities: new Set() } });
    const source = { revision: 'storage-fixture-source', sha256: 'a'.repeat(64) };
    const produced = await q.captureAuthenticatedSecurityManifest(context('producer'), 'web', { source, runtime: source,
      inputs: SECURITY_POPULATIONS.map(population => ({ id: population, population, source,
        surfaces: [{ kind: population, surfaceId: population, fidelity: 'declared' }] })) });
    const tuples = SECURITY_POPULATIONS.map(population => ({ population, kind: population, surfaceId: population,
      distribution: 'fixture-installed', platform: 'linux', runtime: 'node', enforcementMode: 'strict', effect: 'fs', channel: 'mcp' }));
    const planned = await q.prepareAuthenticatedSecurityLedger(context('ledger-producer'), 'web', {
      manifestSha256: produced.manifest.sha256, tuples, dispositions: tuples.map(tuple => ({
        rowId: securityTupleId(tuple), applicability: 'notApplicable', reason: 'Storage fixture only, no qualification claim',
        sourceRefs: ['fixture:storage'] })),
    });
    const input = await q.commitSecurityApplicability(context('reviewer'), 'web', {
      manifestSha256: produced.manifest.sha256, ledgerSha256: planned.ledger.sha256,
      manifestProducerRef: produced.producerRef, ledgerProducerRef: planned.producerRef,
      executor: 'su-executor', reviewRef: 'fixture:independent-storage-check',
      expectedTuples: tuples, expectedDispositions: planned.ledger.body.rows.map(row => row.disposition) });
    const execute = vi.fn(async (pins: { startRef: string }) => {
      expect(await loadImmutableTextArtifactClaim('web', `security-qualification:start:${input.approvalRef}`)).toBe(pins.startRef);
      return 'storage-control';
    });
    const attempts = await Promise.allSettled(Array.from({ length: 3 }, () =>
      q.runSecurityQualification(context('executor'), 'web', input, execute)));
    expect(attempts.filter(a => a.status === 'fulfilled')).toHaveLength(1);
    expect(execute).toHaveBeenCalledTimes(1);
    const success = attempts.find(a => a.status === 'fulfilled');
    if (!success || success.status !== 'fulfilled') throw new Error('no successful control');
    const verified = await q.verifySecurityQualificationResult('web', success.value);
    expect(verified.ledger.body.rows.map(r => r.rowId)).toEqual(planned.ledger.body.rows.map(r => r.rowId));
    await expect(q.runSecurityQualification(context('executor'), 'web', input, execute)).rejects.toThrow('already_consumed');
    await expect(q.verifySecurityQualificationResult('web', { ...success.value, ledgerSha256: 'f'.repeat(64) }))
      .rejects.toThrow('result_pin_substitution');
  });

  it('routes authenticated security custody through testing adapters with real PG result readback', async () => {
    const a = await import('./agent-tools/testing/run-security-qualification');
    const { SECURITY_POPULATIONS, securityTupleId } = await import('./coverage-census/security-manifest');
    const context = (owner: string): UnifiedToolContext => ({ uiClientId: `su-${owner}`, workspaceId: WS,
      harnessSlug: 'web', isSuperuser: true, log: () => {}, signal: new AbortController().signal,
      progress: async () => {}, emit: async () => {}, principal: { kind: 'system', slug: 'system:superuser',
        workspaceId: WS, authMethod: 'bearer-token', trust: 'trusted', capabilities: new Set() } });
    const source = { revision: 'adapter-storage-fixture', sha256: 'a'.repeat(64) };
    const produced = await a.securityQualificationMetadata(context('producer'), 'web', { phase: 'manifest',
      manifest: { source, runtime: source, inputs: SECURITY_POPULATIONS.map(population => ({ id: population,
        population, source, surfaces: [{ kind: population, surfaceId: population, fidelity: 'declared' }] })) } });
    if (!('manifestSha256' in produced) || !('producerRef' in produced)) throw Error('no manifest');
    const tuples = SECURITY_POPULATIONS.map(population => ({ population, kind: population, surfaceId: population,
      distribution: 'fixture', platform: 'linux', runtime: 'node', enforcementMode: 'strict', effect: 'fs', channel: 'mcp' }));
    const dispositions = tuples.map(tuple => ({ rowId: securityTupleId(tuple), applicability: 'notApplicable' as const,
      reason: 'Storage fixture, no security acceptance', sourceRefs: ['fixture:adapter-storage'] }));
    const planned = await a.securityQualificationMetadata(context('producer'), 'web', { phase: 'ledger',
      manifestSha256: produced.manifestSha256, tuples, dispositions });
    if (!('ledgerSha256' in planned) || !('producerRef' in planned)) throw Error('no ledger');
    const review = { phase: 'review' as const, manifestSha256: produced.manifestSha256,
      ledgerSha256: planned.ledgerSha256, manifestProducerRef: produced.producerRef,
      ledgerProducerRef: planned.producerRef, executor: 'su-executor', reviewRef: 'fixture:review',
      expectedTuples: tuples, expectedDispositions: dispositions };
    await expect(a.securityQualificationMetadata(context('producer'), 'web', review)).rejects.toThrow('reviewer_not_independent');
    const extra = { ...tuples[0], platform: 'darwin-arm64' };
    await expect(a.securityQualificationMetadata(context('reviewer'), 'web', { ...review,
      expectedTuples: [...tuples, extra], expectedDispositions: [...dispositions, {
        rowId: securityTupleId(extra), applicability: 'notApplicable', reason: 'Independent additional platform',
        sourceRefs: ['fixture:additional-platform'],
      }] })).rejects.toThrow('applicability_reconciliation_mismatch');
    const approved = await a.securityQualificationMetadata(context('reviewer'), 'web', review);
    if (!('approvalRef' in approved)) throw Error('no approval');
    const approvalBytes = await loadImmutableTextArtifact('web', approved.approvalRef);
    if (!approvalBytes) throw Error('missing approval');
    const approval = JSON.parse(approvalBytes).event;
    const comparisonBytes = await loadImmutableTextArtifact('web', approval.applicabilityEvidenceSha256);
    if (!comparisonBytes) throw Error('missing comparison');
    expect(JSON.parse(comparisonBytes)).toMatchObject({ producer: 'su-reviewer', manifestSha256: produced.manifestSha256 });
    const input = { phase: 'execute' as const, manifestSha256: review.manifestSha256,
      ledgerSha256: review.ledgerSha256, approvalRef: approved.approvalRef };
    // The callback is a storage fixture: this tests real signing/SQL/adapter
    // ordering and replay protection, not a router or confinement verdict.
    const core = vi.fn(async () => ({ ok: true, runId: 'adapter-storage-run', files: 1, passed: 1, failed: 0 }));
    const result = await a.executeSecurityQualification(context('executor'), 'web', input, core);
    expect(result.securityQualification).toMatchObject({ custodyOnly: true, securityVerdict: 'unmeasured' });
    const resultRef = result.securityQualification?.resultRef;
    if (typeof resultRef !== 'string') throw Error('no result ref');
    const verified = await a.securityQualificationMetadata(context('reviewer'), 'web', {
      phase: 'verify', manifestSha256: input.manifestSha256, ledgerSha256: input.ledgerSha256, resultRef });
    expect(verified).toMatchObject({ readbackVerified: true, runId: 'adapter-storage-run', rows: 7,
      custodyOnly: true, securityVerdict: 'unmeasured' });
    await expect(a.executeSecurityQualification(context('executor'), 'web', input, core)).rejects.toThrow('already_consumed');
    expect(core).toHaveBeenCalledTimes(1);
    const evidenceRef = result.securityQualification?.executionEvidenceSha256;
    if (typeof evidenceRef !== 'string') throw Error('no execution evidence');
    await rootSql`UPDATE harness_shared.harness_text_artifacts SET content='{}'
      WHERE harness_slug='web' AND rel_path=${`immutable/sha256/${evidenceRef}.json`}`;
    await expect(a.securityQualificationMetadata(context('reviewer'), 'web', {
      phase: 'verify', manifestSha256: input.manifestSha256, ledgerSha256: input.ledgerSha256, resultRef })).rejects.toThrow();
  });

  it('permanently consumes an immutable execution slot exactly once under concurrency', async () => {
    const slot = 'security-qualification:start:approval';
    const results = await Promise.all(Array.from({ length: 5 }, () => claimImmutableTextArtifact('web', slot, 'start')));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await loadImmutableTextArtifactClaim('web', slot)).toBe('start');
    await expect(claimImmutableTextArtifact('web', slot, 'replay')).rejects.toThrow('claim_conflict');
    const [row] = await rootSql<{ rel_path: string }[]>`SELECT rel_path FROM harness_shared.harness_text_artifacts`;
    await expect(saveTextArtifact('web', row.rel_path, 'reopen')).rejects.toThrow('immutable_namespace');
    await expect(deleteTextArtifact('web', row.rel_path)).rejects.toThrow('immutable_namespace');
    await rootSql`UPDATE harness_shared.harness_text_artifacts SET workspace_id='foreign'`;
    expect(await loadImmutableTextArtifactClaim('web', slot)).toBeNull();
    await expect(claimImmutableTextArtifact('web', slot, 'start')).rejects.toThrow('claim_conflict');
  });

  it('preserves concurrent immutable revisions and refuses every ordinary write path', async () => {
    const first = await saveImmutableTextArtifact('web', '{"revision":1}');
    const same = await Promise.all(Array.from({ length: 3 }, () => saveImmutableTextArtifact('web', '{"revision":1}')));
    expect(same.every(ref => ref.sha256 === first.sha256)).toBe(true);
    const second = await saveImmutableTextArtifact('web', '{"revision":2}');
    expect(second.sha256).not.toBe(first.sha256);
    for (const key of [first.relPath, `.papercusp/${first.relPath}`]) {
      await expect(saveTextArtifact('web', key, 'changed')).rejects.toThrow('immutable_namespace');
      await expect(appendTextArtifact('web', key, 'changed')).rejects.toThrow('immutable_namespace');
      await expect(deleteTextArtifact('web', key)).rejects.toThrow('immutable_namespace');
      await expect(compareAndSwapTextArtifact('web', key, '{"revision":1}', 'changed')).rejects.toThrow('immutable_namespace');
      await expect(compareAndSwapTextArtifact('web', key, null, 'changed')).rejects.toThrow('immutable_namespace');
    }
    expect(await loadImmutableTextArtifact('web', first.sha256)).toBe('{"revision":1}');
    expect(await loadImmutableTextArtifact('web', second.sha256)).toBe('{"revision":2}');
    // An administrative DB write is not granted by these APIs. Detect it on read.
    await rootSql`UPDATE harness_shared.harness_text_artifacts SET content='tampered' WHERE rel_path=${first.relPath}`;
    await expect(loadImmutableTextArtifact('web', first.sha256)).rejects.toThrow('immutable_corrupt');
    await expect(saveImmutableTextArtifact('web', '{"revision":1}')).rejects.toThrow('immutable_corrupt');
  });

  it('never adopts a foreign workspace immutable revision', async () => {
    const ref = await saveImmutableTextArtifact('web', 'content');
    await rootSql`UPDATE harness_shared.harness_text_artifacts SET workspace_id='other-ws' WHERE rel_path=${ref.relPath}`;
    expect(await loadImmutableTextArtifact('web', ref.sha256)).toBeNull();
    await expect(saveImmutableTextArtifact('web', 'content')).rejects.toThrow('immutable_conflict');
    expect(await wsOf('web', ref.relPath)).toBe('other-ws');
  });

  it('round-trips pinned security manifests and tuple ledgers through real canonical storage', async () => {
    const { createSecurityManifest, createSecurityTupleLedger, SECURITY_POPULATIONS, securityTupleId } = await import('./coverage-census/security-manifest');
    const { saveSecurityManifest, loadSecurityManifest, saveSecurityTupleLedger, loadSecurityTupleLedger } = await import('./coverage-census/security-manifest-store');
    const source = { revision: 'source-revision', sha256: 'a'.repeat(64) };
    const manifest = createSecurityManifest({ producer: 'producer', source, runtime: source,
      inputs: SECURITY_POPULATIONS.map(population => ({ id: population, population, source,
        surfaces: [{ kind: population, surfaceId: population, fidelity: 'declared' }] })) });
    const tuples = SECURITY_POPULATIONS.map(population => ({ population, kind: population, surfaceId: population,
      distribution: 'gui-installed', platform: 'linux', runtime: 'native', enforcementMode: 'strict', effect: 'process', channel: 'ipc' }));
    const ledger = createSecurityTupleLedger({ manifest, producer: 'producer', tuples,
      dispositions: tuples.map(tuple => ({ rowId: securityTupleId(tuple), applicability: 'notApplicable' as const,
        reason: 'Implementation-checker storage fixture only; no qualification claim', sourceRefs: ['fixture:storage'] })) });
    await expect(saveSecurityTupleLedger('web', ledger)).rejects.toThrow('manifest_missing');
    expect((await saveSecurityManifest('web', manifest)).sha256).toBe(manifest.sha256);
    expect(await loadSecurityManifest('web', manifest.sha256)).toEqual(manifest);
    expect((await saveSecurityTupleLedger('web', ledger)).sha256).toBe(ledger.sha256);
    expect(await loadSecurityTupleLedger('web', ledger.sha256)).toEqual(ledger);
    await expect(saveSecurityTupleLedger('web', { ...ledger, sha256: 'b'.repeat(64) })).rejects.toThrow('identity_mismatch');
    const changed = createSecurityManifest({ ...manifest.body, runtime: { ...source, sha256: 'c'.repeat(64) } });
    await saveSecurityManifest('web', changed);
    expect(await loadSecurityManifest('web', manifest.sha256)).toEqual(manifest);
    expect(await loadSecurityManifest('web', changed.sha256)).toEqual(changed);
  });

  it('archives a source shard with verified readback before persisting its lossless successor queue', async () => {
    const { createHash } = await import('node:crypto');
    const { gzipSync, gunzipSync } = await import('node:zlib');
    const { canonicalJson } = await import('@papercusp/hash-chain');
    const { prepareSecuritySourceShard } = await import('./coverage-census/security-source-census');
    const { loadSecuritySourceShard, saveSecuritySourceShard } = await import('./coverage-census/security-manifest-store');
    const bytes = Buffer.from('run();'), commit = 'a'.repeat(40);
    const file = { path: 'a.ts', repository: '.', commit, bytes,
      blobOid: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') };
    const progress: SecuritySourceProgress = { schema: 'security-source-discovery-progress-v1', parentArchive: '1'.repeat(64),
      parentRawSha256: '2'.repeat(64), repositories: [{ path: '.', commit }], capturedShards: [],
      pending: ['a.ts', 'b.ts'].map(path => ({ path, commit, blobOid: file.blobOid, bytes: bytes.length, reason: 'source-byte-budget' })),
      closureAccepted: false, populationComplete: false };
    const shard = prepareSecuritySourceShard(progress, ['a.ts'], { sources: [file], repositories: progress.repositories, unresolved: [],
      selection: { paths: ['a.ts'], maxBytes: 1000, maxFiles: 1, maxInputBytes: 1000, bytesRead: bytes.length, filesRead: 1, populationComplete: false } });
    const saved = await saveSecuritySourceShard('web', progress, shard);
    const archive = JSON.parse((await loadImmutableTextArtifact('web', saved.archive.sha256))!);
    expect(JSON.parse(gunzipSync(Buffer.from(archive.data, 'base64')).toString())).toEqual(shard.discovery);
    expect(saved.receipt).toMatchObject({ readbackVerified: true, decodedVerified: true, files: 1 });
    expect(saved.progress.pending).toEqual([progress.pending[1]]);
    expect(await loadImmutableTextArtifact('web', saved.progressArchive.sha256)).toBe(canonicalJson(saved.progress));
    expect(await loadSecuritySourceShard('web', saved.progress, saved.archive.sha256)).toEqual(shard.discovery);
    // Historical archives used JSON.stringify and omitted progressSha256.
    // Verify exact byte hashes independently from canonical census identity.
    const legacyRaw = JSON.stringify(shard.discovery);
    const legacy = { ...archive, censusFingerprint: shard.discovery.fingerprint,
      parentRawSha256: progress.parentRawSha256, closureAccepted: false, executionAdmitted: false,
      rawSha256: createHash('sha256').update(legacyRaw).digest('hex'), rawBytes: Buffer.byteLength(legacyRaw),
      data: gzipSync(legacyRaw).toString('base64') };
    delete legacy.progressSha256;
    const legacySaved = await saveImmutableTextArtifact('web', JSON.stringify(legacy));
    const legacyProgress = structuredClone(saved.progress);
    legacyProgress.capturedShards[0] = { ...legacyProgress.capturedShards[0], sha256: legacySaved.sha256,
      rawSha256: legacy.rawSha256, rawBytes: legacy.rawBytes };
    expect(await loadSecuritySourceShard('web', legacyProgress, legacySaved.sha256)).toEqual(shard.discovery);
    delete legacyProgress.capturedShards[0].consumedPaths;
    await expect(loadSecuritySourceShard('web', legacyProgress, legacySaved.sha256)).rejects.toThrow('selection_mismatch');
    expect(await loadSecuritySourceShard('web', legacyProgress, legacySaved.sha256, { expectedPaths: ['a.ts'] }))
      .toEqual(shard.discovery);
    await expect(loadSecuritySourceShard('web', legacyProgress, legacySaved.sha256, { expectedPaths: ['b.ts'] }))
      .rejects.toThrow('selection_mismatch');
    expect(await loadSecuritySourceShard('absent-harness', saved.progress, saved.archive.sha256)).toBeNull();
    await expect(loadSecuritySourceShard('web', progress, saved.archive.sha256)).rejects.toThrow('not_in_progress');
    await expect(loadSecuritySourceShard('web', saved.progress, saved.archive.sha256, { maxRawBytes: 1 }))
      .rejects.toThrow('read_budget');
    const changedParent = structuredClone(saved.progress); changedParent.parentArchive = '4'.repeat(64);
    await expect(loadSecuritySourceShard('web', changedParent, saved.archive.sha256)).rejects.toThrow('identity_mismatch');
    const changedPins = structuredClone(saved.progress); changedPins.repositories.push({ path: 'new-repo', commit });
    await expect(loadSecuritySourceShard('web', changedPins, saved.archive.sha256)).rejects.toThrow('repository_substitution');
    const changedPaths = structuredClone(saved.progress); changedPaths.capturedShards[0].consumedPaths = ['b.ts'];
    await expect(loadSecuritySourceShard('web', changedPaths, saved.archive.sha256)).rejects.toThrow('selection_mismatch');
    const changedFingerprint = structuredClone(saved.progress); changedFingerprint.capturedShards[0].censusFingerprint = '5'.repeat(64);
    await expect(loadSecuritySourceShard('web', changedFingerprint, saved.archive.sha256)).rejects.toThrow('identity_mismatch');
    // Even a newly content-addressed outer envelope cannot substitute its
    // compressed bytes or inner digest under a retained census identity.
    for (const mutation of [{ rawSha256: '6'.repeat(64) }, { data: archive.data + '\n' }]) {
      const altered = { ...archive, ...mutation };
      const stored = await saveImmutableTextArtifact('web', canonicalJson(altered));
      const substituted = structuredClone(saved.progress);
      substituted.capturedShards[0] = { ...substituted.capturedShards[0], sha256: stored.sha256,
        rawSha256: altered.rawSha256 };
      await expect(loadSecuritySourceShard('web', substituted, stored.sha256)).rejects.toThrow();
    }
    expect((await saveSecuritySourceShard('web', progress, shard)).archive).toEqual(saved.archive);
    await expect(saveSecuritySourceShard('web', saved.progress, shard)).rejects.toThrow('stale_progress');
    const corrupted = structuredClone(shard); corrupted.discovery.sites = [];
    await expect(saveSecuritySourceShard('web', progress, corrupted)).rejects.toThrow('identity_mismatch');
  });

  it('save → load round-trips, null when absent', async () => {
    expect(await loadTextArtifact('web', 'notes.md')).toBeNull();
    await saveTextArtifact('web', 'notes.md', 'hello');
    expect(await loadTextArtifact('web', 'notes.md')).toBe('hello');
  });

  it('normalizes the `.papercusp/` prefix — a prefixed write and a bare read hit the same row', async () => {
    await saveTextArtifact('web', '.papercusp/memory/a.md', 'X');
    expect(await loadTextArtifact('web', 'memory/a.md')).toBe('X'); // bare read
    expect(await loadTextArtifact('web', '.papercusp/memory/a.md')).toBe('X'); // prefixed read, same row
    expect(await rootSql`SELECT 1 FROM harness_shared.harness_text_artifacts WHERE harness_slug='web'`).toHaveLength(1);
  });

  it('save upserts on (harness_slug, rel_path) — second write overwrites, one row', async () => {
    await saveTextArtifact('web', 'f.md', 'v1');
    await saveTextArtifact('web', 'f.md', 'v2');
    expect(await loadTextArtifact('web', 'f.md')).toBe('v2');
    expect(await rootSql`SELECT 1 FROM harness_shared.harness_text_artifacts WHERE harness_slug='web' AND rel_path='f.md'`).toHaveLength(1);
  });
  it('CAS has exactly one winner for concurrent create and stale-content update', async () => {
    const created = await Promise.all(['A', 'B'].map(value => compareAndSwapTextArtifact('web', 'cas.json', null, value)));
    expect(created.filter(Boolean)).toHaveLength(1);
    const old = await loadTextArtifact('web', 'cas.json');
    const updated = await Promise.all(['C', 'D'].map(value => compareAndSwapTextArtifact('web', '.papercusp/cas.json', old, value)));
    expect(updated.filter(Boolean)).toHaveLength(1);
    expect(await compareAndSwapTextArtifact('web', 'missing.json', 'absent', 'X')).toBe(false);
    expect(await loadTextArtifact('web', 'missing.json')).toBeNull();
  });
  it('CAS refuses a foreign workspace row and preserves its content', async () => {
    await rootSql`INSERT INTO harness_shared.harness_text_artifacts (harness_slug, rel_path, content, workspace_id) VALUES ('web','foreign.json','old','other-ws')`;
    expect(await compareAndSwapTextArtifact('web', 'foreign.json', 'old', 'new')).toBe(false);
    expect(await loadTextArtifact('web', 'foreign.json')).toBe('old');
  });

  it('append ATOMICALLY concatenates via PG `content || EXCLUDED.content`', async () => {
    await appendTextArtifact('web', 'log.md', 'A'); // insert
    await appendTextArtifact('web', 'log.md', 'B'); // concat
    await appendTextArtifact('web', 'log.md', 'C');
    expect(await loadTextArtifact('web', 'log.md')).toBe('ABC');
  });

  it('delete removes the row', async () => {
    await saveTextArtifact('web', 'gone.md', 'x');
    await deleteTextArtifact('web', 'gone.md');
    expect(await loadTextArtifact('web', 'gone.md')).toBeNull();
  });

  it('EI-280: a save ADOPTS the active workspace onto a blank-stamped row, but does NOT re-home a stamped one', async () => {
    // blank legacy row → adopted
    await rootSql`INSERT INTO harness_shared.harness_text_artifacts (harness_slug, rel_path, content, updated_at, workspace_id) VALUES ('web','blank.md','old',1,'')`;
    await saveTextArtifact('web', 'blank.md', 'new');
    expect(await wsOf('web', 'blank.md')).toBe(WS); // adopted the operator workspace

    // properly-stamped row → left alone
    await rootSql`INSERT INTO harness_shared.harness_text_artifacts (harness_slug, rel_path, content, updated_at, workspace_id) VALUES ('web','owned.md','old',1,'other-ws')`;
    await saveTextArtifact('web', 'owned.md', 'new');
    expect(await wsOf('web', 'owned.md')).toBe('other-ws'); // NOT re-homed to WS
  });
});

describe('preparation ledger with canonical PG artifacts and real fixture descriptors', () => {
  let root: string;
  const digest = (text: string) => createHash('sha256').update(text).digest('hex');
  const options = { attemptId: 'fixture-attempt', candidate: 'fixture-candidate', clockId: 'fixture-boot', baseline: ['known.ts'] };
  const store = () => createArtifactPreparationStore({ slug: 'web', relPath: 'method/fixture-ledger.json',
    loadTextArtifact, compareAndSwapTextArtifact });
  const manifest = (text = 'abc') => ({ candidate: options.candidate, inputs: { 'known.ts': digest(text) } });
  beforeEach(async () => {
    root = await actualFs.realpath(await actualFs.mkdtemp(join(tmpdir(), 'preparation-fixture-')));
    await actualFs.writeFile(join(root, 'known.ts'), 'abc');
  });
  afterEach(async () => { await actualFs.rm(root, { recursive: true, force: true }); });
  it('restarts from PG and debits actual repeated file reads across adapter instances', async () => {
    const config = { ...options, maxBytes: 6 };
    const first = await openBoundPreparationLedger(config, { store: store(), root, manifest: manifest() });
    expect((await first.read('known.ts')).data.toString()).toBe('abc');
    const resumed = await openBoundPreparationLedger(config, { store: store(), root, manifest: manifest() });
    await resumed.read('known.ts');
    await expect(resumed.read('known.ts')).rejects.toThrow('byte-limit');
    const stopped = await openBoundPreparationLedger(config, { store: store(), root, manifest: manifest() });
    expect(stopped.report()).toMatchObject({ status: 'STOPPED', bytesRead: 6, executionAdmitted: false });
    await expect(stopped.read('known.ts')).rejects.toThrow('byte-limit');
  });
  it('blocks stale real-store openers before filesystem access', async () => {
    const first = await openBoundPreparationLedger(options, { store: store(), root, manifest: manifest() });
    const stale = await openBoundPreparationLedger(options, { store: store(), root, manifest: manifest() });
    await first.read('known.ts');
    await actualFs.rm(root, { recursive: true });
    await expect(stale.read('known.ts')).rejects.toThrow('attempt-state-conflict');
  });
  it('persists input61 refusal and never reaches a removed fixture root, even after restart', async () => {
    const config = { ...options, priorAdditions: Array.from({ length: 60 }, (_, i) => `prefix/${i}`) };
    const first = await openBoundPreparationLedger(config, { store: store(), root, manifest: manifest() });
    await actualFs.rm(root, { recursive: true });
    await expect(first.read('input61.ts')).rejects.toThrow('input-limit');
    const resumed = await openBoundPreparationLedger(config, { store: store(), root, manifest: manifest() });
    await expect(resumed.read('known.ts')).rejects.toThrow('input-limit');
    expect(resumed.snapshot().bytesRead).toBe(0);
  });
  it('rejects candidate, root and input-manifest changes instead of resetting a persisted attempt', async () => {
    await openBoundPreparationLedger(options, { store: store(), root, manifest: manifest() });
    await expect(openBoundPreparationLedger(options, { store: store(), root, manifest: { ...manifest(), candidate: 'other' } })).rejects.toThrow('candidate-source-binding');
    await expect(openBoundPreparationLedger(options, { store: store(), root: root + '-other', manifest: manifest() })).rejects.toThrow('snapshot/configuration');
    await expect(openBoundPreparationLedger(options, { store: store(), root, manifest: manifest('xyz') })).rejects.toThrow('snapshot/configuration');
    await expect(openBoundPreparationLedger({ ...options, attemptId: 'fresh-counter' }, { store: store(), root, manifest: manifest() })).rejects.toThrow('attempt-artifact-binding');
  });
  it('refuses missing input pins and records a terminal stop before reading the file', async () => {
    const ledger = await openBoundPreparationLedger(options, { store: store(), root, manifest: { ...manifest(), inputs: {} } });
    await expect(ledger.read('known.ts')).rejects.toThrow('candidate-input-unbound');
    expect(ledger.snapshot().bytesRead).toBe(0);
    expect((await store().load(options.attemptId))?.snapshot.status).toBe('STOPPED');
  });
  it('refuses a symlink alias to bytes with the correct digest before any payload read', async () => {
    await actualFs.symlink('known.ts', join(root, 'alias.ts'));
    const ledger = await openBoundPreparationLedger(options, { store: store(), root,
      manifest: { ...manifest(), inputs: { 'alias.ts': digest('abc') } } });
    await expect(ledger.read('alias.ts')).rejects.toThrow('input-path-alias');
    expect(ledger.snapshot().bytesRead).toBe(0);
  });
  it('charges real bytes and retains terminal failure when candidate content drifts', async () => {
    const ledger = await openBoundPreparationLedger(options, { store: store(), root, manifest: manifest() });
    await actualFs.writeFile(join(root, 'known.ts'), 'xyz');
    await expect(ledger.read('known.ts')).rejects.toThrow('input-digest-drift');
    expect(ledger.snapshot()).toMatchObject({ bytesRead: 3, status: 'STOPPED' });
  });
});
