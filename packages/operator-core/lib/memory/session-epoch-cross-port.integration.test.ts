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
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { OrgTestDb } from '../../test/_org-test-db';
import type { MemoryEntry } from './backend';
import { sessionAllowsAmbientContext, setSessionConfinementResolver } from '../capability-envelope/session-confinement-port';
import { ledgerDir, openDeliveryLedger } from '../../../../apps/operator/scripts/hooks/inject/delivery-ledger.mjs';
import { nativeProcessTraceEnv } from '../../../../scripts/lib/native-process-trace-env.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { UdsMcpTransport } from '@papercusp/tooldef-mcp';
import { DELIVERY_MATRIX_FAULTS, deliveryMatrixCellKey, deliveryMatrixPopulation, deliveryTerminalOracle,
  validateDeliveryMatrix, attributeFinalContextTranscript, sampleFinalDeliveredContext,
  joinFinalContextNativeEmissions, type DeliveryMatrixCell, type FinalContextAttemptSnapshot } from './injection-delivery-coverage';
import { contextSourceVersion } from './temporal-render';
import { activeWorkspaceId } from '../workspace-registry';

const h = vi.hoisted(() => ({ sql: null as unknown, entries: [] as MemoryEntry[],
  canonicalEntries: null as MemoryEntry[] | null,
  compactPadding: '',
  corpus: null as Awaited<ReturnType<typeof import('./corpus-recall-io').recallCorpusContext>> | null }));

// Real PG via the org-fixture; only getOrgPg is stubbed to point at it.
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: h.sql }),
}));
vi.mock('./backend', () => {
  // Receipt preparation re-reads the selected source from the same backend.
  // Keep this fixture's retrieval and scoped authority reads consistent;
  // a new backend per lookup correctly fails production revalidation.
  const backend = {
    available: async () => ({ ok: true }),
    search: async () => h.entries,
    listPage: async ({ scope, ids, offset = 0, limit = 8 }: {
      scope: string; ids?: string[]; offset?: number; limit?: number;
    }) => {
      const entries = (h.canonicalEntries ?? h.entries).filter(entry => entry.scope === scope && ids?.includes(entry.id));
      return { entries: entries.slice(offset, offset + limit), total: entries.length };
    },
  };
  return { getMemoryBackend: () => backend };
});
// This suite owns the memory/receipt ledgers, not external corpus retrieval.
// Keep that unrelated leg empty and healthy; otherwise its five-second wall
// emits a degradation notice even when the tested memory dedup is correct.
vi.mock('./corpus-recall-io', async original => ({
  ...await original<typeof import('./corpus-recall-io')>(),
  recallCorpusContext: async () => h.corpus ?? ({ heading: 'Related context', outcome: 'ok', lines: [], dropped: [],
    embedderAvailable: true, candidateCount: 0, retrievalDepth: 0, rerank: 'nothing-to-reorder', legs: null }),
}));
// The workspace-scope read is flag-server-backed (not best-effort-wrapped);
// pin it OFF so the test exercises the dedup path, not flag plumbing.
vi.mock('./workspace-scope-recall', () => ({
  isMemoryWorkspaceScopedRecallOn: async () => false,
  keepUserPoolHitForWorkspace: () => true,
}));
// These authenticated hosts exercise activity delivery and PG confirmation.
// Initialize prelude retrieval has its own suite and must not start unrelated
// memory/index enrichment or a late deadline loser in this fixture.
vi.mock('./mcp-prelude', () => ({ buildMcpPrelude: async () => null }));
// Deterministic carry/retrieval inputs; the recovery endpoint, compact epoch
// transition, launch renderer, generated native hook and PG stores stay real.
vi.mock('../carry-brief', async original => ({
  ...await original<typeof import('../carry-brief')>(),
  buildCarryBrief: async () => ({ heldItems: [{ id: 'WI-compact', title: 'zephyrrepair approval', harness: 'papercusp' }],
    fleet: null, awaits: [], facts: [] }),
  renderCarryBriefText: () => 'Carry brief\n' + h.compactPadding,
}));
vi.mock('../auth', async original => ({ ...await original<typeof import('../auth')>(),
  getSessionUserOrDefault: async () => ({ id: 'u-test' }),
}));
vi.mock('../agent-identities/sync-hook-rules', async original => ({
  ...await original<typeof import('../agent-identities/sync-hook-rules')>(),
  evaluateHookContextSink: async () => ({ text: 'IDENTITY COMPACTION\n' + h.compactPadding, result: null }),
}));
vi.mock('./compact-reprime', async original => {
  const actual = await original<typeof import('./compact-reprime')>();
  return { ...actual, buildCompactReprimeBlock: (input: Parameters<typeof actual.buildCompactReprimeBlock>[0]) =>
    actual.buildCompactReprimeBlock(input, { retireFlagFn: async () => false }) };
});
// Reuse the transport matrix's bounded catalogue seam. The production host,
// credential verifier, activity handler and PG stores below remain real.
vi.mock('../agent-tools/index', () => {
  throw new Error('The receipt integration must not initialize the full application catalogue');
});
vi.mock('../agent-tools/operator-tool-catalogue', () => ({
  loadOperatorToolCatalogue: async () => {
    await Promise.all([
      import('../agent-tools/pre-prompt-registry-config'),
      import('../agent-tools/activity/report'),
    ]);
  },
}));

const { buildMemoryContextBlock, prepareMemoryContextBlock } = await import('./injection');
const { bumpSessionEpoch, memoryFragmentOffer, stageMemoryEmission, confirmMemoryEmission,
  withMemoryEmissionReceipt } = await import('./session-epoch-ledger');
const { buildLaunchMemoryBlock, resolveLaunchProfile } = await import('./launch-profile');
const { selectCorpusLines, renderCorpusBlock } = await import('./corpus-recall');
const { captureNativeMcp, nativeMcpTranscriptLocators, sha256 } = await import('./fixtures/native-mcp-export');
const { resetReadCursorStore } = await import('../agent-tools/coordination/read-cursors');
const { createOrgTestDb } = await import('../../test/_org-test-db');
const { RECOVER_HOOK_SOURCE, RECOVER_HOOK, RECOVER_INTENT } = await import('../interactive-claude-config');
const { default: recoveryEndpoints } = await import('../endpoint-route/routes/agent-mcp/session-recovery-brief');
const { default: identityEndpoints } = await import('../endpoint-route/routes/agent-mcp/identity-hook-sinks');

const SID = `sid-cross-port-${Date.now()}`;

// These fresh fixture sessions have no confirmed source baseline. The staged
// host row retains source authority and its CAS baseline; native receipts carry
// only the public manifest, so compare each boundary against its own contract.
function initialStagedFragment(offer: Record<string, unknown>): Record<string, unknown> {
  const { rendered: _rendered, ...fragment } = offer;
  return { ...fragment, ...(fragment.sourceFingerprint !== undefined
    ? { previousSourceFingerprint: null } : {}) };
}

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

/** A private credential and the real authenticated listener, never a live
 * operator connection. The native fixture forwards its local canary call to
 * this host's actual activity:report and returns that response unchanged. */
