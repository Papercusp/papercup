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
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { OrgTestDb } from '../../test/_org-test-db';
import type { MemoryEntry } from './backend';
import { sessionAllowsAmbientContext, setSessionConfinementResolver } from '../capability-envelope/session-confinement-port';
import { ledgerDir, openDeliveryLedger } from '../../../../apps/operator/scripts/hooks/inject/delivery-ledger.mjs';
import { nativeProcessTraceEnv } from '../../../../scripts/lib/native-process-trace-env.mjs';
import { DELIVERY_MATRIX_FAULTS, deliveryMatrixCellKey, deliveryMatrixPopulation, deliveryTerminalOracle,
  validateDeliveryMatrix, type DeliveryMatrixCell } from './injection-delivery-coverage';

const h = vi.hoisted(() => ({ sql: null as unknown, entries: [] as MemoryEntry[],
  compactPadding: '',
  corpus: null as Awaited<ReturnType<typeof import('./corpus-recall-io').recallCorpusContext>> | null }));

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
  recallCorpusContext: async () => h.corpus ?? ({ heading: 'Related context', outcome: 'ok', lines: [], dropped: [],
    embedderAvailable: true, candidateCount: 0, retrievalDepth: 0, rerank: 'nothing-to-reorder', legs: null }),
}));
// The workspace-scope read is flag-server-backed (not best-effort-wrapped);
// pin it OFF so the test exercises the dedup path, not flag plumbing.
vi.mock('./workspace-scope-recall', () => ({
  isMemoryWorkspaceScopedRecallOn: async () => false,
  keepUserPoolHitForWorkspace: () => true,
}));
// Deterministic carry/retrieval inputs; the recovery endpoint, compact epoch
// transition, launch renderer, generated native hook and PG stores stay real.
vi.mock('../carry-brief', () => ({
  buildCarryBrief: async () => ({ heldItems: [{ id: 'WI-compact', title: 'zephyrrepair approval', harness: 'papercusp' }],
    fleet: null, awaits: [], facts: [] }),
  renderCarryBriefText: () => 'Carry brief\n' + h.compactPadding,
}));
vi.mock('../auth', async original => ({ ...await original<typeof import('../auth')>(),
  getSessionUserOrDefault: async () => ({ id: 'u-test' }),
}));
vi.mock('./compact-reprime', async original => {
  const actual = await original<typeof import('./compact-reprime')>();
  return { ...actual, buildCompactReprimeBlock: (input: Parameters<typeof actual.buildCompactReprimeBlock>[0]) =>
    actual.buildCompactReprimeBlock(input, { retireFlagFn: async () => false }) };
});

const { buildMemoryContextBlock, prepareMemoryContextBlock } = await import('./injection');
const { bumpSessionEpoch, memoryFragmentOffer, stageMemoryEmission, confirmMemoryEmission,
  withMemoryEmissionReceipt } = await import('./session-epoch-ledger');
const { buildLaunchMemoryBlock, resolveLaunchProfile } = await import('./launch-profile');
const { selectCorpusLines, renderCorpusBlock } = await import('./corpus-recall');
const { captureNativeMcp } = await import('./fixtures/native-mcp-export');
const { resetReadCursorStore } = await import('../agent-tools/coordination/read-cursors');
const { createOrgTestDb } = await import('../../test/_org-test-db');
const { RECOVER_HOOK_SOURCE, RECOVER_HOOK, RECOVER_INTENT } = await import('../interactive-claude-config');
const { default: recoveryEndpoints } = await import('../endpoint-route/routes/agent-mcp/session-recovery-brief');

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

