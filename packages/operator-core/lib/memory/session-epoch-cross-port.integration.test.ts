/**
 * orient-recall-quality-2026-07-12 P-004(a) — cross-port warm-session dedup
 * against REAL Postgres (the runtime half of the session-identity contract;
 * the source-text pins live in session-identity-contract.test.ts).
 *
 * Drives the ONE admission pipeline (buildMemoryContextBlock) twice for the
 * same sessionId on DIFFERENT ports and asserts the second delivery is
 * suppressed by the session-epoch ledger (memory_session_surfaced) — the
 * "orient-then-claim never double-injects" D-006 property, end-to-end through
 * the real table + the real UUID/epoch filters, not a mocked ledger. Also pins
 * the epoch-bump reset: after bumpSessionEpoch, the SAME memories deliver again
 * (the post-compaction re-prime property).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OrgTestDb } from '../../test/_org-test-db';
import type { MemoryEntry } from './backend';
import { sessionAllowsAmbientContext, setSessionConfinementResolver } from '../capability-envelope/session-confinement-port';
import { ledgerDir, openDeliveryLedger } from '../../../../apps/operator/scripts/hooks/inject/delivery-ledger.mjs';
import { DELIVERY_MATRIX_FAULTS, deliveryMatrixCellKey, deliveryMatrixPopulation, deliveryTerminalOracle,
  validateDeliveryMatrix, type DeliveryMatrixCell } from './injection-delivery-coverage';

const h = vi.hoisted(() => ({ sql: null as unknown, entries: [] as MemoryEntry[] }));

// Real PG via the org-fixture; only getOrgPg is stubbed to point at it.
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: h.sql }),
}));
vi.mock('./backend', () => ({
  getMemoryBackend: () => ({
    available: async () => ({ ok: true }),
    search: async () => h.entries,
  }),
}));
// This suite owns the memory/receipt ledgers, not external corpus retrieval.
// Keep that unrelated leg empty and healthy; otherwise its five-second wall
// emits a degradation notice even when the tested memory dedup is correct.
vi.mock('./corpus-recall-io', () => ({
  recallCorpusContext: async () => ({ heading: 'Related context', outcome: 'ok', lines: [], dropped: [],
    embedderAvailable: true, candidateCount: 0, retrievalDepth: 0, rerank: 'nothing-to-reorder', legs: null }),
}));
// The workspace-scope read is flag-server-backed (not best-effort-wrapped);
// pin it OFF so the test exercises the dedup path, not flag plumbing.
vi.mock('./workspace-scope-recall', () => ({
  isMemoryWorkspaceScopedRecallOn: async () => false,
  keepUserPoolHitForWorkspace: () => true,
}));

const { buildMemoryContextBlock, prepareMemoryContextBlock } = await import('./injection');
const { bumpSessionEpoch, memoryFragmentOffer, stageMemoryEmission, confirmMemoryEmission } = await import('./session-epoch-ledger');
const { resetReadCursorStore } = await import('../agent-tools/coordination/read-cursors');
const { createOrgTestDb } = await import('../../test/_org-test-db');

const SID = `sid-cross-port-${Date.now()}`;

/**
 * The stamp is fire-and-forget — poll the real table until it lands.
 *
 * WI-5255 (de-quarantine, flipRate 0.375): the original 40*50ms=2s budget was
 * far too tight against the SHARED dev PG under fleet load — the quarantine
 * history shows this class of failure is consistently a hook/poll-timeout
 * racing concurrent writes from other agents, never a wrong assertion (see
 * WI-5189's note on the sibling flake). The test-level budget here is the
 * 90s integration testTimeout (vitest-config.ts); poll for up to 20s (200 *
 * 100ms), leaving ample headroom under that ceiling instead of a tight 2s
 * window that a load spike blows through routinely.
 */