async function withAuthenticatedActivityHost<T>(owner: string, agent: string,
  run: (client: Client, generation: string) => Promise<T>): Promise<T> {
  const { AGENT_MCP_AUTH_META, startAgentMcpServer } = await import('../endpoint-route/routes/transport/_mcp-uds');
  const { registerMcpHost, mcpHostServerOptions, tryBuildSpawnContext, pinVerifiedMcpRequest } =
    await import('../endpoint-route/routes/transport/_mcp-host');
  const { coordScopeWorkspace } = await import('../agent-tools/coordination/log');
  const home = mkdtempSync(join(tmpdir(), 'r8-authenticated-host-'));
  const previousHome = process.env.PAPERCUSP_HOME;
  const bearer = randomUUID();
  writeFileSync(join(home, 'superuser-token'), bearer, { mode: 0o600 });
  process.env.PAPERCUSP_HOME = home;
  let listener: Awaited<ReturnType<typeof startAgentMcpServer>> | undefined;
  const clients: Client[] = [];
  try {
    listener = await startAgentMcpServer({ port: 3070, host: {
      register: registerMcpHost, options: mcpHostServerOptions(),
      verify: tryBuildSpawnContext, pin: pinVerifiedMcpRequest,
    } });
    const endpoint = listener.endpoint;
    const connect = async (token: string) => {
      const client = new Client({ name: 'r8-pg-native-host', version: '1' });
      clients.push(client);
      const wire = new UdsMcpTransport({ path: endpoint.socketPath });
      const send = wire.send.bind(wire);
      wire.send = message => send('method' in message && message.method === 'initialize'
        ? { ...message, params: { ...message.params, _meta: { [AGENT_MCP_AUTH_META]: {
          version: 1, operatorId: endpoint.operatorId, generation: endpoint.generation,
          url: `http://127.0.0.1:3070/api/mcp?superuser=1&workspace=${encodeURIComponent(coordScopeWorkspace())}`
            + `&client=${encodeURIComponent(owner)}&agent=${agent}&tools=activity:report`,
          headers: { authorization: `Bearer ${token}` },
        } } } } : message);
      await client.connect(wire);
      return client;
    };
    await expect(connect('invalid-fixture-bearer')).rejects.toThrow('uds_auth_failed');
    const client = await connect(bearer);
    const listing = await client.listTools();
    const generation = listing.tools.find(tool => tool.name === 'activity:report')?._meta?.['papercusp/servingGeneration'];
    expect(typeof generation).toBe('string');
    return await run(client, generation as string);
  } finally {
    try { await Promise.all(clients.map(client => client.close())); }
    finally {
      try { await listener?.close(); }
      finally {
        if (previousHome === undefined) delete process.env.PAPERCUSP_HOME;
        else process.env.PAPERCUSP_HOME = previousHome;
        rmSync(home, { recursive: true, force: true });
      }
    }
  }
}