async function runReceiptDispatcher(root: string, client: 'codex' | 'claude' | 'omp',
  port: 'turn-start' | 'mid-turn', env: NodeJS.ProcessEnv,
  output: 'complete' | 'closed' | 'partial' = 'complete') {
  const event = port === 'turn-start' ? { prompt: 'receipt delivery' }
    : client === 'codex' ? { tool_name: 'Grep', tool_input: { pattern: 'receipt' }, tool_response: '' }
    : client === 'claude' ? { tool_calls: [{ tool_name: 'Grep', tool_input: { pattern: 'receipt' }, tool_response: '' }] }
    : { message: { content: [{ type: 'toolCall', id: 'call-1', name: 'Grep', arguments: { pattern: 'receipt' } }] },
      toolResults: [{ toolCallId: 'call-1', toolName: 'Grep', content: [{ type: 'text', text: '' }] }] };
  const nativeEvent = port === 'turn-start' ? (client === 'omp' ? 'before_agent_start' : 'UserPromptSubmit')
    : client === 'codex' ? 'PostToolUse' : client === 'claude' ? 'PostToolBatch' : 'turn_end';
  const startedAtMs = Date.now();
  // A hook is an isolated native leaf, not another Vitest worker. Inherited
  // loaders can fail or stall before the hook/backend is entered. Retain the
  // existing candidate trace only, without parent loaders or credentials.
  const childEnv = nativeProcessTraceEnv({ PATH: env.PATH, LANG: env.LANG ?? 'C.UTF-8',
    HOME: env.PAPERCUSP_HOME ?? env.HOME, PAPERCUSP_HOME: env.PAPERCUSP_HOME,
    PAPERCUSP_SID: env.PAPERCUSP_SID, PAPERCUSP_OPERATOR_URL: env.PAPERCUSP_OPERATOR_URL,
    PC_EXECUTED_SOURCE_MAP_OUT: env.PC_EXECUTED_SOURCE_MAP_OUT });
  const child = spawn(process.execPath, [join(root, 'index.mjs'), `--client=${client}`, `--event=${nativeEvent}`],
    { env: childEnv, cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  const stdout: Buffer[] = [], stderr: Buffer[] = [];
  let partialBytes = 0, spawnedAtMs: number | null = null, timedOut = false;
  child.once('spawn', () => { spawnedAtMs = Date.now(); });
  if (output === 'closed') child.stdout.destroy();
  else child.stdout.on('data', (chunk: Buffer) => {
    if (output === 'partial') { partialBytes += chunk.length; child.stdout.destroy(); }
    else stdout.push(chunk);
  });
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 15_000);
  try {
    const terminal = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    child.stdin.end(JSON.stringify(event));
    return { ...await terminal, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString(),
      partialBytes, invocation: { pid: child.pid, client, port, output, startedAtMs, spawnedAtMs,
        elapsedMs: Date.now() - startedAtMs, timedOut } };
  } finally { clearTimeout(timer); }
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

  it('context reliability joined harness: isolates dispatcher from parent Node preloads', async ({ task }) => {
    const home = mkdtempSync(join(tmpdir(), 'receipt-dispatcher-env-'));
    const preload = join(home, 'parent-only.mjs');
    const marker = join(home, 'preload-entered');
    writeFileSync(preload, `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(marker)}, 'entered');
throw new Error('DISPATCHER_PARENT_PRELOAD_MUST_NOT_REACH_CHILD');`);
    const requests: string[] = [];
    const server = createServer((req, res) => {
      requests.push(req.url ?? '');
      req.resume();
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ text: 'isolated dispatcher canary' }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing isolation fixture address');
      const env = { ...process.env, NODE_OPTIONS: `--import=${JSON.stringify(pathToFileURL(preload).href)}`,
        PAPERCUSP_SID: `joined-env-${randomUUID()}`, PAPERCUSP_HOME: home, HOME: home,
        PAPERCUSP_OPERATOR_URL: `http://127.0.0.1:${address.port}` };
      // Prove this launcher executes inherited preloads before the dispatcher.
      expect(() => execFileSync(process.execPath, ['--eval', ''], { env, timeout: 5000, stdio: 'pipe' }))
        .toThrow('DISPATCHER_PARENT_PRELOAD_MUST_NOT_REACH_CHILD');
      expect(readFileSync(marker, 'utf8')).toBe('entered');
      rmSync(marker);
      const result = await runReceiptDispatcher(dispatcherRoot, 'claude', 'turn-start', env);
      Object.assign(task.meta, { dispatcherEnvironmentControl: result });
      expect(result.signal, result.stderr).toBeNull();
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain('isolated dispatcher canary');
      expect(requests).toEqual(['/api/agent-mcp/turn-start-memory']);
      expect(readdirSync(home)).not.toContain('preload-entered');
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(home, { recursive: true, force: true });
    }
  }, 45_000);

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
            let releaseOverlap!: () => void;
            const overlapReady = new Promise<void>(resolve => { releaseOverlap = resolve; });
            let overlapPrepared = 0;
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
                if (fault === 'overlapping-ports') {
                  // Process startup is not simultaneous: a faster hook can
                  // finish before its peer reads the shared receipt ledger.
                  // Hold both responses until both preparations exist, so
                  // this case exercises overlap rather than a valid later ACK.
                  if (++overlapPrepared === 2) releaseOverlap();
                  await overlapReady;
                }
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
            const nativeAttempts: Awaited<ReturnType<typeof runReceiptDispatcher>>[] = [];
            const run = async (port = sink, output: 'complete' | 'closed' | 'partial' = 'complete') => {
              const result = await runReceiptDispatcher(dispatcherRoot, client, port, env, output);
              nativeAttempts.push(result);
              return result;
            };
            const proofFor = (port = sink) => openDeliveryLedger(owner, env, port)?.confirmedMemoryDeliveries() ?? [];
            const attempt = { id: owner, recipient: owner, workspace: 'isolated-org-fixture', epoch: 0, token, fragment };
            const cell: DeliveryMatrixCell = { client, sink, source, fault, attempt,
              selector: task.name, evidenceRefs: [`vitest:${task.name}`], terminalOracle: 'complete-stdout',
              state: 'prepared', verdict: 'UNKNOWN', suppressionWrites: 0 };
            Object.assign(task.meta, { receiptBackendRequests: requests, receiptBackendErrors: errors, nativeAttempts });
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
                if (fault === 'overlapping-ports') {
                  expect(overlapPrepared).toBe(2);
                  expect(requests).toEqual(expect.arrayContaining([
                    { port: 'turn-start', confirmations: [], inserted: 0 },
                    { port: 'mid-turn', confirmations: [], inserted: 0 },
                  ]));
                }
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

  for (const client of ['codex', 'claude'] as const)
    for (const source of ['memory', 'corpus'] as const)
      for (const port of ['initialize', 'orient', 'claim', 'create'] as const)
        for (const fault of ['duplicate-commit', 'partial-stdout', 'abandon-expiry', 'retry',
          'lost-response', 'deadline', 'overlapping-ports'] as const)
        it(`context reliability R-1: production launch ${client} ${source} ${port} ${fault === 'duplicate-commit' ? '' : fault + ' '}receipt join`, async ({ task }) => {
          const owner = `su-launch-${randomUUID()}`;
          const text = 'Apply zephyrrepair recovery.\nOnly after explicit final approval ☃.';
          const savedEntries = h.entries;
          h.entries = source === 'memory' ? [{ id: randomUUID(), text, scope: 'u-test', score: 0.95 }] : [];
          const selected = selectCorpusLines({ queryText: 'zephyrrepair', budgetChars: 3000,
            hits: [{ source: 'plan', sourceId: `launch:${owner}`, excerpt: text,
              meta: { contextUnit: text }, score: 0.95 }] });
          h.corpus = source === 'corpus' ? { ...selected, block: renderCorpusBlock(selected.lines),
            outcome: 'ok', embedderAvailable: true, candidateCount: 1, legs: null,
            retrievalDepth: 1, rerank: 'nothing-to-reorder' } : null;
          const profile = resolveLaunchProfile({ claimedItemTitles: ['zephyrrepair recovery', 'zephyrrepair approval'] });
          const input = { profile, userId: 'u-test', workspaceId: 'ws-test',
            session: { sessionId: owner, port } };
          const surfaced = () => source === 'memory'
            ? db.adminSql<{ port: string; epoch: number }[]>`SELECT port, epoch FROM harness_shared.memory_session_surfaced WHERE session_id = ${owner}`
            : db.adminSql<{ port: string; epoch: number }[]>`SELECT port, epoch FROM harness_shared.corpus_session_surfaced WHERE session_id = ${owner}`;
          let offered: { owner: string; token: string; fragments: Array<Record<string, unknown>> } | undefined;
          let rendered = '';
          let diagnosticsPath = '', failure: string | undefined;
          const echoedConfirmations: Array<{ token?: string }> = [];
          const nativeAttempts: Array<{ port: typeof port; rendered: string; diagnosticsPath: string;
            offers: NonNullable<typeof offered>[] }> = [];
          let releaseOverlap!: () => void;
          const overlapReady = new Promise<void>(resolve => { releaseOverlap = resolve; });
          let overlapPrepared = 0;
          try {
            const runNative = (partial: boolean, nativePort: typeof port = port) => {
              const attempt: typeof nativeAttempts[number] = { port: nativePort, rendered: '', diagnosticsPath: '', offers: [] };
              nativeAttempts.push(attempt);
              return captureNativeMcp(client, [{ name: 'receipt_canary', description: 'Local launch receipt observation.' }],
              text, [], { stdioReceipt: source, stdioPort: nativePort, stdioOwner: owner,
                ...(partial ? { stdioFault: 'partial-stdout' as const } : {}),
                ...(fault === 'lost-response' || fault === 'deadline' ? { stdioFault: fault } : {}),
                onDiagnostics: path => { diagnosticsPath = path; attempt.diagnosticsPath = path;
                  Object.assign(task.meta, { nativeMcpDiagnostics: path }); },
                mcpResult: async (method, result, request) => {
                  const metadata = (request.params as { _meta?: Record<string, unknown> } | undefined)?._meta;
                  const confirmations = (metadata?.['papercusp/memoryReceipt'] as { confirmations?: unknown } | undefined)?.confirmations;
                  if (Array.isArray(confirmations)) echoedConfirmations.push(...confirmations);
                  // The same production response wrapper handles preparation
                  // and any next-request receipts; no fabricated fragment offer.
                  return withMemoryEmissionReceipt(db.adminSql as never, owner, confirmations, async () => {
                    if (method !== (nativePort === 'initialize' ? 'initialize' : 'tools/call')) return result;
                    attempt.rendered = await buildLaunchMemoryBlock({ ...input, session: { sessionId: owner, port: nativePort } }) ?? '';
                    rendered = attempt.rendered;
                    expect(attempt.rendered).toContain('Only after explicit final approval ☃.');
                    expect(attempt.rendered.match(/Only after explicit final approval/g)).toHaveLength(1);
                    const { _meta: _fixtureOffer, ...base } = result;
                    // Force a multi-write native response without changing the
                    // production fragment or manufacturing a receipt for it.
                    const payload = attempt.rendered + (partial ? '\n' + 'x'.repeat(512 * 1024) + ' FINAL_CONDITION' : '');
                    return nativePort === 'initialize' ? { ...base, instructions: payload }
                      : { ...base, content: [{ type: 'text', text: JSON.stringify({ [nativePort]: payload }) }] };
                  }).then(async response => {
                    const offer = response._meta?.['papercusp/memoryEmission'] as typeof offered;
                    if (offer) {
                      offered = offer;
                      attempt.offers.push(offer);
                      // This observer runs inside the actual native request,
                      // before the fixture can write its HTTP response or the
                      // production stdio adapter can emit a single byte.
                      const { rendered: _text, ...fragment } = offer.fragments[0]!;
                      const pending = await db.adminSql<{ fragments: unknown[]; committed: unknown }[]>`
                        SELECT pending -> 'fragments' AS fragments, committed
                        FROM harness_shared.coord_read_cursors
                        WHERE owner_id = ${owner} AND surface = ${'memory-emission:' + offer.token}`;
                      expect(pending).toEqual([{ fragments: [fragment], committed: null }]);
                      expect(await surfaced()).toEqual([]);
                      if (fault === 'duplicate-commit') {
                        expect(await buildLaunchMemoryBlock({ ...input, session: { sessionId: owner, port: 'mid-turn' } }))
                          .toContain('Only after explicit final approval ☃.');
                        const prepared: DeliveryMatrixCell = { client, sink: port, source, fault: 'prepare',
                          selector: task.name, evidenceRefs: [`vitest:${task.name}#nativePreparation`],
                          terminalOracle: 'complete-stdout', state: 'prepared', verdict: 'passed', suppressionWrites: 0,
                          attempt: { id: owner, recipient: owner, workspace: 'isolated-org-fixture', epoch: 0,
                            token: offer.token, fragment: fragment as NonNullable<DeliveryMatrixCell['attempt']>['fragment'] } };
                        joinedCells.set(deliveryMatrixCellKey(prepared), prepared);
                        Object.assign(task.meta, { nativePreparation: { cell: prepared, pending,
                          boundary: 'native request prepared; HTTP and stdout response not yet written', suppressionWrites: 0 } });
                      }
                      if (fault === 'abandon-expiry') {
                        await db.adminSql`UPDATE harness_shared.coord_read_cursors
                          SET pending = jsonb_set(pending, '{expiresAt}', '1'::jsonb)
                          WHERE owner_id = ${owner} AND surface = ${'memory-emission:' + offer.token}`;
                        const expired = await db.adminSql<{ expiresAt: number }[]>`
                          SELECT (pending ->> 'expiresAt')::bigint AS "expiresAt"
                          FROM harness_shared.coord_read_cursors
                          WHERE owner_id = ${owner} AND surface = ${'memory-emission:' + offer.token}`;
                        expect(Number(expired[0]?.expiresAt)).toBe(1);
                        Object.assign(task.meta, { nativeExpiredPreparation: { token: offer.token, expired, pending } });
                      }
                      if (fault === 'overlapping-ports') {
                        // Both actual production offers must exist before
                        // either HTTP response can reach its native adapter.
                        if (++overlapPrepared === 2) releaseOverlap();
                        await overlapReady;
                      }
                    }
                    return response;
                  });
                } }).catch(error => {
                  if (!partial && fault !== 'lost-response' && fault !== 'deadline') throw error;
                  failure = String(error);
                  return null;
                });
            };
            if (fault === 'lost-response' || fault === 'deadline') {
              await runNative(false);
              const attempt = nativeAttempts[0]!;
              const diagnostics = JSON.parse(readFileSync(attempt.diagnosticsPath, 'utf8'));
              Object.assign(task.meta, { nativeTransportFault: { failure, diagnostics, attempt } });
              expect(attempt.offers.length).toBeGreaterThan(0);
              expect(diagnostics.transportFaults.length).toBe(attempt.offers.length);
              expect(diagnostics.stdoutDelivery).toEqual({ adapter: 'ptool-stdio', owner, confirmations: [] });
              expect(echoedConfirmations).toEqual([]);
              expect(await surfaced()).toEqual([]);
              for (const observation of diagnostics.transportFaults) {
                expect(observation).toMatchObject({ method: port === 'initialize' ? 'initialize' : 'tools/call',
                  fault, closedBeforeCleanup: true, writableEnded: false });
                expect(observation.elapsedMs).toBeGreaterThanOrEqual(fault === 'deadline' ? 8000 : 0);
                const offer = attempt.offers.find(row => row.token === observation.preparedToken)!;
                expect(offer?.owner).toBe(owner);
                const { rendered: fragmentText, ...fragment } = offer.fragments[0]!;
                expect(attempt.rendered).toContain(fragmentText);
                expect(fragment).toMatchObject({ kind: source, epoch: 0, port,
                  bodySha256: createHash('sha256').update(fragmentText as string).digest('hex'),
                  bodyBytes: Buffer.byteLength(fragmentText as string) });
                const pending = await db.adminSql<{ fragments: unknown[]; committed: unknown }[]>`
                  SELECT pending -> 'fragments' AS fragments, committed FROM harness_shared.coord_read_cursors
                  WHERE owner_id = ${owner} AND surface = ${'memory-emission:' + offer.token}`;
                expect(pending).toEqual([{ fragments: [fragment], committed: null }]);
              }
              expect(await buildLaunchMemoryBlock({ ...input, session: { sessionId: owner, port: 'mid-turn' } }))
                .toContain('Only after explicit final approval ☃.');
              expect(await surfaced()).toEqual([]);
              const offer = attempt.offers[0]!;
              const { rendered: _text, ...fragment } = offer.fragments[0]!;
              const cell: DeliveryMatrixCell = { client, sink: port, source, fault,
                selector: task.name, evidenceRefs: [`vitest:${task.name}#nativeTransportFault`],
                terminalOracle: 'complete-stdout', state: 'prepared', verdict: 'passed', suppressionWrites: 0,
                attempt: { id: owner, recipient: owner, workspace: 'isolated-org-fixture', epoch: 0,
                  token: offer.token, fragment: fragment as NonNullable<DeliveryMatrixCell['attempt']>['fragment'] } };
              joinedCells.set(deliveryMatrixCellKey(cell), cell);
              Object.assign(task.meta, { deliveryMatrixCell: cell });
              return;
            }
            if (fault === 'overlapping-ports') {
              const otherPort = port === 'initialize' ? 'orient' : 'initialize';
              const captures = await Promise.all([runNative(false), runNative(false, otherPort)]);
              expect(overlapPrepared).toBe(2);
              expect(nativeAttempts.map(attempt => attempt.offers.length)).toEqual([1, 1]);
              expect(new Set(nativeAttempts.map(attempt => attempt.offers[0]!.token)).size).toBe(2);
              const proofs = captures.map((capture, index) => {
                expect(capture).not.toBeNull();
                const attempt = nativeAttempts[index]!;
                const offer = attempt.offers[0]!;
                const { rendered: fragmentText, ...fragment } = offer.fragments[0]!;
                expect(attempt.rendered).toContain(fragmentText);
                expect(fragment).toMatchObject({ kind: source, epoch: 0, port: attempt.port,
                  bodySha256: createHash('sha256').update(fragmentText as string).digest('hex'),
                  bodyBytes: Buffer.byteLength(fragmentText as string) });
                const proof = { token: offer.token, fragments: [fragment] };
                expect(capture!.stdoutDelivery).toEqual({ adapter: 'ptool-stdio', owner, confirmations: [proof] });
                expect(capture!.stdoutReceipts).toHaveLength(1);
                expect(capture!.stdoutReceipts![0]).toMatchObject({ stage: 'stdout-emitted', owner,
                  token: offer.token, memoryFragments: [fragment] });
                const visible = attempt.port === 'initialize' ? attempt.rendered : JSON.stringify({ [attempt.port]: attempt.rendered });
                expect(JSON.stringify(capture!.request)).toContain(JSON.stringify(visible).slice(1, -1));
                return proof;
              });
              // Automatic next-request confirmations may race; explicit
              // replay of both saved exact receipts must stay idempotent.
              await Promise.all(proofs.map(proof => withMemoryEmissionReceipt(db.adminSql as never, owner, [proof],
                async () => ({ content: [] }))));
              const surfacedRows = await surfaced();
              expect(surfacedRows).toHaveLength(1);
              expect([port, otherPort]).toContain(surfacedRows[0]!.port);
              for (const proof of proofs) expect(await confirmMemoryEmission(db.adminSql as never, owner, proof as never)).toBe(0);
              expect(await buildLaunchMemoryBlock({ ...input, session: { sessionId: owner, port: 'mid-turn' } })).toBeNull();
              const proof = proofs[0]!;
              const receipt = captures[0]!.stdoutReceipts![0]!;
              const fragment = proof.fragments[0] as NonNullable<DeliveryMatrixCell['attempt']>['fragment'];
              const cell: DeliveryMatrixCell = { client, sink: port, source, fault,
                selector: task.name, evidenceRefs: [`vitest:${task.name}#nativeOverlappingPorts`],
                terminalOracle: 'complete-stdout', state: 'emitted', verdict: 'passed', suppressionWrites: 1,
                attempt: { id: owner, recipient: owner, workspace: 'isolated-org-fixture', epoch: 0, token: proof.token, fragment },
                proof: { event: 'complete-stdout', adapter: 'ptool-stdio', receiptRef: `vitest:${task.name}#nativeOverlappingPorts`,
                  attemptId: owner, recipient: owner, workspace: 'isolated-org-fixture', epoch: 0, token: proof.token,
                  client, sink: port, payloadSha256: receipt.payloadSha256, payloadBytes: receipt.payloadBytes, fragment } };
              joinedCells.set(deliveryMatrixCellKey(cell), cell);
              Object.assign(task.meta, { deliveryMatrixCell: cell, nativeOverlappingPorts: {
                nativeAttempts, proofs, receipts: captures.map(capture => capture!.stdoutReceipts),
                preparedBeforeEitherResponse: overlapPrepared, surfacedRows, backendConfirmation: 'exact saved native receipts replayed',
                endpointHandler: 'UNKNOWN', deployedRuntime: 'UNKNOWN' } });
              return;
            }
            if (fault === 'retry') {
              await runNative(true);
              const diagnostics = JSON.parse(readFileSync(diagnosticsPath, 'utf8'));
              expect(diagnostics.pipeProbe).toMatchObject({ cut: true, closed: true, forwardedBytes: 1024,
                targetMethod: port === 'initialize' ? 'initialize' : 'tools/call' });
              expect(diagnostics.pipeProbe.consumedBytes).toBeGreaterThanOrEqual(1024);
              expect(diagnostics.stdoutDelivery).toEqual({ adapter: 'ptool-stdio', owner, confirmations: [] });
              expect(offered?.fragments).toHaveLength(1);
              expect(await surfaced()).toEqual([]);
              expect(echoedConfirmations).toEqual([]);
              expect(await buildLaunchMemoryBlock({ ...input, session: { sessionId: owner, port: 'mid-turn' } }))
                .toContain('Only after explicit final approval ☃.');
              Object.assign(task.meta, { nativeFailedRetry: { diagnosticsPath, diagnostics, offered,
                suppressionWrites: 0, eligibleBeforeRetry: true } });
            }
            const capture = await runNative(fault === 'partial-stdout');
            if (fault === 'partial-stdout') Object.assign(task.meta, { nativePartialFailure: failure });
            expect(offered?.owner).toBe(owner);
            expect(offered?.fragments).toHaveLength(1);
            const { rendered: emittedFragment, ...fragment } = offered!.fragments[0]!;
            expect(typeof emittedFragment).toBe('string');
            expect(rendered).toContain(emittedFragment);
            expect(fragment).toMatchObject({ kind: source, epoch: 0, port,
              bodySha256: createHash('sha256').update(emittedFragment as string).digest('hex'),
              bodyBytes: Buffer.byteLength(emittedFragment as string) });
            if (fault === 'partial-stdout') {
              const diagnostics = JSON.parse(readFileSync(diagnosticsPath, 'utf8'));
              const pipe = diagnostics.pipeProbe;
              Object.assign(task.meta, { nativePartialOutput: { failure, pipe,
                stdoutDelivery: diagnostics.stdoutDelivery, clientVersion: diagnostics.clientVersion } });
              // A failed handshake is not partial-delivery evidence: require
              // the intended response and a nonempty, closed real OS pipe.
              expect(pipe).toMatchObject({ cut: true, closed: true, forwardedBytes: 1024,
                targetMethod: port === 'initialize' ? 'initialize' : 'tools/call' });
              expect(pipe.targetRequest.method).toBe(pipe.targetMethod);
              expect(pipe.consumedBytes).toBeGreaterThanOrEqual(1024);
              expect(pipe.consumedBytes).toBeLessThan(512 * 1024);
              expect(pipe.prefix).toContain('Only after explicit final approval');
              expect(JSON.stringify(diagnostics.requests)).not.toContain('FINAL_CONDITION');
              expect(diagnostics.stdoutDelivery).toEqual({ adapter: 'ptool-stdio', owner, confirmations: [] });
              expect(echoedConfirmations).toEqual([]);
              expect(await surfaced()).toEqual([]);
              const retained = await db.adminSql<{ pending: { fragments: unknown[] }; committed: unknown }[]>`
                SELECT pending, committed FROM harness_shared.coord_read_cursors
                 WHERE owner_id = ${owner} AND surface = ${'memory-emission:' + offered!.token}
              `;
              expect(retained).toHaveLength(1);
              expect(retained[0]!.pending.fragments).toEqual([fragment]);
              expect(retained[0]!.committed).toBeNull();
              expect(await buildLaunchMemoryBlock({ ...input, session: { sessionId: owner, port: 'mid-turn' } }))
                .toContain('Only after explicit final approval ☃.');
              expect(await surfaced()).toEqual([]);
              const cell: DeliveryMatrixCell = { client, sink: port, source, fault,
                selector: task.name, evidenceRefs: [`vitest:${task.name}#nativePartialOutput`],
                terminalOracle: 'complete-stdout', state: 'partial', verdict: 'passed', suppressionWrites: 0,
                attempt: { id: owner, recipient: owner, workspace: 'isolated-org-fixture', epoch: 0,
                  token: offered!.token, fragment: fragment as NonNullable<DeliveryMatrixCell['attempt']>['fragment'] } };
              joinedCells.set(deliveryMatrixCellKey(cell), cell);
              Object.assign(task.meta, { deliveryMatrixCell: cell, productionLaunchReceiptJoin: {
                client, source, port, offered, retained, cursorStore: 'postgresql', surfacedStore: 'postgresql',
                evidencePlane: 'production launch builder + receipt wrapper + installed native partial stdout + PostgreSQL',
                endpointHandler: 'UNKNOWN', deployedRuntime: 'UNKNOWN', backendConfirmation: 'none' } });
              return;
            }
            expect(capture).not.toBeNull();
            if (!capture) throw new Error('Missing complete native capture');
            const visible = port === 'initialize' ? rendered : JSON.stringify({ [port]: rendered });
            expect(JSON.stringify(capture.request)).toContain(JSON.stringify(visible).slice(1, -1));
            const proof = { token: offered!.token, fragments: [fragment] };
            expect(capture.stdoutDelivery).toEqual({ adapter: 'ptool-stdio', owner, confirmations: [proof] });
            expect(capture.stdoutReceipts).toHaveLength(1);
            const receipt = capture.stdoutReceipts![0]!;
            expect(receipt).toMatchObject({ stage: 'stdout-emitted', owner, token: proof.token,
              memoryFragments: [fragment] });
            expect(receipt.payloadSha256).toMatch(/^[a-f0-9]{64}$/);
            expect(receipt.payloadBytes).toBeGreaterThanOrEqual(Number(fragment.bodyBytes));
            if (fault === 'abandon-expiry') {
              expect(await surfaced()).toEqual([]);
              expect(await confirmMemoryEmission(db.adminSql as never, owner, proof as never)).toBe(0);
              expect(await db.adminSql`SELECT surface FROM harness_shared.coord_read_cursors
                WHERE owner_id = ${owner} AND surface = ${'memory-emission:' + offered!.token}`).toHaveLength(0);
              expect(await buildLaunchMemoryBlock({ ...input, session: { sessionId: owner, port: 'mid-turn' } }))
                .toContain('Only after explicit final approval ☃.');
              expect(await surfaced()).toEqual([]);
              const cell: DeliveryMatrixCell = { client, sink: port, source, fault,
                selector: task.name, evidenceRefs: [`vitest:${task.name}#nativeExpiredPreparation`],
                terminalOracle: 'complete-stdout', state: 'abandoned', verdict: 'passed', suppressionWrites: 0,
                attempt: { id: owner, recipient: owner, workspace: 'isolated-org-fixture', epoch: 0,
                  token: offered!.token, fragment: fragment as NonNullable<DeliveryMatrixCell['attempt']>['fragment'] } };
              joinedCells.set(deliveryMatrixCellKey(cell), cell);
              Object.assign(task.meta, { deliveryMatrixCell: cell, nativeExpiredReceipt: receipt,
                productionLaunchReceiptJoin: { client, source, port, offered, receipt: proof,
                  cursorStore: 'postgresql', surfacedStore: 'postgresql', backendConfirmation: 'expired native receipt rejected',
                  endpointHandler: 'UNKNOWN', deployedRuntime: 'UNKNOWN' } });
              return;
            }
            // Receipt replay below is explicit: this is not evidence that a
            // live endpoint received a later native request after tool exit.
            const beforeReplay = await surfaced();
            expect(beforeReplay.length).toBe(echoedConfirmations.some(row => row.token === proof.token) ? 1 : 0);
            await withMemoryEmissionReceipt(db.adminSql as never, owner, capture.stdoutDelivery!.confirmations,
              async () => ({ content: [] }));
            expect(await surfaced()).toEqual([{ port, epoch: 0 }]);
            expect(await confirmMemoryEmission(db.adminSql as never, owner, proof as never)).toBe(0);
            const matrixFragment = fragment as NonNullable<DeliveryMatrixCell['attempt']>['fragment'];
            const cell: DeliveryMatrixCell = { client, sink: port, source, fault,
              selector: task.name, evidenceRefs: [`vitest:${task.name}#nativeStdoutReceipt`],
              terminalOracle: 'complete-stdout', state: 'emitted', verdict: 'passed', suppressionWrites: 1,
              attempt: { id: owner, recipient: owner, workspace: 'isolated-org-fixture', epoch: 0,
                token: proof.token, fragment: matrixFragment },
              proof: { event: 'complete-stdout', adapter: 'ptool-stdio', receiptRef: `vitest:${task.name}#nativeStdoutReceipt`,
                attemptId: owner, recipient: owner, workspace: 'isolated-org-fixture', epoch: 0,
                token: proof.token, client, sink: port, payloadSha256: receipt.payloadSha256,
                payloadBytes: receipt.payloadBytes, fragment: matrixFragment } };
            joinedCells.set(deliveryMatrixCellKey(cell), cell);
            Object.assign(task.meta, { deliveryMatrixCell: cell, nativeStdoutReceipt: receipt });
            expect(await buildLaunchMemoryBlock({ ...input, session: { sessionId: owner, port: 'mid-turn' } })).toBeNull();
            expect(await bumpSessionEpoch(db.adminSql as never, owner)).toBe(1);
            expect(await buildLaunchMemoryBlock({ ...input, session: { sessionId: owner, port: 'compact' } }))
              .toContain('Only after explicit final approval ☃.');
            Object.assign(task.meta, { productionLaunchReceiptJoin: { client, source, port,
              offered, receipt: proof, beforeReplay, echoedConfirmations, clientVersion: capture.clientVersion,
              cursorStore: 'postgresql', surfacedStore: 'postgresql',
              evidencePlane: 'production launch builder + receipt wrapper + installed native client + PostgreSQL',
              endpointHandler: 'UNKNOWN', deployedRuntime: 'UNKNOWN',
              backendConfirmation: beforeReplay.length ? 'native next-request plus idempotent replay' : 'saved native receipt replay' } });
          } finally { h.entries = savedEntries; h.corpus = null; }
        }, 60_000);

  for (const source of ['memory', 'corpus'] as const)
    for (const output of ['complete', 'closed', 'partial', 'lost-response', 'deadline', 'retry', 'abandon-expiry', 'overlapping-ports'] as const)
      it(`context reliability R-1: production compact ${source} ${output} endpoint hook PostgreSQL join`, async ({ task }) => {
        const owner = `su-compact-${randomUUID()}`;
        const home = mkdtempSync(join(tmpdir(), 'compact-pg-'));
        const hooks = join(home, 'hooks', 'inject');
        mkdirSync(hooks, { recursive: true });
        const ledgerSource = readFileSync(new URL('../../../../apps/operator/scripts/hooks/inject/delivery-ledger.mjs', import.meta.url), 'utf8');
        writeFileSync(join(hooks, 'delivery-ledger.mjs'), ledgerSource);
        writeFileSync(join(home, RECOVER_HOOK), RECOVER_HOOK_SOURCE);
        writeFileSync(join(home, RECOVER_INTENT), JSON.stringify({ sid: owner }));
        const savedEntries = h.entries;
        const text = 'Apply zephyrrepair recovery.\nOnly after explicit final approval ☃.';
        h.entries = source === 'memory' ? [{ id: randomUUID(), text, scope: 'u-test', score: 0.95 }] : [];
        const selected = selectCorpusLines({ queryText: 'zephyrrepair', budgetChars: 3000,
          hits: [{ source: 'plan', sourceId: `compact:${owner}`, excerpt: text, meta: { contextUnit: text }, score: 0.95 }] });
        h.corpus = source === 'corpus' ? { ...selected, block: renderCorpusBlock(selected.lines), outcome: 'ok',
          embedderAvailable: true, candidateCount: 1, legs: null, retrievalDepth: 1, rerank: 'nothing-to-reorder' } : null;
        h.compactPadding = ['closed', 'partial', 'retry'].includes(output) ? 'x'.repeat(512 * 1024) : '';
        const profile = resolveLaunchProfile({ claimedItemTitles: ['zephyrrepair approval'] });
        const launchInput = { profile, workspaceId: 'ws-test', userId: 'u-test',
          session: { sessionId: owner, port: 'turn-start' } };
        const surfaced = () => source === 'memory'
          ? db.adminSql<{ port: string; epoch: number }[]>`SELECT port, epoch FROM harness_shared.memory_session_surfaced WHERE session_id = ${owner}`
          : db.adminSql<{ port: string; epoch: number }[]>`SELECT port, epoch FROM harness_shared.corpus_session_surfaced WHERE session_id = ${owner}`;
        const responses: Array<Record<string, any>> = [];
        const errors: string[] = [];
        const transport: Array<{ fault: string; elapsedMs: number; ended: boolean }> = [];
        const pendingFor = (token: string) => db.adminSql<{ fragments: unknown[] }[]>`
          SELECT pending -> 'fragments' AS fragments FROM harness_shared.coord_read_cursors
          WHERE owner_id = ${owner} AND surface = ${'memory-emission:' + token} AND pending IS NOT NULL`;
        let releaseCompactPrepared!: () => void, releaseOverlap!: () => void;
        const compactPrepared = new Promise<void>(resolve => { releaseCompactPrepared = resolve; });
        const overlapReady = new Promise<void>(resolve => { releaseOverlap = resolve; });
        let overlapPrepared = 0;
        const otherOffers: Array<Record<string, any>> = [];
        const server = createServer((req, res) => {
          void (async () => {
            if (req.url?.includes('turn-start-memory')) {
              const chunks: Buffer[] = [];
              for await (const chunk of req) chunks.push(Buffer.from(chunk));
              const request = JSON.parse(Buffer.concat(chunks).toString());
              expect(request.owner).toBe(owner);
              expect(request.confirmedMemoryDeliveries ?? []).toEqual([]);
              const response = await withMemoryEmissionReceipt(db.adminSql as never, owner, undefined, async () => ({
                content: [{ type: 'text' as const, text: await buildLaunchMemoryBlock(launchInput) ?? '' }],
              }));
              const offer = response._meta?.['papercusp/memoryEmission'] as
                { owner: string; token: string; fragments: Array<Record<string, unknown>> } | undefined;
              expect(offer).toMatchObject({ owner, fragments: [expect.objectContaining({ kind: source, epoch: 1, port: 'turn-start' })] });
              otherOffers.push(offer!);
              if (++overlapPrepared === 2) releaseOverlap();
              await overlapReady;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ text: response.content[0].text, deliveryToken: offer!.token, memoryFragmentOffers: offer!.fragments }));
              return;
            }
            expect(req.url).toContain('memoryReceiptMode=1');
            const response = await recoveryEndpoints[0].handler(new Request(`http://localhost${req.url}`),
              { principal: null, input: undefined, params: {}, log: () => {}, signal: new AbortController().signal });
            const body = await response.json(); responses.push(body);
            const offer = body._meta?.['papercusp/memoryEmission'];
            if (output === 'complete') {
              const { rendered: _rendered, ...fragment } = offer.fragments[0];
              const pending = await pendingFor(offer.token);
              expect(pending).toEqual([{ fragments: [fragment] }]);
              expect(await surfaced()).toEqual([]);
              const cell: DeliveryMatrixCell = { client: 'claude', sink: 'compact-reprime', source, fault: 'prepare',
                selector: task.name, evidenceRefs: [`vitest:${task.name}#compactPreparation`],
                terminalOracle: 'complete-stdout', state: 'prepared', verdict: 'passed', suppressionWrites: 0,
                attempt: { id: owner, recipient: owner, workspace: 'isolated-org-fixture', epoch: fragment.epoch,
                  token: offer.token, fragment } };
              joinedCells.set(deliveryMatrixCellKey(cell), cell);
              Object.assign(task.meta, { compactPreparation: { cell, pending, boundary: 'prepared before HTTP response or hook stdout' } });
            }
            if (output === 'overlapping-ports') {
              if (++overlapPrepared === 2) releaseOverlap();
              releaseCompactPrepared();
              await overlapReady;
            }
            if (output === 'lost-response' || output === 'deadline') {
              const startedAt = Date.now();
              res.once('close', () => transport.push({ fault: output, elapsedMs: Date.now() - startedAt, ended: res.writableEnded }));
              if (output === 'lost-response') req.socket.destroy();
              return; // deadline: the generated hook's real 4.5s abort closes this response
            }
            res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body));
          })().catch(error => { errors.push(String(error)); res.destroy(); });
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Missing compact fixture address');
        const env = { PATH: process.env.PATH, LANG: process.env.LANG ?? 'C.UTF-8', HOME: home,
          PAPERCUSP_HOME: home, PAPERCUSP_SID: owner, PAPERCUSP_OPERATOR_URL: `http://127.0.0.1:${address.port}`,
          PSU_RECOVER_TEST_CHAIN: JSON.stringify([['sh', '-c', 'hook'], ['claude', '--system-prompt-file', '/fixture/playbook']]) };
        const run = async (pipe: 'complete' | 'closed' | 'partial' = 'complete') => {
          const child = spawn(process.execPath, [join(home, RECOVER_HOOK)], { env, cwd: home, stdio: ['pipe', 'pipe', 'pipe'] });
          const stdout: Buffer[] = [], stderr: Buffer[] = [];
          let consumedBytes = 0;
          if (pipe === 'closed') child.stdout.destroy();
          else child.stdout.on('data', (chunk: Buffer) => {
            consumedBytes += chunk.length;
            if (pipe === 'partial') child.stdout.destroy(); else stdout.push(chunk);
          });
          child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
          const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
          try {
            const terminal = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
              child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal }));
            });
            child.stdin.end(JSON.stringify({ session_id: 'native-compact', source: 'compact' }));
            return { ...await terminal, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString(), consumedBytes };
          } finally { clearTimeout(timer); }
        };
        try {
          if (output === 'retry') {
            const failed = await run('partial');
            expect(failed.signal, failed.stderr).toBeNull(); expect(failed.code, failed.stderr).toBe(0);
            expect(failed.consumedBytes).toBeGreaterThan(0);
            expect(failed.consumedBytes).toBeLessThan(Buffer.byteLength(responses[0].text));
            expect(openDeliveryLedger(owner, env, 'compact')!.confirmedMemoryDeliveries()).toEqual([]);
            expect(await surfaced()).toEqual([]);
            expect(await buildLaunchMemoryBlock(launchInput)).toContain('Only after explicit final approval ☃.');
            const offer = responses[0]._meta['papercusp/memoryEmission'];
            const { rendered: _rendered, ...fragment } = offer.fragments[0];
            expect(await pendingFor(offer.token)).toEqual([{ fragments: [fragment] }]);
            Object.assign(task.meta, { compactFailedRetry: { failed, offer, pending: await pendingFor(offer.token), suppressionWrites: 0 } });
            h.compactPadding = '';
          }
          const [result, other] = output === 'overlapping-ports'
            ? await Promise.all([run(), (async () => {
              await compactPrepared;
              return runReceiptDispatcher(dispatcherRoot, 'claude', 'turn-start', env);
            })()])
            : [await run(output === 'closed' || output === 'partial' ? output : 'complete'), undefined];
          Object.assign(task.meta, { compactNativeTerminal: result, compactEndpointErrors: errors, compactTransport: transport });
          expect(result.signal, result.stderr).toBeNull(); expect(result.code, result.stderr).toBe(0);
          expect(errors).toEqual([]); expect(responses).toHaveLength(output === 'retry' ? 2 : 1);
          const body = responses.at(-1)!;
          const offer = body._meta?.['papercusp/memoryEmission'];
          const epoch = output === 'retry' ? 2 : 1;
          expect(offer).toMatchObject({ owner, fragments: [expect.objectContaining({ kind: source, epoch, port: 'compact' })] });
          expect(body.text).toContain('Only after explicit final approval ☃.');
          expect(await surfaced()).toEqual([]);
          const proofs = openDeliveryLedger(owner, env, 'compact')!.confirmedMemoryDeliveries();
          const emitted = output === 'complete' || output === 'retry' || output === 'overlapping-ports';
          if (!emitted && output !== 'abandon-expiry') {
            expect(proofs).toEqual([]);
            if (output === 'partial') {
              expect(result.consumedBytes).toBeGreaterThan(0);
              expect(result.consumedBytes).toBeLessThan(Buffer.byteLength(body.text));
            }
            if (output === 'lost-response' || output === 'deadline') {
              expect(result.stdout).not.toContain('Only after explicit final approval ☃.');
              expect(transport).toEqual([expect.objectContaining({ fault: output, ended: false })]);
              if (output === 'deadline') expect(transport[0].elapsedMs).toBeGreaterThan(4000);
            }
            const { rendered: _rendered, ...fragment } = offer.fragments[0];
            expect(await pendingFor(offer.token)).toEqual([{ fragments: [fragment] }]);
            expect(await buildLaunchMemoryBlock(launchInput)).toContain('Only after explicit final approval ☃.');
          } else {
            const { rendered, ...fragment } = offer.fragments[0];
            expect(result.stdout).not.toContain('papercusp/memoryEmission');
            expect(JSON.parse(result.stdout).hookSpecificOutput.additionalContext).toContain(rendered);
            const compactProof = { token: offer.token, fragments: [fragment] };
            if (other) {
              expect(overlapPrepared).toBe(2); expect(otherOffers).toHaveLength(1);
              expect(other.signal, other.stderr).toBeNull(); expect(other.code, other.stderr).toBe(0);
              expect(other.stdout).toContain('Only after explicit final approval ☃.');
              expect(proofs).toHaveLength(2);
              const { rendered: _otherRendered, ...otherFragment } = otherOffers[0].fragments[0];
              expect(proofs).toEqual(expect.arrayContaining([compactProof, { token: otherOffers[0].token, fragments: [otherFragment] }]));
              Object.assign(task.meta, { compactOverlap: { other, otherOffers, proofs, preparedBeforeEitherOutput: overlapPrepared } });
            } else expect(proofs).toEqual([compactProof]);
            const receiptPath = join(ledgerDir(env), `${owner}.compact.emissions`, createHash('sha256').update(offer.token).digest('hex') + '.json');
            const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
            expect(receipt).toMatchObject({ owner, payloadSha256: createHash('sha256').update(result.stdout).digest('hex'),
              payloadBytes: Buffer.byteLength(result.stdout), stage: 'stdout-emitted' });
            if (output === 'abandon-expiry') {
              await db.adminSql`UPDATE harness_shared.coord_read_cursors SET pending = jsonb_set(pending, '{expiresAt}', '1'::jsonb)
                WHERE owner_id = ${owner} AND surface = ${'memory-emission:' + offer.token}`;
              expect(await pendingFor(offer.token)).toEqual([{ fragments: [fragment] }]);
            }
            await withMemoryEmissionReceipt(db.adminSql as never, owner, [compactProof], async () => ({ content: [] }));
            if (other) await withMemoryEmissionReceipt(db.adminSql as never, owner, proofs, async () => ({ content: [] }));
            expect(await surfaced()).toEqual(output === 'abandon-expiry' ? [] : [{ port: 'compact', epoch }]);
            expect(await confirmMemoryEmission(db.adminSql as never, owner, { token: offer.token, fragments: [fragment] })).toBe(0);
            expect(await pendingFor(offer.token)).toEqual([]);
            const eligible = await buildLaunchMemoryBlock(launchInput);
            if (output === 'abandon-expiry') expect(eligible).toContain('Only after explicit final approval ☃.');
            else expect(eligible).toBeNull();
            Object.assign(task.meta, { compactImmutableReceipt: receipt });
          }
          if (output !== 'closed') {
            const { rendered: _fragmentText, ...fragment } = offer.fragments[0];
            const sink = 'compact-reprime' as const;
            const cell: DeliveryMatrixCell = { client: 'claude', sink, source,
              fault: output === 'complete' ? 'duplicate-commit' : output === 'partial' ? 'partial-stdout' : output,
              selector: task.name, evidenceRefs: [`vitest:${task.name}#compactEndpointJoin`],
              terminalOracle: 'complete-stdout', state: emitted ? 'emitted' : output === 'partial' ? 'partial' : output === 'abandon-expiry' ? 'abandoned' : 'prepared',
              verdict: 'passed', suppressionWrites: emitted ? 1 : 0,
              attempt: { id: owner, recipient: owner, workspace: 'isolated-org-fixture', epoch,
                token: offer.token, fragment },
              ...(emitted ? { proof: { event: 'complete-stdout' as const, adapter: 'claude-session-start',
                receiptRef: `vitest:${task.name}#compactImmutableReceipt`, attemptId: owner, recipient: owner,
                workspace: 'isolated-org-fixture', epoch, token: offer.token, client: 'claude', sink,
                payloadSha256: createHash('sha256').update(result.stdout).digest('hex'),
                payloadBytes: Buffer.byteLength(result.stdout), fragment } } : {}) };
            joinedCells.set(deliveryMatrixCellKey(cell), cell);
            Object.assign(task.meta, { deliveryMatrixCell: cell });
          }
          Object.assign(task.meta, { compactEndpointJoin: { source, output, offer, proofs,
            generatedHookSha256: createHash('sha256').update(RECOVER_HOOK_SOURCE).digest('hex'),
            ledgerSourceSha256: createHash('sha256').update(ledgerSource).digest('hex'),
            evidencePlane: 'real compact endpoint + generated SessionStart subprocess + production PostgreSQL',
            retrieval: 'deterministic fixture', clientHostConsumption: 'UNKNOWN', deployedRuntime: 'UNKNOWN',
            backendConfirmation: 'explicit saved native receipt replay' } });
        } finally {
          h.entries = savedEntries; h.corpus = null; h.compactPadding = '';
          server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
          rmSync(home, { recursive: true, force: true });
        }
      }, 45_000);

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

  // Keep the census after the native joins so its persisted task metadata
  // includes their actual receipts rather than a disconnected early snapshot.
  it('context reliability R-1: joined cell census retains the complete denominator', ({ task }) => {
    const cells = deliveryMatrixPopulation().map(coordinate => joinedCells.get(deliveryMatrixCellKey(coordinate)) ?? {
      ...coordinate, selector: 'not exercised by PostgreSQL dispatcher join',
      evidenceRefs: ['session-epoch-cross-port.integration.test.ts: bounded join census'],
      terminalOracle: deliveryTerminalOracle(coordinate), state: 'UNKNOWN' as const,
      verdict: 'UNKNOWN' as const, suppressionWrites: 0,
    });
    expect(joinedCells.size).toBe(240);
    expect(cells).toHaveLength(432);
    // Structural fixture identity only; acceptance binds separately retained
    // plan/rubric/spec/runtime identities and independent evidence later.
    const manifest = { schemaVersion: 'delivery-matrix-v1' as const,
      identity: { planRevision: 1, rubricRevision: 1, planHash: '1'.repeat(64), rubricHash: '2'.repeat(64),
        barHash: '3'.repeat(64), specHash: '4'.repeat(64), sourceHash: '5'.repeat(64), testHash: '6'.repeat(64),
        runtimeGeneration: 'isolated-postgresql-dispatcher-fixture' }, cells };
    const result = validateDeliveryMatrix(manifest);
    expect(result).toMatchObject({ closed: true, valid: true, acceptanceReady: false, errors: [] });
    expect(result.unknown).toHaveLength(192);
    Object.assign(task.meta, { deliveryMatrixCensus: { manifest, result,
      identityKind: 'structural fixture only; independent acceptance and shipment not asserted' } });
  });
});