async function waitForStamps(sql: (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown>, n: number): Promise<void> {
  const maxAttempts = 200;
  const intervalMs = 100;
  for (let i = 0; i < maxAttempts; i++) {
    const rows = (await (sql as never as (
      s: TemplateStringsArray, ...v: unknown[]
    ) => Promise<Array<{ n: number }>>)`
      SELECT count(*)::int AS n FROM harness_shared.memory_session_surfaced
      WHERE session_id = ${SID}
    `) as Array<{ n: number }>;
    if ((rows[0]?.n ?? 0) >= n) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`stamps for ${SID} never reached ${n} after ${(maxAttempts * intervalMs) / 1000}s`);
}

describe('cross-port session-epoch dedup (real PG — P-004a)', () => {
  let db: OrgTestDb;
  let dispatcherRoot: string;
  const joinedCells = new Map<string, DeliveryMatrixCell>();

  beforeAll(async () => {
    setSessionConfinementResolver(() => null);
    db = await createOrgTestDb();
    h.sql = db.adminSql;
    // Execute current hook bytes outside the repository child loader's HEAD
    // substitution boundary, retaining the canonical source capture in CI.
    dispatcherRoot = mkdtempSync(join(tmpdir(), 'receipt-pg-dispatcher-'));
    const hooks = fileURLToPath(new URL('../../../../apps/operator/scripts/hooks/inject/', import.meta.url));
    for (const rel of ['', 'adapters']) {
      mkdirSync(join(dispatcherRoot, rel), { recursive: true });
      for (const name of readdirSync(join(hooks, rel))) if (name.endsWith('.mjs'))
        copyFileSync(join(hooks, rel, name), join(dispatcherRoot, rel, name));
    }
    // Exercise production JSONB staging and ACK promotion as well as the
    // surfaced-table uniqueness constraint; an in-memory cursor masks both.
    resetReadCursorStore();
    h.entries = [
      { id: randomUUID(), text: 'always pass argShape Z to the fixture step', scope: 'u-test', score: 0.9 },
      { id: randomUUID(), text: 'the promotion pipeline FFs main from staging', scope: 'u-test', score: 0.8 },
    ];
  }, 120_000);

  afterAll(async () => {
    setSessionConfinementResolver(undefined);
    resetReadCursorStore();
    if (dispatcherRoot) rmSync(dispatcherRoot, { recursive: true, force: true });
    await db?.cleanup();
  });

  // Join actual OS output, immutable native receipts, their next-request echo,
  // and production PostgreSQL cursors/surfaced rows in ONE observation. The
  // HTTP responder supplies fixture sources; it is not a production route or
  // proof that an installed client consumed the hook's stdout (notably OMP).
  for (const client of ['codex', 'claude', 'omp'] as const)
    for (const sink of ['turn-start', 'mid-turn'] as const)
      for (const source of ['memory', 'corpus'] as const)
        for (const fault of DELIVERY_MATRIX_FAULTS)
          it(`context reliability R-1: joined ${client} ${sink} ${source} ${fault}`, async ({ task }) => {
            const owner = `joined-${randomUUID()}`;
            const home = mkdtempSync(join(tmpdir(), 'receipt-pg-home-'));
            const id = source === 'memory' ? randomUUID() : `WI-${randomUUID()}`;
            const rendered = '- Full approval condition ☃' + (fault === 'partial-stdout' ? 'x'.repeat(512 * 1024) : '');
            const offer = memoryFragmentOffer(source, id, 0, sink, rendered);
            const { rendered: _text, ...fragment } = offer;
            const token = `receipt-${randomUUID()}`;
            const requests: Array<{ port: string; confirmations: unknown[]; inserted: number }> = [];
            const errors: unknown[] = [];
            const surfaced = () => source === 'memory'
              ? db.adminSql<{ port: string }[]>`SELECT port FROM harness_shared.memory_session_surfaced WHERE session_id = ${owner}`
              : db.adminSql<{ port: string }[]>`SELECT port FROM harness_shared.corpus_session_surfaced WHERE session_id = ${owner}`;
            const server = createServer((req, res) => {
              void (async () => {
                const chunks: Buffer[] = [];
                for await (const chunk of req) chunks.push(Buffer.from(chunk));
                const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
                expect(body.owner).toBe(owner);
                const port = req.url?.includes('mid-turn') ? 'mid-turn' : 'turn-start';
                const confirmations = body.confirmedMemoryDeliveries ?? [];
                let inserted = 0;
                for (const proof of confirmations) inserted += await confirmMemoryEmission(db.adminSql as never, owner, proof);
                requests.push({ port, confirmations, inserted });
                if ((await surfaced()).length) { res.end(JSON.stringify({ text: null })); return; }
                const portOffer = { ...offer, port };
                const portToken = port === sink ? token : `${token}-other`;
                await stageMemoryEmission(db.adminSql as never, owner, portToken, [portOffer]);
                if (fault === 'lost-response') { req.socket.destroy(); return; }
                if (fault === 'deadline') return; // real dispatcher wall aborts this socket
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ text: rendered, deliveryToken: portToken, memoryFragmentOffers: [portOffer] }));
              })().catch(error => { errors.push(String(error)); res.destroy(); });
            });
            await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
            const address = server.address();
            if (!address || typeof address === 'string') throw new Error('Missing receipt fixture address');
            const base = `http://127.0.0.1:${address.port}`;
            const env = { ...process.env, PAPERCUSP_SID: owner, PAPERCUSP_HOME: home, PAPERCUSP_OPERATOR_URL: base };
            const run = async (port = sink, output: 'complete' | 'closed' | 'partial' = 'complete') => {
              const event = port === 'turn-start' ? { prompt: 'receipt delivery' }
                : client === 'codex' ? { tool_name: 'Grep', tool_input: { pattern: 'receipt' }, tool_response: '' }
                : client === 'claude' ? { tool_calls: [{ tool_name: 'Grep', tool_input: { pattern: 'receipt' }, tool_response: '' }] }
                : { message: { content: [{ type: 'toolCall', id: 'call-1', name: 'Grep', arguments: { pattern: 'receipt' } }] },
                  toolResults: [{ toolCallId: 'call-1', toolName: 'Grep', content: [{ type: 'text', text: '' }] }] };
              const nativeEvent = port === 'turn-start' ? (client === 'omp' ? 'before_agent_start' : 'UserPromptSubmit')
                : client === 'codex' ? 'PostToolUse' : client === 'claude' ? 'PostToolBatch' : 'turn_end';
              const child = spawn(process.execPath, [join(dispatcherRoot, 'index.mjs'), `--client=${client}`, `--event=${nativeEvent}`],
                { env, stdio: ['pipe', 'pipe', 'pipe'] });
              const stdout: Buffer[] = [], stderr: Buffer[] = [];
              let partialBytes = 0;
              if (output === 'closed') child.stdout.destroy();
              else child.stdout.on('data', (chunk: Buffer) => {
                if (output === 'partial') { partialBytes += chunk.length; child.stdout.destroy(); }
                else stdout.push(chunk);
              });
              child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
              const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
              try {
                const terminal = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
                  child.once('error', reject);
                  child.once('close', (code, signal) => resolve({ code, signal }));
                });
                child.stdin.end(JSON.stringify(event));
                return { ...await terminal, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString(), partialBytes };
              } finally { clearTimeout(timer); }
            };
            const proofFor = (port = sink) => openDeliveryLedger(owner, env, port)?.confirmedMemoryDeliveries() ?? [];
            const attempt = { id: owner, recipient: owner, workspace: 'isolated-org-fixture', epoch: 0, token, fragment };
            const cell: DeliveryMatrixCell = { client, sink, source, fault, attempt,
              selector: task.name, evidenceRefs: [`vitest:${task.name}`], terminalOracle: 'complete-stdout',
              state: 'prepared', verdict: 'UNKNOWN', suppressionWrites: 0 };
            Object.assign(task.meta, { receiptBackendRequests: requests, receiptBackendErrors: errors });
            try {
              if (fault === 'prepare' || fault === 'abandon-expiry') {
                const response = await fetch(`${base}/api/agent-mcp/${sink === 'mid-turn' ? 'mid-turn-context' : 'turn-start-memory'}`,
                  { method: 'POST', body: JSON.stringify({ owner, confirmedMemoryDeliveries: [] }) });
                expect((await response.json()).memoryFragmentOffers).toEqual([offer]);
                if (fault === 'abandon-expiry') {
                  await db.adminSql`UPDATE harness_shared.coord_read_cursors
                    SET pending = jsonb_set(pending, '{expiresAt}', '1'::jsonb)
                    WHERE owner_id = ${owner} AND surface = ${'memory-emission:' + token}`;
                  expect(await confirmMemoryEmission(db.adminSql as never, owner, { token, fragments: [fragment] })).toBe(0);
                  expect(await db.adminSql`SELECT surface FROM harness_shared.coord_read_cursors
                    WHERE owner_id = ${owner} AND surface = ${'memory-emission:' + token}`).toHaveLength(0);
                  cell.state = 'abandoned';
                }
              } else if (fault === 'lost-response' || fault === 'deadline' || fault === 'partial-stdout') {
                const result = await run(sink, fault === 'partial-stdout' ? 'partial' : 'complete');
                Object.assign(task.meta, { negativeNativeOutput: result });
                expect(result.signal, result.stderr).toBeNull();
                expect(result.code, result.stderr).toBe(0);
                // A transport failure may emit a diagnostic context block;
                // it must never emit or confirm the offered memory fragment.
                expect(result.stdout).not.toContain(rendered);
                if (fault === 'partial-stdout') {
                  expect(result.partialBytes).toBeGreaterThan(0);
                  expect(result.partialBytes).toBeLessThan(fragment.bodyBytes);
                  cell.state = 'partial';
                }
                Object.assign(task.meta, { partialBytes: result.partialBytes });
              } else {
                if (fault === 'retry') {
                  await run(sink, 'closed');
                  expect(proofFor()).toEqual([]);
                  expect(await surfaced()).toHaveLength(0);
                }
                const outputs = fault === 'overlapping-ports'
                  ? await Promise.all([run(), run(sink === 'mid-turn' ? 'turn-start' : 'mid-turn')]) : [await run()];
                for (const result of outputs) {
                  expect(result.signal, result.stderr).toBeNull();
                  expect(result.code, result.stderr).toBe(0);
                  expect(result.stdout).toContain(rendered);
                }
                expect(await surfaced()).toHaveLength(0); // stdout alone has not ACKed PostgreSQL
                const proof = [{ token, fragments: [fragment] }];
                const expectedProofs = fault === 'overlapping-ports' ? [...proof,
                  { token: `${token}-other`, fragments: [{ ...fragment, port: sink === 'mid-turn' ? 'turn-start' : 'mid-turn' }] }] : proof;
                const actualProofs = proofFor();
                Object.assign(task.meta, { nativeConfirmations: actualProofs });
                // The production writer intentionally returns receipts from
                // every native port, ordered by completion time, so neither
                // overlap may erase the other's confirmation.
                expect(actualProofs).toHaveLength(expectedProofs.length);
                expect(actualProofs).toEqual(expect.arrayContaining(expectedProofs));
                const namespace = sink === 'turn-start' ? owner : `${owner}.${sink}`;
                const receiptPath = join(ledgerDir(env), `${namespace}.emissions`,
                  `${createHash('sha256').update(token).digest('hex')}.json`);
                const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
                const payloadSha256 = createHash('sha256').update(outputs[0]!.stdout).digest('hex');
                expect(receipt).toMatchObject({ stage: 'stdout-emitted', owner, token, client,
                  payloadSha256, payloadBytes: Buffer.byteLength(outputs[0]!.stdout), memoryFragments: [fragment] });
                if (fault === 'duplicate-commit') {
                  const results = await Promise.all(Array.from({ length: 8 }, () =>
                    confirmMemoryEmission(db.adminSql as never, owner, proof[0]!)));
                  expect(results.reduce((sum, count) => sum + count, 0)).toBe(1);
                }
                // A subsequent actual dispatcher request echoes the stored proof.
                await run();
                expect(requests.some(request => request.confirmations.some(row =>
                  JSON.stringify(row) === JSON.stringify(proof[0])))).toBe(true);
                if (fault === 'overlapping-ports') await run(sink === 'mid-turn' ? 'turn-start' : 'mid-turn');
                expect(await surfaced()).toHaveLength(1);
                expect(await confirmMemoryEmission(db.adminSql as never, owner, proof[0]!)).toBe(0);
                cell.state = 'emitted'; cell.suppressionWrites = 1;
                cell.proof = { event: 'complete-stdout', adapter: 'hook-dispatcher', receiptRef: `vitest:${task.name}#immutableReceipt`,
                  attemptId: owner, recipient: owner, workspace: attempt.workspace, epoch: 0, token, client, sink,
                  payloadSha256, payloadBytes: receipt.payloadBytes, fragment };
                Object.assign(task.meta, { immutableReceipt: receipt, stdoutSha256: payloadSha256 });
              }
              if (cell.state !== 'emitted') {
                expect(proofFor()).toEqual([]);
                expect(await surfaced()).toHaveLength(0);
                if (fault !== 'abandon-expiry') {
                  const candidates = await db.adminSql<{ fragments: unknown[] }[]>`
                    SELECT pending -> 'fragments' AS fragments FROM harness_shared.coord_read_cursors
                    WHERE owner_id = ${owner} AND surface = ${'memory-emission:' + token}`;
                  expect(candidates).toEqual([{ fragments: [fragment] }]);
                }
              }
              expect(requests.length).toBeGreaterThan(0);
              expect(errors).toEqual([]);
              cell.verdict = 'passed';
              joinedCells.set(deliveryMatrixCellKey(cell), cell);
              Object.assign(task.meta, { deliveryMatrixCell: cell, receiptBackendObservation: {
                cursorStore: 'postgresql', surfacedStore: 'postgresql', requests,
                evidencePlane: 'dispatcher subprocess + production PostgreSQL receipt backend',
                productionRoute: 'UNKNOWN', installedClientConsumption: 'UNKNOWN',
                ompBoundary: 'dispatcher stdout only; native extension tool_result remains pre-host-final' } });
            } finally {
              server.closeAllConnections();
              await new Promise<void>(resolve => server.close(() => resolve()));
              rmSync(home, { recursive: true, force: true });
            }
          }, 45_000);

  it('context reliability R-1: joined cell census retains the complete denominator', ({ task }) => {
    const cells = deliveryMatrixPopulation().map(coordinate => joinedCells.get(deliveryMatrixCellKey(coordinate)) ?? {
      ...coordinate, selector: 'not exercised by PostgreSQL dispatcher join',
      evidenceRefs: ['session-epoch-cross-port.integration.test.ts: bounded join census'],
      terminalOracle: deliveryTerminalOracle(coordinate), state: 'UNKNOWN' as const,
      verdict: 'UNKNOWN' as const, suppressionWrites: 0,
    });
    expect(joinedCells.size).toBe(96);
    expect(cells).toHaveLength(432);
    // Structural fixture identity only. Acceptance binds the separately read
    // plan/rubric/spec/runtime identities and independent evidence later.
    const manifest = { schemaVersion: 'delivery-matrix-v1' as const,
      identity: { planRevision: 1, rubricRevision: 1, planHash: '1'.repeat(64), rubricHash: '2'.repeat(64),
        barHash: '3'.repeat(64), specHash: '4'.repeat(64), sourceHash: '5'.repeat(64), testHash: '6'.repeat(64),
        runtimeGeneration: 'isolated-postgresql-dispatcher-fixture' }, cells };
    const result = validateDeliveryMatrix(manifest);
    expect(result).toMatchObject({ closed: true, valid: true, acceptanceReady: false, errors: [] });
    expect(result.unknown).toHaveLength(336);
    Object.assign(task.meta, { deliveryMatrixCensus: { manifest, result,
      identityKind: 'structural fixture only; independent acceptance and shipment not asserted' } });
  });

  it('lost preparation stays eligible; proven final emission suppresses another port; a new epoch re-primes', async () => {
    // A unit/integration worker does not boot the host's authoritative policy
    // reader. Assert that fixture prerequisite before interpreting no recall.
    expect(await sessionAllowsAmbientContext({ ownerId: SID, workspaceId: 'ws-test' })).toBe(true);
    // Initialize has no native stdout oracle: preparing its response cannot
    // suppress a later native hook, even when the response is lost.
    const first = await buildMemoryContextBlock({
      userId: 'u-test',
      workspaceId: 'ws-test',
      queryContext: 'fixture conventions',
      session: { sessionId: SID, port: 'initialize' },
    });
    expect(first).toBeTruthy();
    expect(first).toContain('argShape Z');
    expect(await db.adminSql`SELECT memory_id FROM harness_shared.memory_session_surfaced WHERE session_id = ${SID}`).toHaveLength(0);

    // A DIFFERENT port, same session + epoch: fully suppressed (null, not a
    // thinner block) — the D-006 "orient-then-claim never double-injects" pin.
    const second = await prepareMemoryContextBlock({
      userId: 'u-test',
      workspaceId: 'ws-test',
      queryContext: 'fixture conventions',
      session: { sessionId: SID, port: 'turn-start' },
    });
    expect(second?.text).toContain('argShape Z');
    expect(second?.fragments).toHaveLength(2);
    await stageMemoryEmission(db.adminSql as never, SID, 'cross-port-proof', second!.fragments);
    expect(await db.adminSql`SELECT memory_id FROM harness_shared.memory_session_surfaced WHERE session_id = ${SID}`).toHaveLength(0);
    const fragments = second!.fragments.map(({ rendered: _text, ...row }) => row);
    expect(await confirmMemoryEmission(db.adminSql as never, SID, { token: 'cross-port-proof', fragments })).toBe(2);
    await waitForStamps(db.adminSql as never, 2);
    expect(await buildMemoryContextBlock({ userId: 'u-test', workspaceId: 'ws-test',
      queryContext: 'fixture conventions', session: { sessionId: SID, port: 'mid-turn' } })).toBeNull();

    // Compaction boundary: the epoch bump makes the WHOLE pool eligible again.
    await bumpSessionEpoch(db.adminSql as never, SID);
    const reprimed = await buildMemoryContextBlock({
      userId: 'u-test',
      workspaceId: 'ws-test',
      queryContext: 'fixture conventions',
      session: { sessionId: SID, port: 'compact' },
    });
    expect(reprimed).toBeTruthy();
    expect(reprimed).toContain('argShape Z');
    // Observe every eligible port's telemetry before closing its SQL handle.
    // The writer is asynchronous: ledger uniqueness alone says nothing about a
    // missing recall row, and early teardown can manufacture CONNECTION_ENDED.
    const expectedSurfaces = ['initialize', 'turn-start', 'mid-turn', 'compact'];
    let observedSurfaces: string[] = [];
    for (let i = 0; i < 200; i++) {
      const rows = await db.adminSql<{ surface: string }[]>`
        SELECT DISTINCT surface FROM harness_shared.memory_recall_stats
        WHERE session_id = ${SID}
      `;
      observedSurfaces = rows.map((row) => row.surface);
      if (expectedSurfaces.every((surface) => observedSurfaces.includes(surface))) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(observedSurfaces).toEqual(expect.arrayContaining(expectedSurfaces));
    // Compaction preparation also cannot stamp the newly eligible epoch.
    expect(await db.adminSql`SELECT memory_id FROM harness_shared.memory_session_surfaced WHERE session_id = ${SID}`).toHaveLength(2);
  });

  for (const kind of ['memory', 'corpus'] as const) {
    it(`retains a PostgreSQL ${kind} candidate after invalid proof and commits concurrent retries once`, async ({ task }) => {
      const sid = `${SID}-${kind}-same-token`;
      const token = `same-token-${kind}`;
      const id = kind === 'memory' ? randomUUID() : 'WI-same-token';
      const offer = memoryFragmentOffer(kind, id, 4, 'mid-turn', '- complete receipt body with approval ☃');
      const { rendered: _text, ...fragment } = offer;
      await stageMemoryEmission(db.adminSql as never, sid, token, [offer]);
      expect(await confirmMemoryEmission(db.adminSql as never, `${sid}-foreign`, { token, fragments: [fragment] })).toBe(0);
      expect(await confirmMemoryEmission(db.adminSql as never, sid, {
        token, fragments: [{ ...fragment, bodyBytes: fragment.bodyBytes - 1 }],
      })).toBe(0);
      const readStamps = () => kind === 'memory'
        ? db.adminSql`SELECT port FROM harness_shared.memory_session_surfaced WHERE session_id = ${sid}`
        : db.adminSql`SELECT port FROM harness_shared.corpus_session_surfaced WHERE session_id = ${sid}`;
      expect(await readStamps()).toHaveLength(0);
      const retained = await db.adminSql<{ committed: { fragments: unknown[] }; pending: unknown }[]>`
        SELECT committed, pending FROM harness_shared.coord_read_cursors
         WHERE owner_id = ${sid} AND surface = ${'memory-emission:' + token}
      `;
      expect(retained).toHaveLength(1);
      expect(retained[0]!.committed.fragments).toEqual([fragment]);
      expect(retained[0]!.pending).toBeNull();
      const results = await Promise.all(Array.from({ length: 8 }, () =>
        confirmMemoryEmission(db.adminSql as never, sid, { token, fragments: [fragment] })));
      expect(results.reduce((sum, inserted) => sum + inserted, 0)).toBe(1);
      expect(await readStamps()).toEqual([expect.objectContaining({ port: 'mid-turn' })]);
      expect(await confirmMemoryEmission(db.adminSql as never, sid, { token, fragments: [fragment] })).toBe(0);
      Object.assign(task.meta, { receiptBackendObservation: { source: kind, cursorStore: 'postgresql',
        surfacedStore: 'postgresql', concurrentAcknowledgements: results.length, inserted: 1,
        invalidProofWrites: 0, nativeDelivery: 'UNKNOWN',
        scope: 'production cursor and surfaced ledgers; supplied receipt fixture, no native output claim' } });
    });
  }

  it.each(['memory', 'corpus'] as const)('atomically commits a competing %s fragment once across two proven ports', async kind => {
    const sid = `${SID}-${kind}-race`;
    const id = kind === 'memory' ? randomUUID() : 'WI-race';
    const a = memoryFragmentOffer(kind, id, 3, 'turn-start', '- exact complete body');
    const b = memoryFragmentOffer(kind, id, 3, 'mid-turn', '- exact complete body');
    await stageMemoryEmission(db.adminSql as never, sid, `race-${kind}-a`, [a]);
    await stageMemoryEmission(db.adminSql as never, sid, `race-${kind}-b`, [b]);
    const staged = await db.adminSql<{ shape: string; token: string; fragments: unknown[] }[]>`
      SELECT jsonb_typeof(pending) AS shape, pending ->> '__deliveryToken' AS token,
             pending -> 'fragments' AS fragments
        FROM harness_shared.coord_read_cursors
       WHERE owner_id = ${sid} AND surface LIKE 'memory-emission:%'
    `;
    expect(staged).toHaveLength(2);
    for (const row of staged) {
      expect(row.shape).toBe('object');
      expect(row.token).toMatch(new RegExp(`^race-${kind}-[ab]$`));
      expect(row.fragments).toHaveLength(1);
    }
    const manifest = ({ rendered: _text, ...row }: typeof a) => row;
    const committed = await Promise.all([
      confirmMemoryEmission(db.adminSql as never, sid, { token: `race-${kind}-a`, fragments: [manifest(a)] }),
      confirmMemoryEmission(db.adminSql as never, sid, { token: `race-${kind}-b`, fragments: [manifest(b)] }),
    ]);
    expect(committed.sort()).toEqual([0, 1]);
    const rows = kind === 'memory'
      ? await db.adminSql`SELECT port FROM harness_shared.memory_session_surfaced WHERE session_id = ${sid}`
      : await db.adminSql`SELECT port FROM harness_shared.corpus_session_surfaced WHERE session_id = ${sid}`;
    expect(rows).toHaveLength(1);
    const original = rows[0].port;
    expect(await confirmMemoryEmission(db.adminSql as never, sid, { token: `race-${kind}-b`, fragments: [manifest(b)] })).toBe(0);
    const after = kind === 'memory'
      ? await db.adminSql`SELECT port FROM harness_shared.memory_session_surfaced WHERE session_id = ${sid}`
      : await db.adminSql`SELECT port FROM harness_shared.corpus_session_surfaced WHERE session_id = ${sid}`;
    expect(after[0].port).toBe(original);
  });
});