async function runReceiptDispatcher(root: string, client: 'codex' | 'claude' | 'omp',
  port: 'turn-start' | 'mid-turn' | 'compaction', env: NodeJS.ProcessEnv,
  output: 'complete' | 'closed' | 'partial' = 'complete') {
  const event = port === 'compaction' ? { source: 'compact', session_id: 'native-compact' }
    : port === 'turn-start' ? { prompt: 'receipt delivery' }
    : client === 'codex' ? { tool_name: 'Grep', tool_input: { pattern: 'receipt' }, tool_response: '' }
    : client === 'claude' ? { tool_calls: [{ tool_name: 'Grep', tool_input: { pattern: 'receipt' }, tool_response: '' }] }
    : { message: { content: [{ type: 'toolCall', id: 'call-1', name: 'Grep', arguments: { pattern: 'receipt' } }] },
      toolResults: [{ toolCallId: 'call-1', toolName: 'Grep', content: [{ type: 'text', text: '' }] }] };
  const nativeEvent = port === 'compaction' ? 'SessionStart'
    : port === 'turn-start' ? (client === 'omp' ? 'before_agent_start' : 'UserPromptSubmit')
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

  async function corpusPlanFixture(owner: string, text: string, workspaceId = 'ws-test'): Promise<NonNullable<typeof h.corpus>> {
    const slug = `receipt-${owner}`;
    const [row] = await db.adminSql<{ title: string; content: string; updated_at: Date }[]>`
      INSERT INTO harness_shared.harness_plans (workspace_id,harness_slug,plan_slug,title,content,status)
      VALUES (${workspaceId},'papercusp',${slug},'Receipt recovery',${text},'active')
      RETURNING title,content,updated_at`;
    // Retrieval may be deterministic, but receipt preparation must re-read the
    // same canonical full source through production authority validation.
    // The isolated database lifecycle removes these rows after the suite.
    const version = contextSourceVersion({ namespace: `corpus:plan:${workspaceId}`, ref: `plan:papercusp:${slug}`,
      fullText: `${row!.title}\n${row!.content}`, revision: null, updatedAt: row!.updated_at.toISOString(),
      validity: { status: 'current', validAt: null, invalidAt: null, supersededBy: null } });
    const selected = selectCorpusLines({ queryText: 'zephyrrepair', budgetChars: 3000,
      hits: [{ source: 'plan', sourceId: `papercusp:${slug}`, excerpt: text,
        meta: { contextUnit: text, contextSourceVersion: JSON.stringify(version) }, score: 0.95 }] });
    expect(selected.lines).toHaveLength(1);
    expect(selected.lines[0]!.sourceVersion).toEqual(version);
    return { ...selected, block: renderCorpusBlock(selected.lines), outcome: 'ok', embedderAvailable: true,
      candidateCount: 1, legs: null, retrievalDepth: 1, rerank: 'nothing-to-reorder' };
  }

  beforeAll(async () => {
    setSessionConfinementResolver(() => null);
    db = await createOrgTestDb();
    // Exercise the additive source-version migration in this isolated fixture
    // before arming it for boot auto-apply. Once armed, fixture boot applies it.
    const versionDraft = new URL('../../../../libs/papercusp/libs/db/sql/1627-context-source-version-ledgers.sql.DRAFT', import.meta.url);
    if (existsSync(versionDraft)) await db.adminSql.unsafe(readFileSync(versionDraft, 'utf8'));
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

  // R-8 joins authenticated host/activity dispatch, the real inbox/PG cursor
  // and the maintained installed-client stdout capture. Generation/glance are
  // fixed inputs; the local canary is forwarded to the actual activity tool.
  // This remains an isolated current-source journey, not deployed evidence.
  for (const client of ['codex', 'claude', 'omp'] as const)
    for (const fault of ['omitted-carrier', 'partial-stdout'] as const)
      it(`context reliability R-8: native activity notice ${client} ${fault} quiet replay`, async ({ task }) => {
        const bundleModule = await import('../agent-tools/activity/hook-bundle');
        const { buildActivityHookBundle } = bundleModule;
        const { default: inboxTool } = await import('../agent-tools/coordination/tools/inbox');
        const { ackAndRead, stage } = await import('../agent-tools/coordination/read-cursors');
        const { coordLog, coordScopeWorkspace } = await import('../agent-tools/coordination/log');
        const { systemNoticeIdentity } = await import('../agent-tools/coordination/inbox-visibility');
        const { provenSystemNoticeEmissions } = await import('./session-epoch-ledger');
        const { AMBIENT_PUSH_WINDOW_MS } = await import('../ambient-push');
        const owner = `su-notice-${randomUUID()}`;
        const generation = `r8-${owner}:1`;
        const summary = `zephyrrepair notice ${owner} — preserve approval ☃`;
        const notice = { msg_id: randomUUID(), ts: new Date().toISOString(),
          from: 'system-watchdog', to: ['*'], kind: 'message' as const, auto: true, category: 'severe-event',
          condition_key: `r8:${owner}`, severity: 'warning', state_version: 1,
          summary, body: summary, expects: 'none' as const };
        const identity = systemNoticeIdentity(notice)!;
        expect(identity).not.toBeNull();
        const ctx = { isSuperuser: true, uiClientId: owner, clientId: owner,
          workspaceId: coordScopeWorkspace(), principal: { slug: 'system:operator', workspaceId: coordScopeWorkspace() },
          metadata: vi.fn(), log: vi.fn(), progress: vi.fn() } as never;
        const folds: Array<{ injection: string; committedFloor: unknown; replay: unknown }> = [];
        let nowOverride: number | undefined;
        let seenGeneration: string | null = null;
        const fold = async (
          request: Parameters<typeof buildActivityHookBundle>[1] = { generation: seenGeneration, glance_stale: false },
          context: Parameters<typeof buildActivityHookBundle>[2] = ctx,
        ) => {
          const bundle = await buildActivityHookBundle(owner, request, context, {
            generation: async () => generation,
            glance: async () => ({}),
            readWatermark: async () => ({}),
            readInboxCursor: id => ackAndRead(id, 'inbox'),
            stageInboxCursor: (id, next) => stage(id, 'inbox', next),
            now: () => new Date(nowOverride ?? Date.now()),
            inbox: async (floor, context, replay) => {
              const result = await inboxTool.handler({ __deliveryFloorTs: floor,
                __systemNoticeState: replay ?? {} } as never, context) as { content: Array<{ text: string }> };
              const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
              folds.push({ injection: String(payload.injection ?? ''), committedFloor: floor,
                replay: payload.__systemNoticeState });
              return payload;
            },
          });
          expect(bundle.complete).toBe(true);
          seenGeneration = bundle.generation;
          return bundle;
        };
        const floors = () => provenSystemNoticeEmissions(db.adminSql as never, owner, 0, [identity.key]);
        const captures: Array<{ diagnosticsPath: string; stdoutReceipts: unknown; stdoutDelivery: unknown }> = [];
        const savedEntries = h.entries;
        h.entries = [];
        let dateNow: ReturnType<typeof vi.spyOn> | undefined;
        let omitCarrier = false;
        const authOwners: string[] = [];
        const bundleSpy = vi.spyOn(bundleModule, 'buildActivityHookBundle').mockImplementation(async (id, request, context) => {
          expect(id).toBe(owner);
          authOwners.push(id);
          const bundle = await fold(request, context);
          return omitCarrier ? { ...bundle, surfaces: { ...bundle.surfaces,
            inbox: { ...bundle.surfaces?.inbox, injection: '' } } } : bundle;
        });
        try {
          await coordLog.appendLine('messages', notice.from, notice);
          await withAuthenticatedActivityHost(owner, client, async (host, servingGeneration) => {
          const report = async (receipt: unknown = { version: 1, owner: 'forged-recipient', confirmations: [] },
            reportOwner = owner) => host.callTool({ name: 'activity:report',
            arguments: { owner: reportOwner, agent: client, kind: 'lifecycle', summary: 'R8 native proof',
              hook_bundle: { generation: seenGeneration, glance_stale: false } },
            _meta: { 'papercusp/servingGeneration': servingGeneration, 'papercusp/memoryReceipt': receipt } });
          const foreign = await report(undefined, `su-foreign-${randomUUID()}`);
          expect(foreign.isError).toBe(true);
          expect(authOwners).toEqual([]);
          // Collection followed by carrier omission cannot manufacture a floor.
          if (fault === 'omitted-carrier') {
            omitCarrier = true;
            const omitted = await report();
            expect(omitted._meta?.['papercusp/memoryEmission']).toBeUndefined();
            expect(await floors()).toEqual({});
            omitCarrier = false;
          }
          const runNative = async (partial: boolean) => {
            let diagnosticsPath = '';
            let captured: Awaited<ReturnType<typeof captureNativeMcp>> | undefined;
            let failure: string | undefined;
            try { captured = await captureNativeMcp(client,
              [{ name: 'receipt_canary', description: 'Local activity notice receipt observation.' }], summary, [], {
                stdioReceipt: 'memory', stdioPort: 'orient', stdioOwner: owner,
                stdioConfirm: true,
                receiptAdapter: client === 'omp' ? 'omp-rpc' : 'ptool-stdio',
                ...(partial ? { stdioFault: 'partial-stdout' as const } : {}),
                onDiagnostics: path => {
                  diagnosticsPath = path;
                  Object.assign(task.meta, { nativeNoticeDiagnostics: path });
                },
                mcpResult: async (method, result, request) => {
                  const receipt = (request.params as { _meta?: Record<string, unknown> } | undefined)?._meta?.['papercusp/memoryReceipt'] as
                    { confirmations?: unknown } | undefined;
                  if (method !== 'tools/call') {
                    if (Array.isArray(receipt?.confirmations) && receipt.confirmations.length) await report(receipt);
                    return result;
                  }
                  const response = await report(receipt);
                  expect(response.isError).not.toBe(true);
                  if ((request.params as { name?: string })?.name === 'receipt_confirmation'
                      || (Array.isArray(receipt?.confirmations) && receipt.confirmations.length)) return response;
                  expect(response.content).toEqual(expect.arrayContaining([
                    expect.objectContaining({ type: 'text', text: expect.stringContaining(summary) }),
                  ]));
                  return { ...response, ...(partial ? { content: [...response.content as object[],
                    { type: 'text', text: 'x'.repeat(512 * 1024) }] } : {}) };
                },
              }); } catch (error) {
                if (!partial) throw error;
                failure = String(error);
              }
            if (partial) {
              // An interrupted installed host can exit or time out. Neither
              // outcome alone proves partial delivery: require the exact native
              // request, nonempty OS prefix, closed pipe and absent receipt.
              const diagnostics = JSON.parse(readFileSync(diagnosticsPath, 'utf8'));
              expect(diagnostics.pipeProbe).toMatchObject({ cut: true, closed: true,
                targetMethod: 'tools/call', forwardedBytes: 1024 });
              expect(diagnostics.pipeProbe.targetRequest.method).toBe('tools/call');
              expect(diagnostics.pipeProbe.consumedBytes).toBeGreaterThanOrEqual(1024);
              expect(diagnostics.pipeProbe.consumedBytes).toBeLessThan(512 * 1024);
              expect(diagnostics.stdoutDelivery.confirmations).toEqual([]);
              if (client === 'omp') expect(diagnostics.pipeProbe.recorded).toBe(false);
              Object.assign(task.meta, { nativeNoticePartial: { diagnosticsPath, failure,
                pipeProbe: diagnostics.pipeProbe, stdoutDelivery: diagnostics.stdoutDelivery } });
              return;
            }
            expect(captured).toBeDefined();
            const confirmation = JSON.parse(readFileSync(diagnosticsPath, 'utf8')).mcpRequests
              .find((request: { method: string; params?: { _meta?: Record<string, unknown> } }) => {
                const proof = request.params?._meta?.['papercusp/memoryReceipt'] as
                  { confirmations?: unknown[] } | undefined;
                return request.method === 'tools/call' && Array.isArray(proof?.confirmations)
                  && proof.confirmations.length > 0;
              });
            expect(confirmation?.params?._meta?.['papercusp/memoryReceipt']?.confirmations)
              .toEqual(expect.arrayContaining([expect.objectContaining({
                fragments: expect.arrayContaining([expect.objectContaining({ kind: 'notice', id: identity.key })]),
              })]));
            captures.push({ diagnosticsPath: captured!.diagnosticsPath,
              stdoutReceipts: captured!.stdoutReceipts, stdoutDelivery: captured!.stdoutDelivery });
            return captured;
          };
          if (fault === 'partial-stdout') {
            await runNative(true);
            expect(await floors()).toEqual({});
          }
          const captured = (await runNative(false))!;
          expect(captured.stdoutReceipts?.some(row => row.memoryFragments.some(fragment =>
            (fragment as { kind?: string }).kind === 'notice'))).toBe(true);
          const proven = (await floors())[identity.key];
          expect(proven).toMatchObject({ fingerprint: identity.fingerprint, emittedAt: expect.any(Number) });
          // ACK-on-arrival has advanced past the original row. Exact retained
          // IDs, rather than a repeated producer event, recover it when due.
          const cursors = await db.adminSql<{ committed: { since_ts?: string }; pending: unknown }[]>`
            SELECT committed, pending FROM harness_shared.coord_read_cursors
             WHERE workspace_id = ${coordScopeWorkspace()} AND owner_id = ${owner} AND surface = 'inbox'`;
          expect(cursors[0]?.committed.since_ts).toBe(notice.ts);
          const quiet = await report();
          expect(JSON.stringify(quiet.content)).not.toContain(summary);
          expect(quiet._meta?.['papercusp/memoryEmission']).toBeUndefined();
          // Only parent selection uses the deterministic due clock; a future
          // synthetic time is never offered as a native stdout confirmation.
          nowOverride = proven!.emittedAt + AMBIENT_PUSH_WINDOW_MS;
          dateNow = vi.spyOn(Date, 'now').mockReturnValue(nowOverride);
          const due = await report();
          expect(due.content).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: 'text', text: expect.stringContaining(summary) }),
          ]));
          expect(due._meta?.['papercusp/memoryEmission']).toBeDefined();
          expect(await floors()).toEqual({ [identity.key]: proven });
          Object.assign(task.meta, { nativeNoticeReplay: { client, fault, owner, generation, notice,
            identity, folds, captures, proven, dueAt: nowOverride,
            stores: 'real PostgreSQL event log, inbox cursor, emission reservation and notice floor',
            clockScope: 'due selection only; native emission timestamp comes from stdout receipt',
            authenticatedMcpHost: 'production authenticated UDS listener, real on-disk private bearer and activity:report',
            authOwners, nativeIngress: 'fixture canary forwarded to activity:report with native receipt metadata',
            deployedRuntime: 'UNKNOWN' } });
          });
        } finally {
          bundleSpy.mockRestore();
          dateNow?.mockRestore();
          h.entries = savedEntries;
        }
      }, 90_000);

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
            const { rendered: _text, ...manifest } = offer;
            const fragment = { ...manifest, kind: source };
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

  for (const client of ['codex', 'claude', 'omp'] as const)
    for (const source of ['memory', 'corpus'] as const)
      for (const port of client === 'omp' ? ['orient', 'claim', 'create'] as const
        : ['initialize', 'orient', 'claim', 'create'] as const)
        for (const fault of ['duplicate-commit', 'partial-stdout', 'abandon-expiry', 'retry',
          'lost-response', 'deadline', 'overlapping-ports'] as const)
        it(`context reliability R-1: production launch ${client} ${source} ${port} ${fault === 'duplicate-commit' ? '' : fault + ' '}receipt join`, async ({ task }) => {
          const owner = `su-launch-${randomUUID()}`;
          const adapter = client === 'omp' ? 'omp-rpc' : 'ptool-stdio';
          const text = 'Apply zephyrrepair recovery.\nOnly after explicit final approval ☃.';
          const savedEntries = h.entries;
          h.entries = source === 'memory' ? [{ id: randomUUID(), text, scope: 'u-test', score: 0.95 }] : [];
          h.corpus = source === 'corpus' ? await corpusPlanFixture(owner, text) : null;
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
            offers: NonNullable<typeof offered>[]; preparation: { preparedAt: string; fragments: unknown[]; committed: unknown } | null }> = [];
          let releaseOverlap!: () => void;
          const overlapReady = new Promise<void>(resolve => { releaseOverlap = resolve; });
          let overlapPrepared = 0;
          try {
            const runNative = (partial: boolean, nativePort: typeof port = port) => {
              const attempt: typeof nativeAttempts[number] = { port: nativePort, rendered: '', diagnosticsPath: '', offers: [], preparation: null };
              nativeAttempts.push(attempt);
              return captureNativeMcp(client, [{ name: 'receipt_canary', description: 'Local launch receipt observation.' }],
              text, [], { stdioReceipt: source, stdioPort: nativePort, stdioOwner: owner,
                receiptAdapter: adapter,
                ...(fault === 'duplicate-commit' && nativePort === 'orient' ? { retainNativeTranscript: true } : {}),
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
                    if (method !== (nativePort === 'initialize' ? 'initialize' : 'tools/call')
                        || (request.params as { name?: string })?.name === 'receipt_confirmation') return result;
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
                      const { rendered: _text, sourceVersion: _hostSource, ...fragment } = offer.fragments[0]!;
                      const pending = await db.adminSql<{ preparedAt: string; fragments: unknown[]; committed: unknown }[]>`
                        SELECT pending ->> 'preparedAt' AS "preparedAt", pending -> 'fragments' AS fragments, committed
                        FROM harness_shared.coord_read_cursors
                        WHERE owner_id = ${owner} AND surface = ${'memory-emission:' + offer.token}`;
                      expect(pending, JSON.stringify({ owner, token: offer.token, pending }))
                        .toMatchObject([{ fragments: [initialStagedFragment(offer.fragments[0]!)], committed: null }]);
                      expect(pending).toHaveLength(1);
                      expect(Number(pending[0]!.preparedAt)).toBeGreaterThan(0);
                      attempt.preparation = pending[0]!;
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
              expect(diagnostics.stdoutDelivery).toEqual({ adapter, owner, confirmations: [] });
              expect(echoedConfirmations).toEqual([]);
              expect(await surfaced()).toEqual([]);
              for (const observation of diagnostics.transportFaults) {
                expect(observation).toMatchObject({ method: port === 'initialize' ? 'initialize' : 'tools/call',
                  fault, closedBeforeCleanup: true, writableEnded: false });
                 if (client === 'omp' && fault === 'deadline') {
                   expect(observation).toMatchObject({ cancelledByClient: true,
                     cancellationReason: expect.stringContaining('TimeoutError') });
                   expect(diagnostics.mcpRequests).toContainEqual({ jsonrpc: '2.0',
                     method: 'notifications/cancelled', params: {
                       requestId: observation.requestId, reason: observation.cancellationReason,
                     } });
                 }
                expect(observation.elapsedMs).toBeGreaterThanOrEqual(fault === 'deadline' ? 8000 : 0);
                const offer = attempt.offers.find(row => row.token === observation.preparedToken)!;
                expect(offer?.owner).toBe(owner);
                const { rendered: fragmentText, sourceVersion: _hostSource, ...fragment } = offer.fragments[0]!;
                expect(attempt.rendered).toContain(fragmentText);
                expect(fragment).toMatchObject({ kind: source, epoch: 0, port,
                  bodySha256: createHash('sha256').update(fragmentText as string).digest('hex'),
                  bodyBytes: Buffer.byteLength(fragmentText as string) });
                const pending = await db.adminSql<{ fragments: unknown[]; committed: unknown }[]>`
                  SELECT pending -> 'fragments' AS fragments, committed FROM harness_shared.coord_read_cursors
                  WHERE owner_id = ${owner} AND surface = ${'memory-emission:' + offer.token}`;
                expect(pending, JSON.stringify({ owner, token: offer.token, pending }))
                  .toEqual([{ fragments: [initialStagedFragment(offer.fragments[0]!)], committed: null }]);
              }
              expect(await buildLaunchMemoryBlock({ ...input, session: { sessionId: owner, port: 'mid-turn' } }))
                .toContain('Only after explicit final approval ☃.');
              expect(await surfaced()).toEqual([]);
              const offer = attempt.offers[0]!;
              const { rendered: _text, sourceVersion: _hostSource, ...fragment } = offer.fragments[0]!;
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
              const otherPort = client === 'omp' ? port === 'orient' ? 'claim' : 'orient'
                : port === 'initialize' ? 'orient' : 'initialize';
              const captures = await Promise.all([runNative(false), runNative(false, otherPort)]);
              expect(overlapPrepared).toBe(2);
              expect(nativeAttempts.map(attempt => attempt.offers.length)).toEqual([1, 1]);
              expect(new Set(nativeAttempts.map(attempt => attempt.offers[0]!.token)).size).toBe(2);
              const proofs = captures.map((capture, index) => {
                expect(capture).not.toBeNull();
                const attempt = nativeAttempts[index]!;
                const offer = attempt.offers[0]!;
                const { rendered: fragmentText, sourceVersion: _hostSource, ...fragment } = offer.fragments[0]!;
                expect(attempt.rendered).toContain(fragmentText);
                expect(fragment).toMatchObject({ kind: source, epoch: 0, port: attempt.port,
                  bodySha256: createHash('sha256').update(fragmentText as string).digest('hex'),
                  bodyBytes: Buffer.byteLength(fragmentText as string) });
                const proof = { token: offer.token, fragments: [fragment] };
                expect(capture!.stdoutDelivery).toEqual({ adapter, owner, confirmations: [proof] });
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
                proof: { event: 'complete-stdout', adapter, receiptRef: `vitest:${task.name}#nativeOverlappingPorts`,
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
              expect(diagnostics.stdoutDelivery).toEqual({ adapter, owner, confirmations: [] });
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
            const { rendered: emittedFragment, sourceVersion: _hostSource, ...fragment } = offered!.fragments[0]!;
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
              if (client === 'omp') {
                expect(pipe.prefix).toContain('"type":"tool_execution_end"');
                expect(pipe.prefix).toContain('"toolName":"mcp__papercusp_su_receipt_canary"');
                expect(pipe.targetRequest.params._meta.threadId).toBe(diagnostics.nativeSessionId);
                expect(pipe.recorded).toBe(false);
              } else expect(pipe.prefix).toContain('Only after explicit final approval');
              expect(JSON.stringify(diagnostics.requests)).not.toContain('FINAL_CONDITION');
              expect(diagnostics.stdoutDelivery).toEqual({ adapter, owner, confirmations: [] });
              expect(echoedConfirmations).toEqual([]);
              expect(await surfaced()).toEqual([]);
              const retained = await db.adminSql<{ pending: { fragments: unknown[] }; committed: unknown }[]>`
                SELECT pending, committed FROM harness_shared.coord_read_cursors
                 WHERE owner_id = ${owner} AND surface = ${'memory-emission:' + offered!.token}
              `;
              expect(retained).toHaveLength(1);
              expect(retained[0]!.pending.fragments, JSON.stringify(retained))
                .toEqual([initialStagedFragment(offered!.fragments[0]!)]);
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
            expect(capture.stdoutDelivery).toEqual({ adapter, owner, confirmations: [proof] });
            expect(capture.stdoutReceipts).toHaveLength(1);
            const receipt = capture.stdoutReceipts![0]!;
            expect(receipt).toMatchObject({ stage: 'stdout-emitted', owner, token: proof.token,
              memoryFragments: [fragment] });
            expect(receipt.payloadSha256).toMatch(/^[a-f0-9]{64}$/);
            expect(receipt.payloadBytes).toBeGreaterThanOrEqual(Number(fragment.bodyBytes));
            if (fault === 'duplicate-commit' && port === 'orient') {
              const native = capture.nativeTranscript!;
              expect(native).toBeDefined();
              expect(sha256(readFileSync(native.path))).toBe(native.sourceSha256);
              const preparation = nativeAttempts[0]!.preparation!;
              expect(preparation).toBeDefined();
              expect(preparation.fragments).toEqual([initialStagedFragment(offered!.fragments[0]!)]);
              const capturedAt = new Date().toISOString();
              const diagnostics = JSON.parse(readFileSync(capture.diagnosticsPath, 'utf8'));
              const attempt = { sourceStoreId: JSON.stringify(['coord_read_cursors', owner, 'memory-emission:' + proof.token]),
                attemptId: proof.token, attemptSchemaVersion: 'memory-emission-v2', recordVersion: 0,
                createdAt: new Date(Number(preparation.preparedAt)).toISOString(), visibleAt: capturedAt,
                client, sink: port, recipient: owner, workspace: input.workspaceId, epoch: Number(fragment.epoch),
                nativeSessionId: native.nativeSessionId,
                context: { attemptId: proof.token, sessionId: owner, epoch: Number(fragment.epoch), port,
                  block: visible, fragments: [] } };
              const snapshot: FinalContextAttemptSnapshot = { schemaVersion: 'final-attempt-source-v1',
                snapshotId: capture.diagnosticsPath, sourceSchemaSha256: sha256(readFileSync(new URL('./session-epoch-ledger.ts', import.meta.url))),
                capturedAt, measuredAt: capturedAt, runtimeGeneration: capture.clientVersion,
                environmentSha256: sha256(JSON.stringify(diagnostics.invocation.environment)),
                configurationSha256: sha256(JSON.stringify(diagnostics.invocation.argv)), attempts: [attempt], receipts: [] };
              const locators = nativeMcpTranscriptLocators(capture, attempt, visible);
              expect(locators).toHaveLength(1);
              const bound = { ...native, client, recipient: owner, workspace: input.workspaceId, epoch: attempt.epoch };
              const attribution = attributeFinalContextTranscript(snapshot, bound, locators);
              expect(attribution.attributions).toMatchObject([{ status: 'observed', unknown: [], observedSha256: sha256(visible) }]);
              expect(attributeFinalContextTranscript(snapshot, { ...bound, recipient: 'foreign' }, locators)
                .attributions[0]!.status).toBe('UNKNOWN');
              expect(attributeFinalContextTranscript(snapshot, bound, [{ ...locators[0]!, callId: 'foreign' }])
                .attributions[0]!.status).toBe('UNKNOWN');
              const terminal = joinFinalContextNativeEmissions(snapshot, bound, locators, capture.stdoutEmissions ?? []);
              if (client === 'omp' || client === 'claude') {
                expect(terminal.joins).toMatchObject([{ status: 'joined', unknown: [] }]);
                expect(terminal.snapshot.receipts).toHaveLength(1);
              } else {
                expect(terminal.joins[0]!.status).toBe('UNKNOWN');
                expect(terminal.snapshot.receipts).toEqual([]);
              }
              const sample = sampleFinalDeliveredContext(terminal.snapshot);
              expect(sample).toMatchObject({ attempted: 1, usefulSuccesses: 0, usefulUnknown: 1 });
              if (client === 'omp' || client === 'claude') expect(sample.attempts[0]!.assessment.unknown).not.toContain('terminal-receipt-unmatched');
              Object.assign(task.meta, { productionLaunchNativeAttribution: { preparation, offered,
                native, receipt, snapshot, locators, attribution, terminal, sample,
                scope: 'actual PostgreSQL preparation + installed native stdout receipt + physical client JSONL; scripted local provider',
                terminalSamplerJoin: client === 'omp' || client === 'claude' ? 'joined' : 'UNKNOWN', semanticLabels: 'UNKNOWN', taskBenefit: 'UNKNOWN', shipment: 'UNKNOWN' } });
            }
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
              proof: { event: 'complete-stdout', adapter, receiptRef: `vitest:${task.name}#nativeStdoutReceipt`,
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

  for (const client of ['claude', 'codex'] as const)
    for (const source of ['memory', 'corpus'] as const)
      for (const output of ['complete', 'closed', 'partial', 'lost-response', 'deadline', 'retry', 'abandon-expiry', 'overlapping-ports'] as const)
      it(`context reliability R-1: production ${client === 'codex' ? 'Codex ' : ''}compact ${source} ${output} endpoint hook PostgreSQL join`, async ({ task }) => {
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
        // Both real compact endpoints fall back to this workspace when the
        // native request omits one. Seed and later recall in that same scope.
        const workspaceId = activeWorkspaceId();
        h.entries = source === 'memory' ? [{ id: randomUUID(), text, scope: 'u-test', score: 0.95 }] : [];
        h.corpus = source === 'corpus' ? await corpusPlanFixture(owner, text, workspaceId) : null;
        const compactFixtureScope = { workspaceId,
          sourceNamespace: h.corpus?.lines[0]?.sourceVersion?.namespace ?? null };
        Object.assign(task.meta, { compactFixtureScope });
        if (h.corpus) {
          const { revalidateKnowledgeSourceVersions } = await import('../agent-tools/search/knowledge-sources');
          const version = h.corpus.lines[0]!.sourceVersion!;
          const current = await revalidateKnowledgeSourceVersions({ sql: db.adminSql, workspaceId,
            previous: [version], audience: { harnessSlugs: ['papercusp'] }, allowed: new Set(['plan']) });
          Object.assign(task.meta, { compactCanonicalSourcePreflight: { version, current } });
          expect(current, JSON.stringify(compactFixtureScope)).toEqual([version]);
        }
        h.compactPadding = ['closed', 'partial', 'retry'].includes(output) ? 'x'.repeat(512 * 1024) : '';
        const profile = resolveLaunchProfile({ claimedItemTitles: ['zephyrrepair approval'] });
        const launchInput = { profile, workspaceId, userId: 'u-test',
          session: { sessionId: owner, port: 'turn-start' } };
        const surfaced = () => source === 'memory'
          ? db.adminSql<{ port: string; epoch: number }[]>`SELECT port, epoch FROM harness_shared.memory_session_surfaced WHERE session_id = ${owner}`
          : db.adminSql<{ port: string; epoch: number }[]>`SELECT port, epoch FROM harness_shared.corpus_session_surfaced WHERE session_id = ${owner}`;
        const responses: Array<Record<string, any>> = [];
        const endpointDiagnostics: Array<Record<string, unknown>> = [];
        Object.assign(task.meta, { compactEndpointDiagnostics: endpointDiagnostics });
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
            const context = { principal: null, input: undefined, params: {}, log: () => {}, signal: new AbortController().signal };
            const diagnostic: Record<string, unknown> = { url: req.url, fallbackWorkspaceId: activeWorkspaceId(),
              fixtureWorkspaceId: workspaceId, sourceNamespace: h.corpus?.lines[0]?.sourceVersion?.namespace ?? null };
            endpointDiagnostics.push(diagnostic);
            let response: Response;
            if (client === 'codex') {
              const chunks: Buffer[] = [];
              for await (const chunk of req) chunks.push(Buffer.from(chunk));
              const payload = Buffer.concat(chunks).toString();
              Object.assign(diagnostic, { request: JSON.parse(payload), requestWorkspace: JSON.parse(payload).workspace ?? null });
              expect(JSON.parse(payload)).toMatchObject({ owner, client, source: 'compact', memoryReceiptMode: true });
              const endpoint = identityEndpoints.find(route => route.path === '/agent-mcp/compaction-context')!;
              response = await endpoint.handler(new Request(`http://localhost${req.url}`, { method: 'POST', body: payload }), context);
            } else {
              Object.assign(diagnostic, { requestWorkspace: new URL(`http://localhost${req.url}`).searchParams.get('workspace') });
              expect(req.url).toContain('memoryReceiptMode=1');
              response = await recoveryEndpoints[0].handler(new Request(`http://localhost${req.url}`), context);
            }
            const wireBody = await response.json();
            Object.assign(diagnostic, { status: response.status, response: wireBody });
            // Normalize only the saved assertion view; each actual adapter
            // receives its production endpoint's unchanged wire response.
            const body = client === 'codex' ? { ...wireBody,
              _meta: { 'papercusp/memoryEmission': { owner, token: wireBody.deliveryToken, fragments: wireBody.memoryFragmentOffers } } }
              : wireBody;
            responses.push(body);
            const offer = body._meta?.['papercusp/memoryEmission'];
            if (output === 'complete') {
              expect(offer, JSON.stringify(diagnostic)).toMatchObject({ owner,
                fragments: [expect.objectContaining({ kind: source, epoch: 1, port: 'compact' })] });
              const { rendered: _rendered, ...fragment } = offer.fragments[0];
              const pending = await pendingFor(offer.token);
              expect(pending, JSON.stringify(pending))
                .toEqual([{ fragments: [initialStagedFragment(offer.fragments[0]) ] }]);
              expect(await surfaced()).toEqual([]);
              const cell: DeliveryMatrixCell = { client, sink: 'compact-reprime', source, fault: 'prepare',
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
              return; // Real client deadline closes this response: Codex 2.5s, generated Claude hook 4.5s.
            }
            res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(wireBody));
          })().catch(error => { errors.push(String(error)); res.destroy(); });
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Missing compact fixture address');
        const env = { PATH: process.env.PATH, LANG: process.env.LANG ?? 'C.UTF-8', HOME: home,
          PAPERCUSP_HOME: home, PAPERCUSP_SID: owner, PAPERCUSP_OPERATOR_URL: `http://127.0.0.1:${address.port}`,
          PSU_RECOVER_TEST_CHAIN: JSON.stringify([['sh', '-c', 'hook'], ['claude', '--system-prompt-file', '/fixture/playbook']]) };
        const run = async (pipe: 'complete' | 'closed' | 'partial' = 'complete') => {
          if (client === 'codex') {
            const result = await runReceiptDispatcher(dispatcherRoot, client, 'compaction', env, pipe);
            return { ...result, consumedBytes: result.partialBytes };
          }
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
            expect(await pendingFor(offer.token)).toEqual([{ fragments: [initialStagedFragment(offer.fragments[0])] }]);
            Object.assign(task.meta, { compactFailedRetry: { failed, offer, pending: await pendingFor(offer.token), suppressionWrites: 0 } });
            h.compactPadding = '';
          }
          const [result, other] = output === 'overlapping-ports'
            ? await Promise.all([run(), (async () => {
              await compactPrepared;
              return runReceiptDispatcher(dispatcherRoot, client, 'turn-start', env);
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
              if (output === 'deadline') expect(transport[0].elapsedMs).toBeGreaterThan(client === 'codex' ? 2000 : 4000);
            }
            const { rendered: _rendered, ...fragment } = offer.fragments[0];
            expect(await pendingFor(offer.token)).toEqual([{ fragments: [initialStagedFragment(offer.fragments[0])] }]);
            expect(await buildLaunchMemoryBlock(launchInput)).toContain('Only after explicit final approval ☃.');
          } else {
            const { rendered, sourceVersion: _hostSource, ...fragment } = offer.fragments[0];
            expect(result.stdout).not.toContain('papercusp/memoryEmission');
            expect(JSON.parse(result.stdout).hookSpecificOutput.additionalContext).toContain(rendered);
            const compactProof = { token: offer.token, fragments: [fragment] };
            if (other) {
              expect(overlapPrepared).toBe(2); expect(otherOffers).toHaveLength(1);
              expect(other.signal, other.stderr).toBeNull(); expect(other.code, other.stderr).toBe(0);
              expect(other.stdout).toContain('Only after explicit final approval ☃.');
              expect(proofs).toHaveLength(2);
              const { rendered: _otherRendered, sourceVersion: _otherHostSource, ...otherFragment } = otherOffers[0].fragments[0];
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
              const pending = await pendingFor(offer.token);
              Object.assign(task.meta, { compactExpiredPending: pending });
              expect(pending, JSON.stringify(pending))
                .toEqual([{ fragments: [initialStagedFragment(offer.fragments[0])] }]);
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
            const cell: DeliveryMatrixCell = { client, sink, source,
              fault: output === 'complete' ? 'duplicate-commit' : output === 'partial' ? 'partial-stdout' : output,
              selector: task.name, evidenceRefs: [`vitest:${task.name}#compactEndpointJoin`],
              terminalOracle: 'complete-stdout', state: emitted ? 'emitted' : output === 'partial' ? 'partial' : output === 'abandon-expiry' ? 'abandoned' : 'prepared',
              verdict: 'passed', suppressionWrites: emitted ? 1 : 0,
              attempt: { id: owner, recipient: owner, workspace: 'isolated-org-fixture', epoch,
                token: offer.token, fragment },
              ...(emitted ? { proof: { event: 'complete-stdout' as const, adapter: `${client}-session-start`,
                receiptRef: `vitest:${task.name}#compactImmutableReceipt`, attemptId: owner, recipient: owner,
                workspace: 'isolated-org-fixture', epoch, token: offer.token, client, sink,
                payloadSha256: createHash('sha256').update(result.stdout).digest('hex'),
                payloadBytes: Buffer.byteLength(result.stdout), fragment } } : {}) };
            joinedCells.set(deliveryMatrixCellKey(cell), cell);
            Object.assign(task.meta, { deliveryMatrixCell: cell });
          }
          Object.assign(task.meta, { compactEndpointJoin: { client, source, output, offer, proofs,
            ...(client === 'claude' ? { generatedHookSha256: createHash('sha256').update(RECOVER_HOOK_SOURCE).digest('hex') } : {}),
            ledgerSourceSha256: createHash('sha256').update(ledgerSource).digest('hex'),
            evidencePlane: `real compact endpoint + ${client === 'claude' ? 'generated SessionStart' : 'Codex dispatcher'} subprocess + production PostgreSQL`,
            retrieval: 'deterministic fixture', clientHostConsumption: 'UNKNOWN', deployedRuntime: 'UNKNOWN',
            backendConfirmation: 'explicit saved native receipt replay' } });
        } finally {
          h.entries = savedEntries; h.corpus = null; h.compactPadding = '';
          server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
          rmSync(home, { recursive: true, force: true });
        }
      }, 45_000);

  for (const source of ['memory', 'corpus'] as const)
    for (const output of ['complete', 'closed', 'partial'] as const)
      it(`context reliability R-1: Codex compact ${source} ${output} real endpoint PostgreSQL join`, async ({ task }) => {
        const owner = `su-codex-compact-${randomUUID()}`;
        const home = mkdtempSync(join(tmpdir(), 'codex-compact-pg-'));
        const savedEntries = h.entries;
        const text = 'Apply zephyrrepair recovery.\nOnly after explicit final approval ☃.';
        h.entries = source === 'memory' ? [{ id: randomUUID(), text, scope: 'u-test', score: 0.95 }] : [];
        const selected = selectCorpusLines({ queryText: 'zephyrrepair', budgetChars: 3000,
          hits: [{ source: 'plan', sourceId: `codex-compact:${owner}`, excerpt: text, meta: { contextUnit: text }, score: 0.95 }] });
        h.corpus = source === 'corpus' ? { ...selected, block: renderCorpusBlock(selected.lines), outcome: 'ok',
          embedderAvailable: true, candidateCount: 1, legs: null, retrievalDepth: 1, rerank: 'nothing-to-reorder' } : null;
        h.compactPadding = output === 'partial' ? 'x'.repeat(512 * 1024) : '';
        const errors: string[] = [], responses: Array<Record<string, any>> = [];
        const endpoint = identityEndpoints.find(route => route.path === '/agent-mcp/compaction-context')!;
        const server = createServer((req, res) => {
          void (async () => {
            const chunks: Buffer[] = [];
            for await (const chunk of req) chunks.push(Buffer.from(chunk));
            const payload = Buffer.concat(chunks).toString();
            expect(JSON.parse(payload)).toMatchObject({ owner, client: 'codex', source: 'compact', memoryReceiptMode: true });
            const response = await endpoint.handler(new Request(`http://localhost${req.url}`, { method: 'POST', body: payload }),
              { principal: null, input: undefined, params: {}, log: () => {}, signal: new AbortController().signal });
            const body = await response.json(); responses.push(body);
            res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body));
          })().catch(error => { errors.push(String(error)); res.destroy(); });
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Missing Codex compact fixture address');
        const env = { PATH: process.env.PATH, HOME: home, PAPERCUSP_HOME: home, PAPERCUSP_SID: owner,
          PAPERCUSP_OPERATOR_URL: `http://127.0.0.1:${address.port}` };
        const surfaced = () => source === 'memory'
          ? db.adminSql<{ port: string; epoch: number }[]>`SELECT port, epoch FROM harness_shared.memory_session_surfaced WHERE session_id = ${owner}`
          : db.adminSql<{ port: string; epoch: number }[]>`SELECT port, epoch FROM harness_shared.corpus_session_surfaced WHERE session_id = ${owner}`;
        try {
          const result = await runReceiptDispatcher(dispatcherRoot, 'codex', 'compaction', env, output);
          expect(result.signal, result.stderr).toBeNull(); expect(result.code, result.stderr).toBe(0);
          expect(errors).toEqual([]); expect(responses).toHaveLength(1);
          const body = responses[0];
          expect(body.text).toContain('IDENTITY COMPACTION');
          expect(body.text).toContain('Only after explicit final approval ☃.');
          expect(body.deliveryToken).toBeTypeOf('string');
          expect(body.memoryFragmentOffers).toEqual([expect.objectContaining({ kind: source, epoch: 1, port: 'compact' })]);
          const { rendered: _rendered, ...fragment } = body.memoryFragmentOffers[0];
          expect(await surfaced()).toEqual([]);
          const pending = await db.adminSql`SELECT pending -> 'fragments' AS fragments FROM harness_shared.coord_read_cursors
            WHERE owner_id = ${owner} AND surface = ${'memory-emission:' + body.deliveryToken}`;
          expect(pending, JSON.stringify(pending))
            .toEqual([{ fragments: [initialStagedFragment(body.memoryFragmentOffers[0])] }]);
          const proofs = openDeliveryLedger(owner, env, 'compact')!.confirmedMemoryDeliveries();
          if (output === 'complete') {
            expect(result.stdout).toContain('Only after explicit final approval ☃.');
            const { sourceVersion: _hostSource, ...nativeFragment } = fragment;
            const compactProof = { token: body.deliveryToken, fragments: [nativeFragment] };
            expect(proofs).toEqual([compactProof]);
            const receiptPath = join(ledgerDir(env), `${owner}.compact.emissions`,
              createHash('sha256').update(body.deliveryToken).digest('hex') + '.json');
            const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
            expect(receipt).toMatchObject({ owner, stage: 'stdout-emitted', memoryFragments: [nativeFragment],
              payloadSha256: createHash('sha256').update(result.stdout).digest('hex'), payloadBytes: Buffer.byteLength(result.stdout) });
            Object.assign(task.meta, { codexCompactImmutableReceipt: receipt });
            // Explicit replay establishes the PG join; installed-host consumption remains unmeasured.
            await withMemoryEmissionReceipt(db.adminSql as never, owner, proofs, async () => ({ content: [] }));
            expect(await surfaced()).toEqual([{ port: 'compact', epoch: 1 }]);
            expect(await confirmMemoryEmission(db.adminSql as never, owner, compactProof)).toBe(0);
          } else {
            expect(proofs).toEqual([]);
            if (output === 'partial') {
              expect(result.partialBytes).toBeGreaterThan(0);
              expect(result.partialBytes).toBeLessThan(Buffer.byteLength(body.text));
            }
          }
          const eligible = await buildLaunchMemoryBlock({ profile: resolveLaunchProfile({ claimedItemTitles: ['zephyrrepair approval'] }),
            workspaceId: 'ws-test', userId: 'u-test', session: { sessionId: owner, port: 'turn-start' } });
          if (output === 'complete') expect(eligible).toBeNull();
          else { expect(eligible).toContain('Only after explicit final approval ☃.'); expect(await surfaced()).toEqual([]); }
          Object.assign(task.meta, { codexCompactEndpointJoin: { source, output, body, proofs, result,
            evidencePlane: 'real Codex compact endpoint + dispatcher subprocess + production PostgreSQL',
            identityAndRetrieval: 'deterministic fixture', clientHostConsumption: 'UNKNOWN',
            backendConfirmation: output === 'complete' ? 'explicit saved stdout receipt replay' : 'none' } });
        } finally {
          h.entries = savedEntries; h.corpus = null; h.compactPadding = '';
          server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
          rmSync(home, { recursive: true, force: true });
        }
      }, 45_000);

  for (const kind of ['memory', 'corpus'] as const)
    it(`context reliability R-2: same-source-revision cross-port ${kind}`, async ({ task }) => {
      const savedEntries = h.entries, savedCorpus = h.corpus;
      const owner = `r2-cross-port-${randomUUID()}`;
      const text = 'zephyrrepair requires independent approval before execution';
      try {
        h.entries = kind === 'memory' ? [{ id: randomUUID(), text, scope: 'u-test', score: 0.95 }] : [];
        h.corpus = kind === 'corpus' ? await corpusPlanFixture(owner, text) : null;
        const prepare = (port: string) => prepareMemoryContextBlock({ userId: 'u-test',
          workspaceId: 'ws-test', harnessSlugs: ['papercusp'], queryContext: 'zephyrrepair approval',
          budgetChars: 3000, session: { sessionId: owner, port } });
        const rows = () => kind === 'memory'
          ? db.adminSql`SELECT epoch, port, source_fingerprint FROM harness_shared.memory_session_surfaced WHERE session_id = ${owner} ORDER BY epoch`
          : db.adminSql`SELECT epoch, port, source_fingerprint FROM harness_shared.corpus_session_surfaced WHERE session_id = ${owner} ORDER BY epoch`;
        const manifest = ({ rendered: _text, sourceVersion: _source, revalidateSource: _read, ...row }:
          ReturnType<typeof memoryFragmentOffer>) => row;
        const first = await prepare('turn-start');
        expect(first?.text).toContain(text);
        expect(first?.fragments).toHaveLength(1);
        const fragment = first!.fragments[0]!;
        expect(fragment).toMatchObject({ kind, epoch: 0, port: 'turn-start',
          sourceFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) });
        expect(fragment.revalidateSource).toBeTypeOf('function');
        await stageMemoryEmission(db.adminSql as never, owner, 'initial', first!.fragments);
        expect(await rows()).toEqual([]);
        // A prepared response does not consume the revision on another port.
        expect((await prepare('orient'))?.fragments[0]?.sourceFingerprint).toBe(fragment.sourceFingerprint);
        expect(await confirmMemoryEmission(db.adminSql as never, owner, {
          token: 'initial', fragments: first!.fragments.map(manifest) })).toBe(1);
        for (const port of ['orient', 'mid-turn', 'initialize']) expect(await prepare(port)).toBeNull();
        const initialRows = await rows();
        expect(initialRows).toEqual([{ epoch: 0, port: 'turn-start', source_fingerprint: fragment.sourceFingerprint }]);
        // Exercise the actual epoch transition rather than supplying epoch+1.
        expect(await bumpSessionEpoch(db.adminSql as never, owner)).toBe(1);
        const next = await prepare('compact');
        expect(next?.text).toContain(text);
        expect(next?.fragments).toHaveLength(1);
        expect(next!.fragments[0]).toMatchObject({ kind, epoch: 1, port: 'compact',
          sourceFingerprint: fragment.sourceFingerprint });
        await stageMemoryEmission(db.adminSql as never, owner, 'reprime', next!.fragments);
        expect(await confirmMemoryEmission(db.adminSql as never, owner, {
          token: 'reprime', fragments: next!.fragments.map(manifest) })).toBe(1);
        expect(await prepare('mid-turn')).toBeNull();
        const finalRows = await rows();
        expect(finalRows).toEqual([...initialRows,
          { epoch: 1, port: 'compact', source_fingerprint: fragment.sourceFingerprint }]);
        Object.assign(task.meta, { sourceRevisionCrossPort: { kind, selector: task.name,
          sourceVersion: fragment.sourceVersion, initialRows, finalRows,
          suppressedPorts: ['orient', 'mid-turn', 'initialize'], epochTransition: 'bumpSessionEpoch',
          evidencePlane: 'production-builder-and-postgresql-with-fixture-retrieval-and-supplied-receipts',
          nativeEmission: 'UNKNOWN', clientCompaction: 'UNKNOWN' } });
      } finally { h.entries = savedEntries; h.corpus = savedCorpus; }
    }, 120_000);

  for (const kind of ['memory', 'corpus'] as const) for (const change of ['update', 'retraction'] as const)
    it(`context reliability R-2: canonical ${kind} ${change} without a retrieval hit`, async ({ task }) => {
      const savedEntries = h.entries, savedCorpus = h.corpus, savedCanonical = h.canonicalEntries;
      const owner = `r2-lifecycle-${randomUUID()}`;
      const text = 'zephyrrepair private guidance requires approval before execution';
      const revised = 'zephyrrepair private guidance requires independent approval before execution';
      try {
        const entry = { id: randomUUID(), text, scope: 'u-test', score: 0.95,
          metadata: { revision: 'r1', validity: { status: 'current' } } };
        h.entries = kind === 'memory' ? [entry] : [];
        h.canonicalEntries = null;
        h.corpus = kind === 'corpus' ? await corpusPlanFixture(owner, text) : null;
        const prepare = (port: string) => prepareMemoryContextBlock({ userId: 'u-test',
          workspaceId: 'ws-test', harnessSlugs: ['papercusp'], queryContext: 'zephyrrepair approval',
          budgetChars: 3000, session: { sessionId: owner, port } });
        const rows = () => kind === 'memory'
          ? db.adminSql`SELECT source_fingerprint, source_version FROM harness_shared.memory_session_surfaced WHERE session_id = ${owner}`
          : db.adminSql`SELECT source_fingerprint, source_version FROM harness_shared.corpus_session_surfaced WHERE session_id = ${owner}`;
        const makeDue = () => kind === 'memory'
          ? db.adminSql`UPDATE harness_shared.memory_session_surfaced SET source_checked_at = now() - interval '2 minutes' WHERE session_id = ${owner}`
          : db.adminSql`UPDATE harness_shared.corpus_session_surfaced SET source_checked_at = now() - interval '2 minutes' WHERE session_id = ${owner}`;
        const manifest = ({ rendered: _text, sourceVersion: _source, revalidateSource: _read, ...row }:
          ReturnType<typeof memoryFragmentOffer>) => row;
        const initial = await prepare('turn-start');
        expect(initial?.fragments).toHaveLength(1);
        const previous = initial!.fragments[0]!;
        await stageMemoryEmission(db.adminSql as never, owner, 'initial', initial!.fragments);
        expect(await confirmMemoryEmission(db.adminSql as never, owner, {
          token: 'initial', fragments: initial!.fragments.map(manifest) })).toBe(1);
        const before = await rows();
        // Keep the canonical authority available after removing every search hit.
        h.entries = [];
        h.corpus = null;
        if (kind === 'memory') h.canonicalEntries = [{ ...entry, text: revised,
          metadata: { revision: 'r2', validity: { status: change === 'update' ? 'current' : 'retracted' } } }];
        else await db.adminSql`UPDATE harness_shared.harness_plans
          SET content = ${revised}, archived = ${change === 'retraction'}, updated_at = updated_at + interval '1 second'
          WHERE workspace_id = 'ws-test' AND harness_slug = 'papercusp' AND plan_slug = ${`receipt-${owner}`}`;
        await expect(stageMemoryEmission(db.adminSql as never, owner, 'stale', initial!.fragments))
          .rejects.toThrow('Memory emission source changed or is unavailable');
        await makeDue();
        const changed = await prepare('mid-turn');
        expect(changed?.text).toContain(change === 'update' ? 'replace-earlier-version' : 'withdraw-earlier-version');
        expect(changed?.text).not.toContain('private guidance');
        expect(changed?.fragments).toHaveLength(1);
        const current = changed!.fragments[0]!;
        expect(current).toMatchObject({ kind, id: previous.id, epoch: 0, port: 'mid-turn',
          sourceVersion: { namespace: previous.sourceVersion!.namespace,
            validity: { status: change === 'update' ? 'current' : 'retracted' } } });
        expect(current.sourceFingerprint).not.toBe(previous.sourceFingerprint);
        expect(await rows()).toEqual(before);
        await stageMemoryEmission(db.adminSql as never, owner, 'changed', changed!.fragments);
        expect(await rows()).toEqual(before);
        expect(await confirmMemoryEmission(db.adminSql as never, owner, {
          token: 'changed', fragments: changed!.fragments.map(manifest) })).toBe(1);
        const after = await rows();
        expect(after).toEqual([{ source_fingerprint: current.sourceFingerprint, source_version: current.sourceVersion }]);
        await makeDue();
        expect(await prepare('orient')).toBeNull();
        Object.assign(task.meta, { sourceRevisionLifecycle: { kind, change, selector: task.name,
          previous: previous.sourceVersion, current: current.sourceVersion, before, after,
          retrievalHits: 0, stalePreparationRejected: true, preparationWrites: 0, confirmationWrites: 1,
          evidencePlane: 'production-builder-and-postgresql-with-fixture-memory-backend-and-supplied-receipts',
          corpusAuthority: kind === 'corpus' ? 'canonical-postgresql-plan-row' : 'not-applicable',
          nativeEmission: 'UNKNOWN' } });
      } finally { h.entries = savedEntries; h.corpus = savedCorpus; h.canonicalEntries = savedCanonical; }
    }, 120_000);

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
    expect(joinedCells.size).toBe(304);
    expect(cells).toHaveLength(432);
    // Structural fixture identity only; acceptance binds separately retained
    // plan/rubric/spec/runtime identities and independent evidence later.
    const manifest = { schemaVersion: 'delivery-matrix-v1' as const,
      identity: { planRevision: 1, rubricRevision: 1, planHash: '1'.repeat(64), rubricHash: '2'.repeat(64),
        barHash: '3'.repeat(64), specHash: '4'.repeat(64), sourceHash: '5'.repeat(64), testHash: '6'.repeat(64),
        runtimeGeneration: 'isolated-postgresql-dispatcher-fixture' }, cells };
    const result = validateDeliveryMatrix(manifest);
    expect(result).toMatchObject({ closed: true, valid: true, acceptanceReady: false, errors: [] });
    expect(result.unknown).toHaveLength(128);
    Object.assign(task.meta, { deliveryMatrixCensus: { manifest, result,
      identityKind: 'structural fixture only; independent acceptance and shipment not asserted' } });
  });
});
