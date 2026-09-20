/**
 * Unit tests for POST /api/agent-mcp/console/bootstrap-su.
 *
 * Drives the route handler directly with a hand-built RouteContext and
 * mocks the heavy leaves (auth, envelope, session writer, buildLaunchSpec,
 * writeSuCodexHome). Asserts the P-020 raw-CLI result shape: a promptFile
 * (claude/omp) or codexHome (codex) + a per-session PAPERCUSP_SID (P-022),
 * NOT a `*-su` wrapper.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentFleetRecord } from '../../agent-fleets-store';
import type { RouteContext } from '../define-route';
import { renderSessionPortSeed } from '../../session-port/render';

// Redirect the launch-context file writes to a throwaway temp dir so the
// route's best-effort persistence doesn't touch the real ~/.papercusp.
const LC_DIR = mkdtempSync(join(tmpdir(), 'bootstrap-su-lc-'));
process.env.PAPERCUSP_LAUNCH_CONTEXT_DIR = LC_DIR;
// A real coord-extension file so coordExtPath resolves deterministically.
const COORD_EXT = join(LC_DIR, 'papercusp-coord.ts');
writeFileSync(COORD_EXT, '// coord ext');
const SESSION_PORT_ARTIFACT = renderSessionPortSeed({
  portId: '22222222-2222-4222-8222-222222222222',
  sourceBackend: 'claude',
  targetBackend: 'codex',
  fidelity: 'full',
  transcript: 'ported history',
});
const SESSION_PORT_ID = '22222222-2222-4222-8222-222222222222';
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const sessionPortRow = (overrides: Record<string, unknown> = {}) => ({
  id: SESSION_PORT_ID,
  workspaceId: 'default',
  idempotencyKey: 'logical-request-hash',
  retryOfPortId: null,
  protocolVersion: 2,
  status: 'prepared',
  sourceAdvSessionId: 9,
  targetAdvSessionId: null,
  sourceBackend: 'claude',
  targetBackend: 'codex',
  targetModel: 'gpt-5.5',
  tokenHash: 'token-hash',
  artifactPath: '/managed/222.seed.md',
  expiresAt: '2099-01-01T00:00:00.000Z',
  sourceHash: 'source-hash',
  normalizedHash: 'normalized-hash',
  renderedHash: SESSION_PORT_ARTIFACT.hash,
  preparedAt: '2026-07-14T00:00:00.000Z',
  pendingAt: null,
  deliveredAt: null,
  failedAt: null,
  error: null,
  metadata: {
    sourceCoordOwnerId: 'su-source-owner',
    estimatedTokens: 10,
    summary: {
      protocolVersion: 2,
      source: {
        backend: 'claude',
        workspaceId: 'default',
        advSessionId: 9,
        nativeSessionId: 'source-native',
        cwd: '/workspace',
        harnessSlug: null,
        planSlug: null,
        snapshot: {
          kind: 'live-jsonl',
          highWaterBytes: 1,
          completeBytes: 1,
          sha256: 'source-hash',
          archiveRelpath: null,
        },
      },
      target: {
        backend: 'codex',
        provider: 'openai',
        model: 'gpt-5.5',
        account: 'default',
        contextWindow: 200_000,
        availableInputTokens: 100_000,
        contextSize: 'trimmed',
        launchContextHash: EMPTY_SHA256,
      },
      fidelity: 'full',
      versions: { transform: 3, summaryPrompt: null },
      stats: { omittedAttachments: 0, unsupportedBlocks: 0, redactions: 0 },
      summary: null,
    },
  },
  ...overrides,
});

const recordAdvSessionMock = vi.fn(async (_opts: unknown) => 42 as number | null);
const buildLaunchSpecMock = vi.fn(async (_input: any) => ({
  kind: 'su',
  role: 'su',
  runId: 'run-1',
  spawnId: 'spawn-1',
  harnessSlug: _input.harnessSlug ?? null,
  featureId: null,
  cwd: '/ignored-by-bootstrap',
  promptText: 'PLAYBOOK + CTX BODY',
  promptFile: '/prompts/papercusp-su-engineer.tools.md',
  mcpUrl: 'http://localhost:3070/api/mcp?superuser=1&workspace=default',
  mcpJsonContents: '{}',
  stack: _input.stack ?? [],
}));
const compileLaunchSpecificationArtifactMock = vi.fn(async (input: any) => ({
  promptText: input.promptText,
  stack: input.stack ?? [],
  specificationArtifact: {},
  specificationRevision: 'a'.repeat(64),
  stateRevision: input.stateRevision ?? 'b'.repeat(64),
  compositionSource: 'compatibility' as const,
}));
const writeSuCodexHomeMock = vi.fn((opts: any) => ({
  codexHome: `/fake/.papercusp/su-codex-homes/session-${opts.sessionKey}`,
  agentsPath: `/fake/.papercusp/su-codex-homes/session-${opts.sessionKey}/AGENTS.md`,
  configPath: `/fake/.papercusp/su-codex-homes/session-${opts.sessionKey}/config.toml`,
}));
const rekeyCodexHomeMock = vi.fn((_source: string | number, target: string | number) =>
  `/fake/.papercusp/su-codex-homes/session-${target}`,
);
// EI-155: the interactive-claude config-dir materializer. Mocked so the unit
// test never touches the dev box's real ~/.claude (the materializer's own
// symlink-farm behavior is covered by interactive-claude-config.test.ts).
const writeInteractiveClaudeConfigMock = vi.fn((opts: { sid: string }) => ({
  configDir: `/fake/.papercusp/session-claude/${opts.sid}`,
}));
const claimAgentLaunchMock = vi.fn(
  async (_opts: unknown): Promise<{
    won: boolean;
    priorSummary: Record<string, unknown> | null;
    priorLaunchedAt: number | null;
    priorLaunchedBy: string | null;
  }> => ({
    won: true,
    priorSummary: null,
    priorLaunchedAt: null,
    priorLaunchedBy: null,
  }),
);
const recordAgentLaunchResultMock = vi.fn(async (_opts: unknown) => undefined);
const releaseAgentLaunchClaimMock = vi.fn(async (_opts: unknown) => true);
const getSessionPortMock = vi.fn(async (_id: string, _workspaceId: string) => null as any);
const reserveSessionPortTargetMock = vi.fn(async (input: any) => ({
  status: 'reserved' as const,
  targetAdvSessionId: 42,
  port: sessionPortRow({
    id: input.portId,
    workspaceId: input.workspaceId,
    status: 'pending',
    targetAdvSessionId: 42,
  }),
}));
/** The fields this handler path actually reads off a bootstrap disposition. Declared
 * explicitly so a fixture below is checked against it instead of being cast past the
 * type system — the real `SessionPortBootstrapDisposition` additionally carries `port`,
 * which this route never reads, so the double deliberately narrows rather than inventing
 * a fake row. */
type BootstrapDispositionDouble =
  | { status: 'in_progress'; targetAdvSessionId: number }
  | { status: 'replay'; targetAdvSessionId: number; receipt: Record<string, unknown> };
const readSessionPortBootstrapDispositionMock = vi.fn(
  async (_input: unknown): Promise<BootstrapDispositionDouble> => ({
    status: 'in_progress',
    targetAdvSessionId: 42,
  }),
);
const recordSessionPortBootstrapReceiptMock = vi.fn(async (_input: unknown) => undefined);
const failSessionPortTargetReservationMock = vi.fn(async (_input: unknown) => true);
const readSessionPortArtifactMock = vi.fn(async (_port: unknown) => SESSION_PORT_ARTIFACT.seed);
const recordSessionPortTelemetryMock = vi.fn(async (_event: unknown) => true);

vi.mock('../../auth/require-principal', () => ({
  requirePrincipal: vi.fn(async () => {}),
  PrincipalCheckError: class PrincipalCheckError extends Error {
    status = 401;
    reason = 'denied';
  },
}));
vi.mock('../../workspace-registry', () => ({
  activeWorkspaceId: () => 'default',
  readRegistry: () => ({
    current: 'default',
    workspaces: [
      { id: 'default', name: 'Default' },
      { id: 'ws2', name: 'Second' },
    ],
  }),
  // Sparse-registry reality (fresh packaged install): the literal 'default' fallback is
  // NOT listed as a concrete entry, so workspaceById('default') is undefined — but
  // isKnownWorkspace treats 'default' as always-valid (its sentinel branch). The
  // bootstrap routes MUST validate with isKnownWorkspace, not workspaceById, or they
  // 400 `unknown workspace: default` on the exact value activeWorkspaceId() produces
  // (WI-3234).
  workspaceById: (id: string) => (id === 'ws2' ? { id, name: id } : undefined),
  isKnownWorkspace: (id: string) => !!id?.trim() && (id === 'default' || id === 'ws2'),
}));
vi.mock('../../console-launcher', () => ({
  buildConsoleEnvelope: vi.fn(async (o: { slug: string | null }) => ({
    cwd: o.slug ? `/proj/${o.slug}` : '/workspace',
    env: { PAPERCUSP_OPERATOR_URL: 'http://localhost:3070', ...(o.slug ? { PAPERCUSP_HARNESS_SLUG: o.slug } : {}) },
    mcpJsonContents: '',
    greetingCmd: '',
    needsSuperuserBootstrap: false,
    mode: 'shell',
  })),
}));
// Must enumerate EVERY export bootstrap-su.ts imports from adv-sessions: a factory
// mock replaces the whole module, so an export the subject imports but this omits
// throws "No <name> export is defined on the mock" the moment that code path runs —
// silently at author time, loudly in the gate hours later (WI-7185).
// EI-21365235532676472: named handle so the reclaim assertions below can inspect
// exactly how stranded bindings were stamped.
const markAdvSessionEndedMock = vi.fn(
  async (
    _id: number,
    _exitCode: number | null,
    _endedBy: string,
    _opts?: { signal?: string | null; throwOnError?: boolean },
  ) => {},
);
vi.mock('../../adv-sessions', async (orig) => ({ ...(await orig<typeof import('../../adv-sessions')>()), endedRecordedOwnerIds: vi.fn(async () => new Set<string>()),
  recordAdvSession: recordAdvSessionMock,
  markAdvSessionEnded: (...a: unknown[]) =>
    markAdvSessionEndedMock(
      ...(a as [number, number | null, string, { signal?: string | null; throwOnError?: boolean }?]),
    ),
  claimAdvSessionResume: vi.fn(async () => false),
  reanchorAdvSessionNativeId: vi.fn(async () => ({ reanchored: true, owner: null })),
  reanchorAdvSessionNativeIdByOwner: vi.fn(async () => ({ reanchored: true, owner: null })),
  recordSuLaunchSpec: vi.fn(async () => true),
}));
vi.mock('../../agent-tools/coordination/control-anchor', () => ({
  requestSessionIdentityActivation: vi.fn(async () => ({ generation: 1 })),
}));
vi.mock('../../session-port/store', () => ({
  assertSessionPortStorageReady: vi.fn(async () => undefined),
  getSessionPort: (...a: unknown[]) => getSessionPortMock(...(a as [any, any])),
  sessionPortBootstrapLedgerKey: (portId: string) => `bootstrap-su:session-port:${portId}`,
  reserveSessionPortTarget: (...a: unknown[]) => reserveSessionPortTargetMock(...(a as [any])),
  readSessionPortBootstrapDisposition: (...a: unknown[]) => readSessionPortBootstrapDispositionMock(...(a as [any])),
  recordSessionPortBootstrapReceipt: (...a: unknown[]) => recordSessionPortBootstrapReceiptMock(...(a as [any])),
  failSessionPortTargetReservation: (...a: unknown[]) => failSessionPortTargetReservationMock(...(a as [any])),
}));
vi.mock('../../session-port/telemetry', () => ({
  recordSessionPortTelemetry: (...a: unknown[]) => recordSessionPortTelemetryMock(...(a as [any])),
}));
vi.mock('../../session-port/artifact', () => ({
  parsePortToken: (token: string) =>
    token.startsWith('22222222-2222-4222-8222-222222222222.')
      ? { portId: '22222222-2222-4222-8222-222222222222', secret: token.split('.')[1] }
      : null,
  readSessionPortArtifact: (...a: unknown[]) => readSessionPortArtifactMock(...(a as [any])),
  verifyPortToken: () => true,
}));
// launch-wakeability: the route arms the standing inbox-wake at launch (right after
// recordAdvSession) so the session is parked/wakeable before its first turn. Mock it
// to keep the unit test hermetic (the real one pulls the await engine + PG) and to
// assert it's armed for the minted sid.
const armInboxWakeMock = vi.fn(async (_opts: unknown) => ({ awaitId: 1, eventKey: 'coord:inbox-wake:x', handleNote: 'n' }));
vi.mock('../../events/await/inbox-wake-arm', () => ({
  armInboxWake: (...a: unknown[]) => armInboxWakeMock(...(a as [any])),
}));
// WI-20241317226471456: bootstrap-su's launch-time implication repair is a
// best-effort integration side effect. Keep this unit suite hermetic by
// replacing the PG-backed reconciler with a deterministic no-op.
const reconcileImpliedModesMock = vi.fn(async () => [] as Array<{ status: string }>);
vi.mock('../../modes/store', () => ({
  reconcileImpliedModes: (...a: unknown[]) => reconcileImpliedModesMock(...(a as [])),
}));
vi.mock('../../role-launch-spec', () => ({
  buildLaunchSpec: (...args: unknown[]) => buildLaunchSpecMock(...(args as [any])),
  compileLaunchSpecificationArtifact: (...args: unknown[]) =>
    compileLaunchSpecificationArtifactMock(...(args as [any])),
}));
vi.mock('../../agent-launch-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../agent-launch-core')>()),
  claimAgentLaunch: (...args: unknown[]) => claimAgentLaunchMock(...(args as [any])),
  recordAgentLaunchResult: (...args: unknown[]) =>
    recordAgentLaunchResultMock(...(args as [any])),
  releaseAgentLaunchClaim: (...args: unknown[]) =>
    releaseAgentLaunchClaimMock(...(args as [any])),
}));
vi.mock('../../role-codex-home', () => ({
  writeSuCodexHome: (...args: unknown[]) => writeSuCodexHomeMock(...(args as [any])),
  rekeyCodexHome: (...args: unknown[]) => rekeyCodexHomeMock(...(args as [any, any])),
}));
vi.mock('../../interactive-claude-config', () => ({
  writeInteractiveClaudeConfig: (...args: unknown[]) => writeInteractiveClaudeConfigMock(...(args as [any])),
}));
// The bootstrap handler fires a best-effort saved-prompts materialize side
// effect; this unit test isn't exercising it (the materialize integration test
// is), and running it for real would query the DB + write/prune the dev box's
// ~/.claude/commands. No-op it here.
vi.mock('../../saved-prompts-materialize', () => ({
  materializeWorkspacePrompts: vi.fn(async () => ({ written: 0, skipped: 0 })),
  materializeHarnessPrompts: vi.fn(async () => ({ written: 0, skipped: 0 })),
  materializeCodexPrompts: vi.fn(async () => ({ written: 0, skipped: 0 })),
}));
vi.mock('../../desktop-install/papercusp-files', () => ({
  resolveInstallPaths: () => ({ extensionPath: COORD_EXT }),
}));
vi.mock('../../superuser-token', () => ({
  readSuperuserToken: () => 'TESTBEARER',
}));
// D-013 brain pin: mock the old PG-backed pointer so retired paths can assert
// they do not touch it.
// EI-908: setBrainSession is workspace-scoped — (workspaceId, nativeSessionId).
const setBrainSessionMock = vi.fn(async (_ws: string, _id: string) => {});
const getBrainSessionMock = vi.fn(async (): Promise<string | null> => null);
vi.mock('../../brain-pin', () => ({
  setBrainSession: (...a: unknown[]) => setBrainSessionMock(...(a as [string, string])),
  getBrainSession: () => getBrainSessionMock(),
}));
// Account routing tests also use feature flags. importActual keeps the rest of
// flags/server real.
const getFlagMock = vi.fn(async (_key: string, _scope: string): Promise<boolean> => false);
vi.mock('@papercusp/flags/server', async (importActual) => ({
  ...(await importActual<typeof import('@papercusp/flags/server')>()),
  getFlag: (...a: unknown[]) => getFlagMock(...(a as [string, string])),
}));
// Old brain-brief dependencies remain mocked so tombstone tests can prove the
// retired launch path exits before computing a brief.
const listStartedHivesMock = vi.fn(async () => [{ workspaceId: 'default', installSlug: 'papercup' }]);
vi.mock('../../pot/started', () => ({ listStartedHives: (...a: unknown[]) => listStartedHivesMock(...(a as [])) }));
// P-059: the sibling `pot/mug-brief-launch` stub is gone with the module. It was
// already inert — it mocked `computeQueenWakeBrief`, which the module stopped
// exporting at the queen→mug rename, so the mock backed no real import.
vi.mock('../../device-harnesses', () => ({
  listHarnessesFor: vi.fn(async () => [
    {
      slug: 'papercup',
      path: '/repo',
      harness_kind: null,
      has_state: true,
      status: 'active',
      iteration: 1,
      last_active_ts: null,
    },
  ]),
}));
vi.mock('../../agent-tools/plans/source', () => ({
  resolveHarnessPlansDir: vi.fn(async () => ({
    harnessSlug: 'papercup',
    plans: '/repo/plans',
    archive: '/repo/plans/archive',
  })),
  listPlanFiles: vi.fn(async () => [
    { slug: 'plan-a', filePath: '/repo/plans/plan-a.md', archived: false },
    { slug: 'plan-archived', filePath: '/repo/plans/archive/plan-archived.md', archived: true },
  ]),
  readPlanBySlug: vi.fn(async () => ({
    parsed: { now: { state: 'do X', next: 'then Y' }, frontmatter: { title: 'My Plan' } },
    archived: false,
  })),
}));
// psu-account-chooser P-002: resolveAccountPin reads the pool + the session-override,
// but ONLY when the gateway flag is on. Mock both so the gateway-ON branches are
// DB-free + deterministic (the gateway-OFF + no-account branches return before them).
type MockPoolAccount = { id: string; provider?: 'claude' | 'codex' };
const loadAccountPoolMock = vi.fn(
  async (_ws?: string): Promise<{ accounts: MockPoolAccount[] }> => ({
    accounts: [{ id: 'aviynw6' }, { id: 'aviynw2' }],
  }),
);
// default-deploy-account-2026-08-08: resolveAccountPin reads the owner's default from THIS
// module (a dynamic import inside its try/catch). Omitting the export here does not merely
// leave it unstubbed — the import itself throws, the catch reads that as "the default is
// unreadable", and every implied-default claude call fail-closes with `env: {}`. Default to
// `undefined` = "no default set", which is the pre-feature behaviour the older tests assert.
const readDefaultAccountIdMock = vi.fn(async (_ws?: string): Promise<string | undefined> => undefined);
vi.mock('../../deployment/account-pool-store', () => ({
  loadAccountPool: (...a: unknown[]) => loadAccountPoolMock(...(a as [string])),
  readDefaultAccountId: (...a: unknown[]) => readDefaultAccountIdMock(...(a as [string])),
}));
const getAccountOverrideMock = vi.fn(async (_ws: string) => ({
  forcedAccounts: [] as string[],
  excludeAccounts: [] as string[],
}));

const readOmpModelCatalogMock = vi.fn(async (_opts?: unknown) => ({
  models: [{
    provider: 'openai-codex',
    id: 'gpt-5.6-terra',
    selector: 'openai-codex/gpt-5.6-terra',
    name: 'GPT-5.6-Terra',
    contextWindow: 200_000,
    maxTokens: 128_000,
    reasoning: true,
    thinking: ['low', 'medium', 'high'],
    input: ['text'],
    cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
  }],
}));
vi.mock('../../omp-config', () => ({
  readOmpModelCatalog: (opts?: unknown) => readOmpModelCatalogMock(opts),
}));
vi.mock('../../deployment/account-session-override', () => ({
  getAccountOverride: (...a: unknown[]) => getAccountOverrideMock(...(a as [string])),
}));

// fleet-recolor-and-color-hardening P-002: mock ONLY the agent-fleets-store IO
// (createFleetIfAbsent / getFleetScheme / listFleets) so resolveFleet's color-env
// wiring is testable without PG. importActual keeps the REAL pure helpers
// (fleetSlugFromName, resolveFleetScheme) so the test exercises genuine slug +
// scheme resolution — i.e. it asserts the actual catalog hex reaches the env.
const createFleetIfAbsentMock = vi.fn();
const getFleetSchemeMock = vi.fn();
const listFleetsMock = vi.fn(async () => [] as unknown[]);
// WI-1408 (fleet-join-startup-assertion): resolveFleet's join branch now checks the
// slug is a REAL fleet via getFleet before handing back membership env. Default to a
// truthy record so every PRE-EXISTING "join an existing fleet" test (which never set
// this up) keeps its current, already-asserted behavior; the new existence-check
// tests below override it to null per-case.
const getFleetMock = vi.fn(async (_ws: string, slug: string): Promise<AgentFleetRecord | null> => ({
  workspaceId: 'default',
  fleetSlug: slug,
  title: slug,
  description: null,
  owner: 'su-1',
  leaderOwnerId: 'su-1',
  colorScheme: null,
  controlState: 'active',
  controlReason: null,
  controlBy: null,
  controlAt: null,
  lastLaunchTransaction: null,
  createdAt: 0,
  updatedAt: 0,
}));
vi.mock('../../agent-fleets-store', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    createFleetIfAbsent: createFleetIfAbsentMock,
    getFleetScheme: getFleetSchemeMock,
    listFleets: listFleetsMock,
    getFleet: getFleetMock,
  };
});

// WI-1893's boot-time membership stamp (stampFleetMembershipAtBoot) is the OTHER
// PG write on the fleet-join path, and it was the one IO edge this otherwise-hermetic
// file never stubbed — it only became reachable when the stamp was added. It is a
// no-ghost CORRECTNESS gate: a failure there is turned into a hard 409, and
// stampFleetMembershipAtBoot swallows the exception into a message string, so an
// unstubbed real-PG reach surfaced as a bare `expected 'error' to be 'ok'` with the
// cause nowhere in the failure. Mock the store's write; importActual keeps the pure
// helper (deriveFleetMembershipEvent) real.
const appendFleetMembershipIfAbsentMock = vi.fn(async (_input: unknown) => {});
vi.mock('../../fleet-membership-store', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  appendFleetMembershipIfAbsent: appendFleetMembershipIfAbsentMock,
}));

// EI-21005277510954647: bootstrap now writes the initial presence row through
// the canonical presence seam so its resolved harness becomes pot_slug before
// the launched agent's first coord:orient call.
const writePresenceMock = vi.fn(
  async (_identity: unknown, _input: unknown, _harness: unknown) => {},
);
vi.mock('../../agent-tools/coordination/presence', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  writePresence: (...args: unknown[]) =>
    writePresenceMock(...(args as [unknown, unknown, unknown])),
}));
// EI-21442511412659661: bootstrap must consult the shared liveness oracle and
// treat an absent/rejected read as unknown (therefore blocking). Keep the route
// suite PG-free while asserting the exact hydrated call shape.
const resolveSessionStatesMock = vi.hoisted(() =>
  vi.fn(async (_subjects: readonly { ownerId: string }[], _opts?: unknown) => new Map()),
);
vi.mock('../../agent-tools/coordination/liveness-oracle', () => ({
  resolveSessionStates: (...args: unknown[]) => resolveSessionStatesMock(...(args as [any, any])),
}));
type FakeOrgSql = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>;
// EI-21365235532676472: pin pty discovery hermetically — no fake owner has a real
// host on this machine, and the live-evidence leg must be deterministic.
vi.mock('../../events/await/psu-pty-discovery', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  findLiveHost: () => null,
}));
// EI-21365235532676472: hermetic PG for the pre-pinned guard's two reads. Only
// queries the guard itself issues are answered; everything else stays empty.
const dbState = vi.hoisted(() => ({
  advRows: [] as Array<{ id: string; display: string | null; has_session: boolean }>,
  beatRows: [] as Array<{ pid: number | null; host: string | null }>,
}));
// Shared answerer so BOTH surfaces of the fake client agree: the tagged-template
// calls the guard issues AND any `sql.unsafe(...)` issued elsewhere on this path
// (federation-scope <- remote-seat-inventory <- bootstrap-su) resolve through the
// same matcher; everything unknown stays an empty set, never a fabricated row.
const answerOrgQuery = (q: string): Promise<unknown[]> => {
  if (q.includes('FROM harness_shared.coord_presence')) return Promise.resolve(dbState.beatRows);
  if (q.includes('FROM harness_shared.adv_sessions')) return Promise.resolve(dbState.advRows);
  return Promise.resolve([]);
};
const dbSqlMock = vi.fn((strings: TemplateStringsArray): Promise<unknown[]> =>
  answerOrgQuery(strings.join('?')),
) as unknown as FakeOrgSql & {
  unsafe: (query: string) => Promise<unknown[]>;
  begin: <T>(fn: (sql: FakeOrgSql) => Promise<T>) => Promise<T>;
};
dbSqlMock.unsafe = (query: string) => answerOrgQuery(query);
dbSqlMock.begin = async <T>(fn: (sql: FakeOrgSql) => Promise<T>): Promise<T> => fn(dbSqlMock);
vi.mock('@papercusp/db-org', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  getOrgPg: () => ({ sql: dbSqlMock }),
}));

const CTX: RouteContext = {
  principal: null,
  input: undefined,
  params: {},
  log: () => {},
  signal: new AbortController().signal,
};

type Route = { method: string; handler: (req: Request, ctx: RouteContext) => Promise<Response> };

async function routesOf(): Promise<Route[]> {
  const mod = await import('../routes/agent-mcp/bootstrap-su');
  return mod.default as Route[];
}

async function callPost(body: unknown): Promise<Response> {
  const post = (await routesOf()).find((r) => r.method === 'POST')!;
  const req = new Request('http://localhost:3070/api/agent-mcp/console/bootstrap-su', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return post.handler(req, CTX);
}

async function callGet(query = ''): Promise<Response> {
  const get = (await routesOf()).find((r) => r.method === 'GET' && (r as any).path?.endsWith('/options'))!;
  const req = new Request(`http://localhost:3070/api/agent-mcp/console/bootstrap-su/options${query}`, {
    method: 'GET',
  });
  return get.handler(req, CTX);
}

async function callBrainGet(): Promise<Response> {
  const get = (await routesOf()).find((r) => r.method === 'GET' && (r as any).path?.endsWith('/brain'))!;
  const req = new Request('http://localhost:3070/api/agent-mcp/console/bootstrap-su/brain', {
    method: 'GET',
  });
  return get.handler(req, CTX);
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveSessionStatesMock.mockReset().mockResolvedValue(new Map());
  claimAgentLaunchMock.mockReset().mockResolvedValue({
    won: true,
    priorSummary: null,
    priorLaunchedAt: null,
    priorLaunchedBy: null,
  });
  recordAgentLaunchResultMock.mockReset().mockResolvedValue(undefined);
  releaseAgentLaunchClaimMock.mockReset().mockResolvedValue(true);
  recordAdvSessionMock.mockResolvedValue(42);
  getSessionPortMock.mockResolvedValue(null);
  reserveSessionPortTargetMock.mockClear();
  readSessionPortBootstrapDispositionMock.mockClear();
  recordSessionPortBootstrapReceiptMock.mockClear();
  failSessionPortTargetReservationMock.mockClear();
  // P-002 brain-brief defaults: one started hive + a brief string. Tests that
  // exercise the no-brief / no-hive branches override per-call.
  listStartedHivesMock.mockResolvedValue([{ workspaceId: 'default', installSlug: 'papercup' }]);
});

describe('bootstrap-su', () => {
  it('stampPresenceAtBoot accepts a role override while preserving the SU default', async () => {
    const { stampPresenceAtBoot } = await import('../routes/agent-mcp/bootstrap-su');

    await expect(stampPresenceAtBoot({
      workspaceId: 'default',
      ownerId: 'role-judge',
      ownerLabel: 'judge',
      harnessSlug: 'papercup',
      agentRole: 'judge',
    })).resolves.toBeNull();
    expect(writePresenceMock).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: 'role-judge', ownerLabel: 'judge' }),
      { agentRole: 'judge' },
      'papercup',
    );

    writePresenceMock.mockClear();
    await expect(stampPresenceAtBoot({
      workspaceId: 'default',
      ownerId: 'su-default',
      harnessSlug: 'papercup',
    })).resolves.toBeNull();
    expect(writePresenceMock).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: 'su-default' }),
      { agentRole: 'su' },
      'papercup',
    );
  });

  it('claude: builds the su spec, writes the playbook prompt file, mints PAPERCUSP_SID', async () => {
    const res = await callPost({ agent: 'claude', harness_slug: 'papercup', plan_slug: 'my-plan' });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe('ok');
    expect(json.sessionId).toBe(42);
    expect(json.cwd).toBe('/proj/papercup');
    expect(json.codexHome).toBeNull();

    // buildLaunchSpec drives the prompt; called with the su kind + plan context.
    expect(buildLaunchSpecMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'su',
        agent: 'claude',
        harnessSlug: 'papercup',
        profile: 'engineer', // P-023 default
        planSlug: 'my-plan',
        planTitle: 'My Plan',
        planNow: { state: 'do X', next: 'then Y' },
      }),
    );
    // The playbook+ctx prompt is written to a launch-context file.
    expect(json.promptFile).toMatch(/session-42\.md$/);
    const prompt = readFileSync(json.promptFile, 'utf8');
    expect(prompt).toContain('PLAYBOOK + CTX BODY');
    expect(prompt).toContain('⟦INSTRUCTION-PRECEDENCE⟧');
    expect(json.instructionLint.precedenceTrace).toMatchObject({
      effectiveMission: { constraint: 'execute-bound-plan', source: 'plan:my-plan' },
      resync: { verb: 'coord:orient', rule: 'replace-full-never-merge-behind' },
    });

    expect(recordAdvSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ planSlug: 'my-plan', agent: 'claude', mode: 'console' }),
    );
    expect(json.envelopeEnv.PAPERCUSP_AGENT).toBe('claude');
    expect(json.envelopeEnv.PAPERCUSP_SID).toMatch(/^su-/);
    expect(json.envelopeEnv.PAPERCUSP_ADV_SESSION_ID).toBe('42');
    expect(json.specificationRevision).toBe('a'.repeat(64));
    expect(json.envelopeEnv.PAPERCUSP_SPECIFICATION_REVISION).toBe(json.specificationRevision);
    expect(json.envelopeEnv.PAPERCUSP_STATE_REVISION).toBe(json.stateRevision);
    expect(compileLaunchSpecificationArtifactMock).toHaveBeenCalledWith(
      expect.objectContaining({
        promptText: expect.stringContaining('⟦INSTRUCTION-PRECEDENCE⟧'),
        role: 'su',
      }),
    );
    expect(json.envelopeEnv.CODEX_HOME).toBeUndefined();
    // coord extension resolved for omp's -e (present in this test env).
    expect(json.coordExtPath).toBe(COORD_EXT);
  });

  it('replays a completed key from the shared launch ledger without minting another session', async () => {
    const request = {
      agent: 'claude',
      harness_slug: 'papercup',
      plan_slug: 'my-plan',
      bootstrap_idempotency_key: 'bootstrap-key-1',
    };
    const first = await callPost(request);
    expect(first.status).toBe(200);
    const firstJson = await first.json();
    expect(recordAgentLaunchResultMock).toHaveBeenCalledWith({
      workspaceId: 'default',
      idempotencyKey: 'bootstrap-su:bootstrap-key-1',
      summary: firstJson,
    });
    expect(recordAdvSessionMock).toHaveBeenCalledTimes(1);

    claimAgentLaunchMock.mockResolvedValue({
      won: false,
      priorSummary: firstJson,
      priorLaunchedAt: Date.now(),
      priorLaunchedBy: null,
    });
    const replay = await callPost(request);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      status: 'ok',
      sessionId: firstJson.sessionId,
      bootstrapDeduped: true,
    });
    expect(recordAdvSessionMock).toHaveBeenCalledTimes(1);
  });

  it('returns a typed retryable conflict while the winning bootstrap is still in flight', async () => {
    claimAgentLaunchMock.mockResolvedValue({
      won: false,
      priorSummary: {},
      priorLaunchedAt: Date.now(),
      priorLaunchedBy: null,
    });
    const response = await callPost({
      agent: 'claude',
      harness_slug: 'papercup',
      bootstrap_idempotency_key: 'bootstrap-key-in-flight',
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      status: 'error',
      error: 'bootstrap_in_progress',
      retryAfterSec: 1,
    });
    expect(recordAdvSessionMock).not.toHaveBeenCalled();
  });

  it('releases a won bootstrap claim when a later session write fails', async () => {
    recordAdvSessionMock.mockRejectedValueOnce(new Error('session write failed'));
    await expect(
      callPost({
        agent: 'claude',
        harness_slug: 'papercup',
        bootstrap_idempotency_key: 'bootstrap-key-failed',
      }),
    ).rejects.toThrow('session write failed');
    expect(releaseAgentLaunchClaimMock).toHaveBeenCalledWith({
      workspaceId: 'default',
      idempotencyKey: 'bootstrap-su:bootstrap-key-failed',
    });
  });

  it('terminalizes a row written by an incomplete bootstrap before releasing its replay claim', async () => {
    const request = {
      agent: 'codex',
      harness_slug: 'papercup',
      owner_id: 'su-replay01',
      bootstrap_idempotency_key: 'bootstrap-key-post-record-failed',
    };
    recordAdvSessionMock
      .mockResolvedValueOnce(42)
      .mockResolvedValueOnce(43);
    recordAgentLaunchResultMock.mockRejectedValueOnce(new Error('post-record result failure'));

    await expect(callPost(request)).rejects.toThrow('post-record result failure');
    expect(markAdvSessionEndedMock).toHaveBeenCalledWith(42, null, 'reconciler', {
      throwOnError: true,
    });
    expect(markAdvSessionEndedMock.mock.invocationCallOrder[0]).toBeLessThan(
      releaseAgentLaunchClaimMock.mock.invocationCallOrder[0],
    );

    // The same-key replay now sees no live ghost row and creates exactly one
    // successor session instead of failing the pre-pinned-owner freshness guard.
    const replay = await callPost(request);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ status: 'ok', sessionId: 43 });
    expect(recordAdvSessionMock).toHaveBeenCalledTimes(2);
  }, 30_000);

  it('retains the replay claim when strict partial-row cleanup fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    recordAdvSessionMock.mockResolvedValueOnce(42);
    recordAgentLaunchResultMock.mockRejectedValueOnce(new Error('post-record result failure'));
    markAdvSessionEndedMock.mockRejectedValueOnce(new Error('terminal write unavailable'));

    try {
      await expect(
        callPost({
          agent: 'codex',
          harness_slug: 'papercup',
          owner_id: 'su-replay02',
          bootstrap_idempotency_key: 'bootstrap-key-cleanup-failed',
        }),
      ).rejects.toThrow('post-record result failure');
      expect(markAdvSessionEndedMock).toHaveBeenCalledWith(42, null, 'reconciler', {
        throwOnError: true,
      });
      expect(releaseAgentLaunchClaimMock).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(
          'incomplete session 42 could not be terminalized; retaining bootstrap idempotency claim',
        ),
      );
    } finally {
      warn.mockRestore();
    }
  }, 30_000);

  it('stamps the resolved harness onto presence before the launched agent takes turn 1', async () => {
    const json = await (
      await callPost({
        agent: 'claude',
        harness_slug: 'papercup',
        plan_slug: 'my-plan',
        label: 'canary member',
      })
    ).json();
    const sid = json.envelopeEnv.PAPERCUSP_SID;

    expect(writePresenceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: sid,
        ownerLabel: 'canary member',
        workspaceId: 'default',
        source: 'omp-hook-session',
      }),
      expect.objectContaining({ agentRole: 'su' }),
      'papercup',
    );
    expect(recordAdvSessionMock.mock.invocationCallOrder[0]).toBeLessThan(
      writePresenceMock.mock.invocationCallOrder[0],
    );
  });

  it('EI-5503: returns the canonical kickoffPrompt for a plan-bound launch, null without a plan', async () => {
    const withPlan = await (await callPost({ agent: 'claude', harness_slug: 'papercup', plan_slug: 'my-plan' })).json();
    // AUTO OFF (this launch passes no auto/fleet) → a lead agent gets the ROUTING-GATE
    // kickoff (deriveLaunchPromptText(null, false)): read the plan via plans:get, then
    // present the execution options (do-it-yourself / Queen / fleet) and confirm before
    // working — instead of the "just work it" order. AUTO-ON's work-order kickoff (the
    // old default) is covered by launch.test.ts's deriveLaunchPromptText default case.
    expect(withPlan.kickoffPrompt).toContain('plans:get');
    expect(withPlan.kickoffPrompt).toContain('routing gate');
    expect(withPlan.kickoffPrompt).toContain('launch a fleet');
    expect(withPlan.kickoffPrompt).not.toContain('pick up the next actionable item');
    const noPlan = await (await callPost({ agent: 'claude', harness_slug: 'papercup', plan_slug: null })).json();
    expect(noPlan.kickoffPrompt).toBeNull();
  });

  it('EI-155: claude gets a per-session CLAUDE_CONFIG_DIR keyed by the minted sid', async () => {
    const json = await (await callPost({ agent: 'claude', harness_slug: 'papercup' })).json();
    const sid = json.envelopeEnv.PAPERCUSP_SID;
    // The materializer is keyed by the SAME sid recorded as coord_owner_id, so
    // the wake-executor resume leg (sessionClaudeConfigDir(coordOwnerId)) lands
    // on the identical dir the launch wrote to.
    expect(writeInteractiveClaudeConfigMock).toHaveBeenCalledWith(expect.objectContaining({ sid }));
    expect(json.envelopeEnv.CLAUDE_CONFIG_DIR).toBe(`/fake/.papercusp/session-claude/${sid}`);
  });

  it('refuses a session-port protocol skew before creating a target row', async () => {
    const res = await callPost({
      agent: 'codex',
      model: 'gpt-5.5',
      session_port_protocol: 2,
      session_port_transform_version: 2,
      session_port_token: `22222222-2222-4222-8222-222222222222.${'a'.repeat(64)}`,
    });
    expect(res.status).toBe(426);
    expect(recordAdvSessionMock).not.toHaveBeenCalled();
  });

  it('claims a prepared port as a fresh pending target and returns only the managed kickoff file', async () => {
    getSessionPortMock.mockResolvedValueOnce(sessionPortRow());
    const res = await callPost({
      agent: 'codex',
      model: 'gpt-5.5',
      owner_id: 'su-source-owner',
      bootstrap_idempotency_key: `session-port:${SESSION_PORT_ID}`,
      session_port_protocol: 2,
      session_port_transform_version: 3,
      session_port_token: `22222222-2222-4222-8222-222222222222.${'a'.repeat(64)}`,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.kickoffPrompt).toBeNull();
    expect(body.sessionPortKickoffFile).toBe('/managed/222.seed.md');
    expect(body).not.toHaveProperty('sessionPortSeed');
    expect(writeSuCodexHomeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: 42,
      }),
    );
    expect(body.codexHome).toMatch(/su-codex-homes\/session-42$/);
    expect(body.promptFile).toBe(`${body.codexHome}/AGENTS.md`);
    expect(body.envelopeEnv.CODEX_HOME).toBe(body.codexHome);
    expect(reserveSessionPortTargetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        portId: SESSION_PORT_ID,
        workspaceId: 'default',
        target: expect.objectContaining({ agent: 'codex', coordOwnerId: 'su-source-owner' }),
      }),
    );
    expect(recordAdvSessionMock).not.toHaveBeenCalled();
    expect(recordSessionPortBootstrapReceiptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        portId: SESSION_PORT_ID,
        targetAdvSessionId: 42,
      }),
    );
    expect(recordSessionPortTelemetryMock).toHaveBeenCalledWith(expect.objectContaining({
      stage: 'pending',
      portId: '22222222-2222-4222-8222-222222222222',
      targetAdvSessionId: 42,
    }));
  });

  it('replays the committed bootstrap receipt before rejecting an already-pending attempt', async () => {
    getSessionPortMock.mockResolvedValueOnce(sessionPortRow({ status: 'pending', targetAdvSessionId: 42 }));
    readSessionPortBootstrapDispositionMock.mockResolvedValueOnce({
      status: 'replay',
      targetAdvSessionId: 42,
      receipt: {
        status: 'ok',
        sessionId: 42,
        agent: 'codex',
        workspaceId: 'default',
        cwd: '/workspace',
      },
    });

    const res = await callPost({
      agent: 'codex',
      model: 'gpt-5.5',
      account: 'default',
      context_size: 'trimmed',
      owner_id: 'su-source-owner',
      bootstrap_idempotency_key: `session-port:${SESSION_PORT_ID}`,
      session_port_protocol: 2,
      session_port_transform_version: 3,
      session_port_token: `${SESSION_PORT_ID}.${'a'.repeat(64)}`,
      cwd: '/workspace',
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok', sessionId: 42, bootstrapDeduped: true });
    expect(reserveSessionPortTargetMock).not.toHaveBeenCalled();
    expect(writeSuCodexHomeMock).not.toHaveBeenCalled();
  });

  it('rejects an artifact whose semantic payload changed while its receipt stayed the same', async () => {
    getSessionPortMock.mockResolvedValueOnce(sessionPortRow());
    readSessionPortArtifactMock.mockResolvedValueOnce(
      SESSION_PORT_ARTIFACT.seed.replace('ported history', 'tampered history'),
    );
    const res = await callPost({
      agent: 'codex',
      model: 'gpt-5.5',
      owner_id: 'su-source-owner',
      bootstrap_idempotency_key: `session-port:${SESSION_PORT_ID}`,
      session_port_protocol: 2,
      session_port_transform_version: 3,
      session_port_token: `22222222-2222-4222-8222-222222222222.${'a'.repeat(64)}`,
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/marker\/hash mismatch/) });
    expect(recordAdvSessionMock).not.toHaveBeenCalled();
  });

  it('refuses a session-port target that does not continue the source coordination identity', async () => {
    getSessionPortMock.mockResolvedValueOnce(sessionPortRow());
    const res = await callPost({
      agent: 'codex',
      model: 'gpt-5.5',
      owner_id: 'su-different-owner',
      bootstrap_idempotency_key: `session-port:${SESSION_PORT_ID}`,
      session_port_protocol: 2,
      session_port_transform_version: 3,
      session_port_token: `22222222-2222-4222-8222-222222222222.${'a'.repeat(64)}`,
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/must continue source coordination identity/) });
    expect(recordAdvSessionMock).not.toHaveBeenCalled();
  });

  it('refuses an old launcher missing the transform handshake before creating a target row', async () => {
    const res = await callPost({
      agent: 'codex',
      model: 'gpt-5.5',
      session_port_protocol: 1,
      session_port_token: `22222222-2222-4222-8222-222222222222.${'a'.repeat(64)}`,
    });
    expect(res.status).toBe(426);
    expect(recordAdvSessionMock).not.toHaveBeenCalled();
  });

  it('launch-wakeability: arms the standing inbox-wake at launch for the minted sid (parked before first turn)', async () => {
    const json = await (await callPost({ agent: 'claude', harness_slug: 'papercup', plan_slug: 'my-plan' })).json();
    const sid = json.envelopeEnv.PAPERCUSP_SID;
    expect(sid).toMatch(/^su-/);
    // The arm is the SAME owner id recorded as coord_owner_id, so the recorded-session
    // roster row (visible at launch) flips recorded → parked/wakeable immediately —
    // no dependence on the detached, lossy SessionStart lifecycle hook.
    expect(recordAdvSessionMock).toHaveBeenCalledWith(expect.objectContaining({ coordOwnerId: sid }));
    expect(armInboxWakeMock).toHaveBeenCalledWith(expect.objectContaining({ ownerId: sid, workspaceId: 'default' }));
  });

  it('launch-wakeability: an arm failure is best-effort and never fails the launch', async () => {
    armInboxWakeMock.mockRejectedValueOnce(new Error('pg down'));
    const res = await callPost({ agent: 'claude', harness_slug: 'papercup' });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe('ok');
    expect(json.envelopeEnv.PAPERCUSP_SID).toMatch(/^su-/);
  });

  it('EI-155: omp/codex get NO CLAUDE_CONFIG_DIR (codex isolates via CODEX_HOME; omp by its own store)', async () => {
    const omp = await (await callPost({ agent: 'omp', harness_slug: 'papercup', plan_slug: null })).json();
    expect(omp.envelopeEnv.CLAUDE_CONFIG_DIR).toBeUndefined();

    vi.clearAllMocks();
    recordAdvSessionMock.mockResolvedValue(42);
    const codex = await (await callPost({ agent: 'codex', harness_slug: null, plan_slug: null })).json();
    expect(codex.envelopeEnv.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(writeInteractiveClaudeConfigMock).not.toHaveBeenCalled();
  });

  it('EI-155: a materialize failure is non-fatal — the launch still succeeds without CLAUDE_CONFIG_DIR', async () => {
    writeInteractiveClaudeConfigMock.mockImplementationOnce(() => {
      throw new Error('symlink EACCES');
    });
    const res = await callPost({ agent: 'claude', harness_slug: 'papercup' });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe('ok');
    expect(json.envelopeEnv.CLAUDE_CONFIG_DIR).toBeUndefined();
    // The session still has its identity + native id — only transcript isolation degraded.
    expect(json.envelopeEnv.PAPERCUSP_SID).toMatch(/^su-/);
    expect(json.nativeSessionId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('no harness + no plan → playbook prompt still written; spec gets nulls', async () => {
    const res = await callPost({ agent: 'claude', harness_slug: null, plan_slug: null, cwd: '/home/me' });
    const json = await res.json();
    expect(json.promptFile).toMatch(/session-42\.md$/);
    expect(json.instructionLint).toMatchObject({ markerCount: 0, clean: true });
    expect(buildLaunchSpecMock).toHaveBeenCalledWith(expect.objectContaining({ harnessSlug: null, planSlug: null }));
  });

  it('refuses a compiled prompt with contradictory file-lock modes', async () => {
    const base = await buildLaunchSpecMock({ harnessSlug: null });
    buildLaunchSpecMock.mockResolvedValueOnce({
      ...base,
      promptText: [
        'File-lock enforcement is **NOT automatic on Codex**.',
        '<!-- papercusp-rule:file-locking=automatic-hooks -->',
        'managed hooks claim/release file locks automatically',
      ].join('\n'),
    });
    const res = await callPost({ agent: 'codex', harness_slug: null, plan_slug: null });
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({
      status: 'error',
      error: expect.stringMatching(/contradictory file-lock modes/i),
      instructionLint: { conflicts: [expect.objectContaining({ key: 'file-locking' })] },
    });
    expect(writeSuCodexHomeMock).not.toHaveBeenCalled();
  });

  it('refuses a compiled prompt that resurrects unconditional post-compaction recovery-orient', async () => {
    const base = await buildLaunchSpecMock({ harnessSlug: null });
    buildLaunchSpecMock.mockResolvedValueOnce({
      ...base,
      promptText: 'Fresh context. First re-run coord:orient { afterCompaction: true }, then continue.',
    });
    const res = await callPost({ agent: 'claude', harness_slug: null, plan_slug: null });
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({
      status: 'error',
      error: expect.stringMatching(/blocking instruction-contract violation/i),
      instructionLint: {
        unconditionalPostCompactionRecovery: [expect.objectContaining({ pattern: 'first-orient' })],
      },
    });
  });

  it('omp: raw-CLI result (no wrapperBin), No-plan row + mode omp', async () => {
    const res = await callPost({ agent: 'omp', harness_slug: 'papercup', plan_slug: null });
    const json = await res.json();
    expect(json.planSlug).toBeNull();
    expect(json.wrapperBin).toBeUndefined();
    expect(json.codexHome).toBeNull();
    expect(json.coordExtPath).toBe(COORD_EXT);
    expect(recordAdvSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ planSlug: null, agent: 'omp', mode: 'omp' }),
    );
  });

  it('codex → per-session CODEX_HOME (writeSuCodexHome) + CODEX_HOME env; workspace cwd', async () => {
    const res = await callPost({
      agent: 'codex',
      model: 'gpt-5.6-terra:xhigh',
      harness_slug: null,
      plan_slug: null,
    });
    const json = await res.json();
    expect(json.cwd).toBe('/workspace');
    expect(json.codexHome).toMatch(/su-codex-homes\/session-42$/);
    expect(json.envelopeEnv.CODEX_HOME).toBe(json.codexHome);
    expect(json.promptFile).toMatch(/AGENTS\.md$/);
    // writeSuCodexHome gets the spec's prompt + url + the minted sid.
    expect(writeSuCodexHomeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        promptText: expect.stringContaining('⟦INSTRUCTION-PRECEDENCE⟧'),
        mcpUrl: 'http://localhost:3070/api/mcp?superuser=1&workspace=default',
        sid: expect.stringMatching(/^su-/),
        model: 'gpt-5.6-terra:xhigh',
        token: 'TESTBEARER',
        instructionRuntime: expect.objectContaining({
          source: 'bootstrap-su',
          route: { kind: 'self' },
        }),
      }),
    );
    expect(recordAdvSessionMock).toHaveBeenCalledWith(expect.objectContaining({ agent: 'codex', mode: 'console' }));
  });

  it('uses the configured Sol xhigh default only for a visible Codex bootstrap', async () => {
    const res = await callPost({ agent: 'codex', harness_slug: null, plan_slug: null });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.envelopeEnv.PAPERCUSP_MODEL_SOURCE).toBe('configured-default');
    expect(writeSuCodexHomeMock).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gpt-5.6-sol:xhigh' }),
    );
    expect(recordAdvSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        launchArgv: expect.arrayContaining([
          '--model=gpt-5.6-sol:xhigh',
          '--model-source=configured-default',
        ]),
      }),
    );
  });

  it('fails closed before session/home creation when an unattended Codex bootstrap has no model authority', async () => {
    for (const body of [
      { agent: 'codex', headless: true },
      { agent: 'codex', launch_argv: ['psu', '--no-picker', '--agent=codex'] },
      { agent: 'codex', launch_argv: ['psu', '--no-picker', '--agent=codex', '--headless'] },
    ]) {
      vi.clearAllMocks();
      recordAdvSessionMock.mockResolvedValue(42);
      const res = await callPost(body);
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({ code: 'missing_model' });
      expect(writeSuCodexHomeMock).not.toHaveBeenCalled();
      expect(recordAdvSessionMock).not.toHaveBeenCalled();
    }
  });

  it('honors explicit configured-default authority for a no-picker Codex bootstrap', async () => {
    const res = await callPost({
      agent: 'codex',
      model_source: 'configured-default',
      launch_argv: ['psu', '--no-picker', '--agent=codex', '--model-source=configured-default'],
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.envelopeEnv.PAPERCUSP_MODEL_SOURCE).toBe('configured-default');
    expect(writeSuCodexHomeMock).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gpt-5.6-sol:xhigh' }),
    );
  });

  it('codex folds launch_context into AGENTS.md prompt text before writing CODEX_HOME', async () => {
    const kickoff = join(LC_DIR, 'kickoff.md');
    writeFileSync(kickoff, 'KICKOFF CONTEXT\n- continue the rollout\n');
    const res = await callPost({
      agent: 'codex',
      harness_slug: 'papercup',
      plan_slug: 'my-plan',
      launch_context: kickoff,
    });
    expect(res.status).toBe(200);
    expect(writeSuCodexHomeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        promptText: expect.stringContaining(
          'PLAYBOOK + CTX BODY\n\n---\n## Launch Context\n\nKICKOFF CONTEXT\n- continue the rollout',
        ),
      }),
    );
  });

  it('claude prompt-file delivery and codex AGENTS.md delivery start from the same assembled launch spec', async () => {
    const claude = await (await callPost({ agent: 'claude', harness_slug: 'papercup', plan_slug: 'my-plan' })).json();
    const claudePrompt = readFileSync(claude.promptFile, 'utf8');
    expect(claudePrompt).toContain('PLAYBOOK + CTX BODY');
    expect(claudePrompt).toContain('⟦INSTRUCTION-PRECEDENCE⟧');

    vi.clearAllMocks();
    recordAdvSessionMock.mockResolvedValue(43);
    const codex = await callPost({ agent: 'codex', harness_slug: 'papercup', plan_slug: 'my-plan' });
    expect(codex.status).toBe(200);
    expect(writeSuCodexHomeMock).toHaveBeenCalledWith(
      expect.objectContaining({ promptText: expect.stringContaining('⟦INSTRUCTION-PRECEDENCE⟧') }),
    );
  });

  it('claude: mints + records + returns a native session id (the launcher forces it via --session-id)', async () => {
    const json = await (await callPost({ agent: 'claude', harness_slug: 'papercup' })).json();
    expect(json.nativeSessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    // Recorded on the adv row so `psu --resume <native-uuid>` can correlate it.
    expect(recordAdvSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ agent: 'claude', sessionId: json.nativeSessionId }),
    );
  });

  it('omp/codex: no forced native session id (resume via thread id / CODEX_HOME)', async () => {
    const omp = await (await callPost({ agent: 'omp', harness_slug: 'papercup', plan_slug: null })).json();
    expect(omp.nativeSessionId).toBeNull();
    expect(recordAdvSessionMock).toHaveBeenCalledWith(expect.objectContaining({ agent: 'omp', sessionId: null }));

    vi.clearAllMocks();
    recordAdvSessionMock.mockResolvedValue(42);
    const codex = await (await callPost({ agent: 'codex', harness_slug: null, plan_slug: null })).json();
    expect(codex.nativeSessionId).toBeNull();
    expect(recordAdvSessionMock).toHaveBeenCalledWith(expect.objectContaining({ agent: 'codex', sessionId: null }));
  });

  it('retired brain launches are rejected before recording a session', async () => {
    const res = await callPost({ agent: 'claude', harness_slug: null, plan_slug: null, brain: true });
    expect(res.status).toBe(410);
    expect((await res.json()).error).toMatch(/deprecated/);
    expect(setBrainSessionMock).not.toHaveBeenCalled();
    expect(recordAdvSessionMock).not.toHaveBeenCalled();
  });

  it('D-013: non-brain launches never touch the pin', async () => {
    const res = await callPost({ agent: 'claude', harness_slug: 'papercup', plan_slug: null });
    expect(res.status).toBe(200);
    expect(setBrainSessionMock).not.toHaveBeenCalled();
  });

  it('retired GET /brain returns a 410 tombstone', async () => {
    const res = await callBrainGet();
    expect(res.status).toBe(410);
    expect((await res.json()).error).toMatch(/deprecated/);
    expect(getBrainSessionMock).not.toHaveBeenCalled();
  });

  it('P-002: a non-brain launch succeeds with the flag ON (and computes no brief)', async () => {
    getFlagMock.mockResolvedValue(true);
    const res = await callPost({ agent: 'claude', harness_slug: 'papercup', plan_slug: null });
    expect(res.status).toBe(200);
    // The "computes no brief" half is STRUCTURAL since P-059 retired the brief
    // builder — there is no longer a function this path could call. The former
    // `not.toHaveBeenCalled()` guard is dropped rather than rewritten: it named
    // a symbol the module had already stopped exporting, so it passed whether or
    // not the route behaved.
  });

  it('rejects an unknown agent kind', async () => {
    const res = await callPost({ agent: 'gemini', harness_slug: 'papercup' });
    expect(res.status).toBe(400);
    expect(recordAdvSessionMock).not.toHaveBeenCalled();
    expect(buildLaunchSpecMock).not.toHaveBeenCalled();
  });

  it('P-023: threads --profile=power through to buildLaunchSpec', async () => {
    const res = await callPost({ agent: 'claude', harness_slug: 'papercup', profile: 'power' });
    expect(res.status).toBe(200);
    expect(buildLaunchSpecMock).toHaveBeenCalledWith(expect.objectContaining({ profile: 'power' }));
  });

  it('P-023: rejects an invalid profile (no silent fallback)', async () => {
    const res = await callPost({ agent: 'claude', harness_slug: 'papercup', profile: 'wizard' });
    expect(res.status).toBe(400);
    expect(buildLaunchSpecMock).not.toHaveBeenCalled();
  });

  it('P-025: accepts the generic profile (non-coding work hive) and threads it through', async () => {
    const res = await callPost({ agent: 'claude', harness_slug: 'papercup', profile: 'generic' });
    expect(res.status).toBe(200);
    expect(buildLaunchSpecMock).toHaveBeenCalledWith(expect.objectContaining({ profile: 'generic' }));
  });

  it('options (no harness) lists the active-workspace harnesses', async () => {
    const res = await callGet();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe('ok');
    expect(json.workspace).toBe('default');
    expect(json.harnesses).toEqual([{ slug: 'papercup', path: '/repo', status: 'active' }]);
    expect(json.ompCatalog).toMatchObject({
      status: 'available',
      source: 'omp models --json',
      availability: 'enabled-configured',
      credentials: 'unchecked',
      upstream: 'unchecked',
    });
    expect(json.ompCatalog.models[0].selector).toBe('openai-codex/gpt-5.6-terra');
  });

  it('options keeps the launcher usable while reporting an unavailable OMP catalog', async () => {
    readOmpModelCatalogMock.mockRejectedValueOnce(new Error('omp registry unavailable'));
    const res = await callGet();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe('ok');
    expect(json.harnesses).toHaveLength(1);
    expect(json.ompCatalog).toEqual({
      status: 'unavailable',
      source: 'omp models --json',
      availability: 'unknown',
      credentials: 'unchecked',
      upstream: 'unchecked',
      models: [],
      error: 'omp registry unavailable',
    });
  });

  it('options?harness lists non-archived plan slugs', async () => {
    const res = await callGet('?harness=papercup');
    const json = await res.json();
    expect(json.harness).toBe('papercup');
    expect(json.plans).toEqual([{ slug: 'plan-a' }]);
  });

  it('options lists workspaces + the active one', async () => {
    const json = await (await callGet()).json();
    expect(json.activeWorkspace).toBe('default');
    expect(json.workspaces).toEqual([
      { id: 'default', name: 'Default' },
      { id: 'ws2', name: 'Second' },
    ]);
  });

  it('threads an explicit workspace to the session + result', async () => {
    const res = await callPost({ agent: 'claude', workspace: 'ws2', harness_slug: 'papercup' });
    const json = await res.json();
    expect(json.status).toBe('ok');
    expect(json.workspaceId).toBe('ws2');
    expect(buildLaunchSpecMock).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'ws2' }));
    expect(recordAdvSessionMock).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'ws2' }));
  });

  it('rejects an unknown workspace (no session)', async () => {
    const res = await callPost({ agent: 'claude', workspace: 'nope', harness_slug: 'papercup' });
    expect(res.status).toBe(400);
    expect(recordAdvSessionMock).not.toHaveBeenCalled();
  });

  it("WI-3234: accepts the literal 'default' fallback workspace even when the registry hasn't listed it", async () => {
    // Fresh packaged install: activeWorkspaceId() → 'default' (the sentinel), and the
    // /options endpoint hands the launcher `activeWorkspace: 'default'`, which it forwards
    // explicitly. workspaceById('default') is undefined on a sparse registry, so the old
    // raw-workspaceById validation 400'd `unknown workspace: default` — the "psu: unknown
    // workspace: default" the owner hit — even though nothing was wrong. isKnownWorkspace
    // treats 'default' as always-valid, so the launch proceeds.
    const res = await callPost({ agent: 'claude', workspace: 'default', harness_slug: 'papercup' });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe('ok');
    expect(json.workspaceId).toBe('default');
    expect(recordAdvSessionMock).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'default' }));
  });

  it('no-harness launch uses the caller cwd (resume-friendly), not the internal dir', async () => {
    const res = await callPost({ agent: 'claude', harness_slug: null, cwd: '/home/me/work' });
    const json = await res.json();
    expect(json.cwd).toBe('/home/me/work');
    expect(recordAdvSessionMock).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/home/me/work' }));
  });

  it('harness launch ignores the caller cwd (uses the harness repo)', async () => {
    const res = await callPost({ agent: 'claude', harness_slug: 'papercup', cwd: '/home/me/work' });
    const json = await res.json();
    expect(json.cwd).toBe('/proj/papercup');
  });

  it('EI-202: a no-harness launch whose caller cwd is $HOME is relocated off $HOME (prompt-isolation leak)', async () => {
    // At $HOME the cwd-level CLAUDE.md / .claude/CLAUDE.md ARE the owner's personal
    // config, which Claude auto-loads as PROJECT memory — bypassing the per-session
    // CLAUDE_CONFIG_DIR skip-link (P-002). The launch must NOT run in $HOME; it
    // relocates to the internal workspace root (the mocked envelope cwd, '/workspace').
    const res = await callPost({ agent: 'claude', harness_slug: null, cwd: homedir() });
    const json = await res.json();
    expect(json.cwd).not.toBe(homedir());
    expect(json.cwd).toBe('/workspace');
    expect(recordAdvSessionMock).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/workspace' }));
  });
});

describe('resolveAccountPin (psu-account-chooser P-002)', () => {
  beforeEach(() => {
    getFlagMock.mockResolvedValue(false);
    loadAccountPoolMock.mockResolvedValue({ accounts: [{ id: 'aviynw6' }, { id: 'aviynw2' }] });
    getAccountOverrideMock.mockResolvedValue({ forcedAccounts: [], excludeAccounts: [] });
    readDefaultAccountIdMock.mockResolvedValue(undefined);
  });
  const pin = async (
    requested: string | null,
    agent: 'claude' | 'omp' | 'codex' = 'claude',
    model?: string,
  ) => (await import('../routes/agent-mcp/bootstrap-su')).resolveAccountPin(
    'default', requested, agent, undefined, false, model,
  );

  it('no account → explicit Claude default-route marker, no notice', async () => {
    const expected = { PAPERCUSP_ACCOUNT_ROUTING_MODE: 'default' };
    expect(await pin(null)).toMatchObject({ env: expected, notice: null, accountId: null, provider: null });
    expect(await pin('   ')).toMatchObject({ env: expected, notice: null, accountId: null, provider: null });
  });

  it('gateway off → explicit pin fails closed instead of using the default login', async () => {
    getFlagMock.mockResolvedValue(false);
    const r = await pin('aviynw6');
    expect(r.env).toEqual({});
    expect(r.error).toMatch(/gateway is off/i);
    expect(r.error).toMatch(/refusing to fall back to the default system login/i);
  });

  it('OMP account pinning routes through the gateway (D-006): the account-id signal, not the claude ANTHROPIC_BASE_URL env', async () => {
    getFlagMock.mockResolvedValue(true);
    const r = await pin('aviynw6', 'omp');
    // omp consumes PAPERCUSP_ACCOUNT_ID via its per-session models.yml — it must NOT
    // get the claude-CLI gatewaySpawnEnv (ANTHROPIC_BASE_URL/ANTHROPIC_CUSTOM_HEADERS).
    expect(r.env).toMatchObject({
      PAPERCUSP_ACCOUNT_ID: 'aviynw6',
      PAPERCUSP_OMP_MODEL_SELECTOR: 'papercusp-gateway/claude-sonnet-4-6',
    });
    expect(r.env.PAPERCUSP_OMP_MODELS_YML).toContain('"x-papercusp-account": "aviynw6"');
    expect(r.env).not.toHaveProperty('ANTHROPIC_BASE_URL');
    expect(r.accountId).toBe('aviynw6');
    expect(r.provider).toBe('claude');
    expect(r.notice).toMatch(/OMP routed through the inference gateway/i);
    expect(loadAccountPoolMock).toHaveBeenCalled();
  });

  it('unknown account (not in pool) → fails closed', async () => {
    getFlagMock.mockResolvedValue(true);
    const r = await pin('not-a-real-acct');
    expect(r.env).toEqual({});
    expect(r.error).toMatch(/not in the account pool/i);
  });

  it('account excluded by session-override → fails closed', async () => {
    getFlagMock.mockResolvedValue(true);
    getAccountOverrideMock.mockResolvedValue({ forcedAccounts: [], excludeAccounts: ['aviynw6'] });
    const r = await pin('aviynw6');
    expect(r.env).toEqual({});
    expect(r.error).toMatch(/exclude list/i);
  });

  it('account outside forcedAccounts allow-list → fails closed', async () => {
    getFlagMock.mockResolvedValue(true);
    getAccountOverrideMock.mockResolvedValue({ forcedAccounts: ['aviynw2'], excludeAccounts: [] });
    const r = await pin('aviynw6');
    expect(r.env).toEqual({});
    expect(r.error).toMatch(/allow-list/i);
  });

  it('valid + allowed + gateway on → gateway env pin + PAPERCUSP_ACCOUNT_ID + confirm notice', async () => {
    getFlagMock.mockResolvedValue(true);
    const r = await pin('aviynw6');
    expect(r.env.ANTHROPIC_BASE_URL).toMatch(/127\.0\.0\.1/);
    expect(r.env.ANTHROPIC_CUSTOM_HEADERS).toContain('aviynw6');
    expect(r.env.PAPERCUSP_ACCOUNT_ID).toBe('aviynw6');
    expect(r.notice).toMatch(/pinned to account aviynw6/i);
  });

  // account-routing-3-options (owner, 2026-06-30): the ONE `account` value carries 3 explicit modes.
  it("explicit 'default'/'none'/'system' → skip the gateway entirely, even when it is ON", async () => {
    getFlagMock.mockResolvedValue(true); // gateway ON — `default` must STILL skip it (the system-account escape hatch)
    for (const kw of ['default', 'none', 'system', 'DEFAULT', ' System ']) {
      const r = await pin(kw);
      expect(r.env).toEqual({ PAPERCUSP_ACCOUNT_ROUTING_MODE: 'default' });
      expect(r.accountId).toBeNull();
      expect(r.notice).toMatch(/default system account.*inference gateway skipped/i);
    }
    // The pool is never consulted for a `default` route.
    expect(loadAccountPoolMock).not.toHaveBeenCalled();
  });

  it("'auto' (claude, gateway on) → gateway-routed with NO account pin (it auto-selects + fails over)", async () => {
    getFlagMock.mockResolvedValue(true);
    const r = await pin('auto');
    expect(r.env.ANTHROPIC_BASE_URL).toMatch(/127\.0\.0\.1/);
    // CRUCIALLY no account pin → the gateway active()/drain-selects + fails over (vs a hard pin).
    expect(r.env.ANTHROPIC_CUSTOM_HEADERS ?? '').not.toContain('account');
    expect(r.env.PAPERCUSP_ACCOUNT_ID).toBeUndefined();
    expect(r.accountId).toBeNull();
    expect(r.provider).toBe('claude');
    expect(r.notice).toMatch(/auto.*selects an available pool account and fails over/i);
    // Auto remains unpinned, but the pool is validated so a missing provider
    // cannot silently degrade to the default system login.
    expect(loadAccountPoolMock).toHaveBeenCalledWith('default');
  });

  it("'gateway' is an alias for 'auto'", async () => {
    getFlagMock.mockResolvedValue(true);
    const r = await pin('gateway');
    expect(r.accountId).toBeNull();
    expect(r.env.ANTHROPIC_BASE_URL).toMatch(/127\.0\.0\.1/);
    expect(r.notice).toMatch(/auto/i);
  });

  // ── the owner's default account (default-deploy-account-2026-08-08 P-004) ──
  // The two tests directly above are the CONTROL for this block: with no default set,
  // an unspecified account skips the gateway entirely. Everything below is what changes once the
  // owner nominates one — and, just as importantly, what must NOT change.

  describe('with a default account set', () => {
    beforeEach(() => {
      getFlagMock.mockResolvedValue(true);
      readDefaultAccountIdMock.mockResolvedValue('aviynw2');
    });

    it.each([null, '', '   '])(
      'unspecified account %p routes through the gateway on the AUTO path, never as a pin (D-003)',
      async (requested) => {
        // Reusing the `auto` path IS the mechanism: the gateway's resolveAccountPool already
        // returns the default first with the rest behind it, so this gets default-first
        // ordering AND failover for free. A pin would strand the session with no fallback the
        // moment that one account hit its rate window — which is why the assertions below are
        // about the ABSENCE of a pin, not the presence of the account id.
        const r = await pin(requested);
        expect(r.env.PAPERCUSP_ACCOUNT_ROUTING_MODE).toBe('auto');
        expect(r.env.ANTHROPIC_BASE_URL).toMatch(/127\.0\.0\.1/);
        expect(r.env.ANTHROPIC_CUSTOM_HEADERS ?? '').not.toContain('account');
        expect(r.env.PAPERCUSP_ACCOUNT_ID).toBeUndefined();
        expect(r.accountId).toBeNull();
        expect(r.provider).toBe('claude');
        expect(r.error).toBeUndefined();
      },
    );

    it.each(['default', 'DEFAULT', ' Default '])(
      'explicit account %p selects the system route, even when a default account is configured',
      async (requested) => {
        const r = await pin(requested);
        expect(r.env).toEqual({ PAPERCUSP_ACCOUNT_ROUTING_MODE: 'default' });
        expect(r.accountId).toBeNull();
        expect(r.provider).toBeNull();
        expect(r.notice).toMatch(/default system account.*inference gateway skipped/i);
        expect(readDefaultAccountIdMock).not.toHaveBeenCalled();
      },
    );

    it('says WHICH account it starts on, and that it still fails over', async () => {
      // The notice is the only place the owner learns the default took effect — the env
      // deliberately looks identical to plain `auto`, so without this they cannot tell.
      const r = await pin(null);
      expect(r.notice).toMatch(/default account 'aviynw2'/i);
      expect(r.notice).toMatch(/fails over/i);
    });

    it.each(['none', 'system', 'NONE', ' System '])(
      "'%s' still reaches the machine's own login — the D-002 escape hatch is never overridden",
      async (kw) => {
        // Without this there is no way back to ~/.claude once a default exists, and no
        // recovery path at all if the default account's credential goes bad.
        const r = await pin(kw);
        expect(r.env).toEqual({ PAPERCUSP_ACCOUNT_ROUTING_MODE: 'default' });
        expect(r.accountId).toBeNull();
        expect(r.notice).toMatch(/default system account.*inference gateway skipped/i);
      },
    );

    it('an explicit account pin still outranks the default (unchanged hard-pin behaviour)', async () => {
      const r = await pin('aviynw6');
      expect(r.env.PAPERCUSP_ACCOUNT_ID).toBe('aviynw6');
      expect(r.accountId).toBe('aviynw6');
      expect(r.notice).toMatch(/pinned to account aviynw6/i);
    });

    it('an explicit auto is unchanged — it does NOT start advertising the default', async () => {
      const r = await pin('auto');
      expect(r.env.PAPERCUSP_ACCOUNT_ROUTING_MODE).toBe('auto');
      expect(r.notice).toMatch(/selects an available pool account/i);
      expect(r.notice).not.toMatch(/default account/i);
    });

    it('a CODEX agent never consults the default (it stands in for the CLAUDE login)', async () => {
      loadAccountPoolMock.mockResolvedValue({ accounts: [{ id: 'codex-main', provider: 'codex' }] });
      const r = await pin(null, 'codex');
      expect(r.env).toEqual({});
      expect(readDefaultAccountIdMock).not.toHaveBeenCalled();
    });

    it('OMP does not consult it — default preserves the selected OMP provider directly', async () => {
      const r = await pin(null, 'omp', 'ollama-cc/ornith:fast');
      expect(readDefaultAccountIdMock).not.toHaveBeenCalled();
      expect(r.env).toEqual({});
      expect(r.provider).toBeNull();
      expect(r.error).toBeUndefined();
    });

    it('gateway OFF → fails closed rather than quietly serving the system login', async () => {
      // Without a default, gateway-off + no account is a legitimate system-login launch. WITH
      // one, the owner has asked for a specific account, so degrading silently would egress on
      // a credential they did not choose while looking like a perfectly normal launch.
      getFlagMock.mockResolvedValue(false);
      const r = await pin(null);
      expect(r.env).toEqual({});
      expect(r.error).toMatch(/gateway is off/i);
      expect(r.error).toMatch(/refusing to fall back/i);
    });
  });

  it('a FAILED default read fails CLOSED — never a silent system-login launch', async () => {
    // The unreadable-row case is distinct from "no default set" (undefined), and conflating
    // them is the exact silent-misroute this feature exists to prevent: the session would
    // launch happily on the box's own credential with the owner's choice dropped on the floor.
    getFlagMock.mockResolvedValue(true);
    readDefaultAccountIdMock.mockRejectedValue(new Error('pg down'));
    const r = await pin(null);
    expect(r.env).toEqual({});
    expect(r.accountId).toBeNull();
    expect(r.error).toMatch(/could not read the default account/i);
    expect(r.error).toMatch(/pg down/);
    expect(r.error).toMatch(/refusing to fall back/i);
  });

  it("a failed default read does NOT block the 'system' escape hatch", async () => {
    // The recovery path must survive the failure mode it exists to recover from — otherwise a
    // bad override row locks the owner out of their own machine's login entirely.
    getFlagMock.mockResolvedValue(true);
    readDefaultAccountIdMock.mockRejectedValue(new Error('pg down'));
    const r = await pin('system');
    expect(r.env).toEqual({ PAPERCUSP_ACCOUNT_ROUTING_MODE: 'default' });
    expect(r.error).toBeUndefined();
  });

  it("'auto' + gateway OFF → fails closed instead of using the default credential", async () => {
    getFlagMock.mockResolvedValue(false);
    const r = await pin('auto');
    expect(r.env).toEqual({});
    expect(r.error).toMatch(/--account auto could not be honored.*gateway is off/i);
    expect(r.error).toMatch(/refusing to fall back/i);
  });

  it("'auto' + codex → UNPINNED gateway routing carried by gatewayAuto (WI-3645), not a fail-soft", async () => {
    // The old behavior ("auto gateway routing isn't wired for codex yet") silently bypassed the
    // gateway: the session egressed direct-to-ChatGPT on the local credential, unmetered. Now
    // auto returns provider:'codex' + gatewayAuto:true — the CODEX_HOME writers translate that
    // into the UNPINNED gateway provider block (x-papercusp-account header omitted; the gateway
    // auto-selects via its bearer-pool → codex-CLI fallback). env stays {} deliberately: codex
    // routing rides in config.toml, never ANTHROPIC_* env.
    getFlagMock.mockResolvedValue(true);
    loadAccountPoolMock.mockResolvedValue({ accounts: [{ id: 'codex-main', provider: 'codex' }] });
    const r = await pin('auto', 'codex');
    expect(r.env).toEqual({});
    expect(r.provider).toBe('codex');
    expect(r.accountId).toBeNull();
    expect(r.gatewayAuto).toBe(true);
    expect(r.notice).toMatch(/routing through the inference gateway \(auto/i);
  });

  it("'auto' + omp emits an unpinned gateway models.yml", async () => {
    getFlagMock.mockResolvedValue(true);
    const r = await pin('auto', 'omp');
    expect(r.env.PAPERCUSP_OMP_MODEL_SELECTOR).toBe('papercusp-gateway/claude-sonnet-4-6');
    expect(r.env.PAPERCUSP_OMP_MODELS_YML).toContain('papercusp-gateway:');
    expect(r.env.PAPERCUSP_OMP_MODELS_YML).not.toContain('x-papercusp-account');
    expect(r.gatewayAuto).toBe(true);
    expect(r.error).toBeUndefined();
  });

  it("'auto' + OMP preserves a compatible Claude selector exactly", async () => {
    getFlagMock.mockResolvedValue(true);
    const r = await pin('auto', 'omp', 'claude-bridge/claude-opus-4-8:high');
    expect(r.env.PAPERCUSP_OMP_MODEL_SELECTOR).toBe('papercusp-gateway/claude-opus-4-8');
    expect(r.env.PAPERCUSP_OMP_MODELS_YML).toContain('- id: "claude-opus-4-8"');
    expect(r.provider).toBe('claude');
  });

  it("'auto' + OMP rejects an incompatible provider without substituting a Claude default", async () => {
    getFlagMock.mockResolvedValue(true);
    const r = await pin('auto', 'omp', 'amazon-bedrock/anthropic.claude-opus-4-8');
    expect(r.env).toEqual({});
    expect(r.error).toMatch(/not compatible.*refusing model substitution/i);
  });

  it("'auto' + OMP OpenAI Codex selector resolves against the Codex pool + wire", async () => {
    getFlagMock.mockResolvedValue(true);
    loadAccountPoolMock.mockResolvedValue({
      accounts: [{ id: 'aviynw6', provider: 'claude' }, { id: 'codex-main', provider: 'codex' }],
    });
    const r = await pin('auto', 'omp', 'openai-codex/gpt-5.6-terra:xhigh');
    expect(r.provider).toBe('codex');
    expect(r.env.PAPERCUSP_OMP_MODEL_SELECTOR).toBe('papercusp-gateway/gpt-5.6-terra');
    expect(r.env.PAPERCUSP_OMP_MODELS_YML).toContain('baseUrl: "http://127.0.0.1:8788/v1"');
    expect(r.env.PAPERCUSP_OMP_MODELS_YML).toContain('api: openai-responses');
  });

  it('OMP pin rejects a Claude account for an OpenAI Codex selector', async () => {
    getFlagMock.mockResolvedValue(true);
    loadAccountPoolMock.mockResolvedValue({ accounts: [{ id: 'aviynw6', provider: 'claude' }] });
    const r = await pin('aviynw6', 'omp', 'openai-codex/gpt-5.6-terra');
    expect(r.env).toEqual({});
    expect(r.error).toMatch(/claude account.*omp sessions require codex/i);
  });

  it('Codex account + codex agent → no Anthropic env, but carries account id for CODEX_HOME config', async () => {
    getFlagMock.mockResolvedValue(true);
    loadAccountPoolMock.mockResolvedValue({ accounts: [{ id: 'aviynw6' }, { id: 'codex-main', provider: 'codex' }] });
    const r = await pin('codex-main', 'codex');
    expect(r.provider).toBe('codex');
    expect(r.accountId).toBe('codex-main');
    expect(r.env).toEqual({ PAPERCUSP_ACCOUNT_ID: 'codex-main' });
    expect(r.notice).toMatch(/pinned to Codex account codex-main/i);
  });

  it('Codex account + claude agent → fails closed on provider mismatch', async () => {
    getFlagMock.mockResolvedValue(true);
    loadAccountPoolMock.mockResolvedValue({ accounts: [{ id: 'codex-main', provider: 'codex' }] });
    const r = await pin('codex-main', 'claude');
    expect(r.env).toEqual({});
    expect(r.error).toMatch(/codex account.*claude sessions require claude/i);
  });

  // P-006 (end-to-end through the POST handler): the launcher's `account` body field
  // flows → resolveAccountPin → the response's envelopeEnv + accountNotice.
  it('POST { account } → 409 before session bookkeeping when the explicit route is unavailable', async () => {
    getFlagMock.mockResolvedValue(false);
    const response = await callPost({ agent: 'claude', harness_slug: 'papercup', account: 'aviynw6' });
    expect(response.status).toBe(409);
    const json = await response.json();
    expect(json.error).toMatch(/gateway is off/i);
    expect(json.error).toMatch(/refusing to fall back/i);
    expect(recordAdvSessionMock).not.toHaveBeenCalled();
  });

  it('POST { account } → response pins the account + sets the gateway env when on + valid', async () => {
    getFlagMock.mockResolvedValue(true);
    const json = await (await callPost({ agent: 'claude', harness_slug: 'papercup', account: 'aviynw6' })).json();
    expect(json.accountNotice).toMatch(/pinned to account aviynw6/i);
    expect(json.envelopeEnv.ANTHROPIC_BASE_URL).toMatch(/127\.0\.0\.1/);
    expect(json.envelopeEnv.PAPERCUSP_ACCOUNT_ID).toBe('aviynw6');
  });

  it('POST Codex pin threads SU owner/priority metadata into the CODEX_HOME writer', async () => {
    getFlagMock.mockResolvedValue(true);
    loadAccountPoolMock.mockResolvedValue({ accounts: [{ id: 'codex-main', provider: 'codex' }] });
    const response = await callPost({ agent: 'codex', harness_slug: 'papercup', account: 'codex-main' });
    expect(response.status).toBe(200);
    expect(writeSuCodexHomeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        codexGatewayAccountId: 'codex-main',
        codexGatewayPriority: 'su',
        sid: expect.stringMatching(/^su-/),
      }),
    );
  });

  it('POST without account → no accountNotice, explicit default marker, no gateway env', async () => {
    const json = await (await callPost({ agent: 'claude', harness_slug: 'papercup' })).json();
    expect(json.accountNotice).toBeNull();
    expect(json.envelopeEnv.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(json.envelopeEnv.PAPERCUSP_ACCOUNT_ROUTING_MODE).toBe('default');
  });

  it('POST with explicit account=default stays on the system route when a default account is configured', async () => {
    getFlagMock.mockResolvedValue(true);
    readDefaultAccountIdMock.mockResolvedValue('aviynw2');
    try {
      const json = await (await callPost({ agent: 'claude', harness_slug: 'papercup', account: 'default' })).json();
      expect(json.accountNotice).toMatch(/default system account.*inference gateway skipped/i);
      expect(json.envelopeEnv).toEqual(expect.objectContaining({ PAPERCUSP_ACCOUNT_ROUTING_MODE: 'default' }));
      expect(json.envelopeEnv.ANTHROPIC_BASE_URL).toBeUndefined();
      expect(readDefaultAccountIdMock).not.toHaveBeenCalled();
    } finally {
      // This file's later POST tests intentionally exercise the no-default path.
      readDefaultAccountIdMock.mockResolvedValue(undefined);
    }
  });
});

describe('resolveAccountChoices (psu-account-chooser P-005)', () => {
  beforeEach(() => {
    getFlagMock.mockResolvedValue(false);
    loadAccountPoolMock.mockResolvedValue({ accounts: [{ id: 'aviynw6' }, { id: 'aviynw2' }] });
    getAccountOverrideMock.mockResolvedValue({ forcedAccounts: [], excludeAccounts: [] });
  });
  const choices = async (agent: 'claude' | 'omp' | 'codex' = 'claude') =>
    (await import('../routes/agent-mcp/bootstrap-su')).resolveAccountChoices('default', agent);

  it('gateway off → hidden (empty pool) — the current default', async () => {
    getFlagMock.mockResolvedValue(false);
    expect(await choices()).toEqual({
      gatewayOn: false,
      pool: [],
      forcedAccounts: [],
      excludeAccounts: [],
      provider: 'claude',
    });
  });

  it('gateway on → pool ids + the active session-override', async () => {
    getFlagMock.mockResolvedValue(true);
    getAccountOverrideMock.mockResolvedValue({ forcedAccounts: ['aviynw6'], excludeAccounts: ['aviynw2'] });
    const r = await choices();
    expect(r.gatewayOn).toBe(true);
    expect(r.pool).toEqual(['aviynw6', 'aviynw2']);
    expect(r.forcedAccounts).toEqual(['aviynw6']);
    expect(r.excludeAccounts).toEqual(['aviynw2']);
  });

  it('Codex choices include only codex provider accounts', async () => {
    getFlagMock.mockResolvedValue(true);
    loadAccountPoolMock.mockResolvedValue({ accounts: [{ id: 'aviynw6' }, { id: 'codex-main', provider: 'codex' }] });
    const r = await choices('codex');
    expect(r.provider).toBe('codex');
    expect(r.pool).toEqual(['codex-main']);
  });

  it('OMP choices resolve to the claude account pool (omp pins claude accounts, D-006)', async () => {
    getFlagMock.mockResolvedValue(true);
    const r = await choices('omp');
    expect(r.gatewayOn).toBe(true);
    expect(r.provider).toBe('claude');
    expect(r.unsupportedReason).toBeUndefined();
    expect(loadAccountPoolMock).toHaveBeenCalled();
  });

  it('GET /options surfaces the accounts field (empty when gateway off)', async () => {
    getFlagMock.mockResolvedValue(false);
    const json = await (await callGet()).json();
    expect(json.accounts).toEqual({
      gatewayOn: false,
      pool: [],
      forcedAccounts: [],
      excludeAccounts: [],
      provider: 'claude',
    });
  });
});

// fleet-recolor-and-color-hardening P-002: regression guard for the psu-picker
// fleet-color path. The reported bug — "create a new fleet in the psu menu and
// the terminal isn't recolored" — is exactly resolveFleet failing to emit
// PAPERCUSP_FLEET_BG/FG/CURSOR for a freshly-created fleet. Nothing guarded it.
// These tests assert BOTH branches (create-new + join-existing) carry the color
// env, and that the catalog's real hex reaches the env (real resolveFleetScheme).
describe('resolveFleet — terminal color env (fleet-color-schemes)', () => {
  let forest: { name: string; bg: string; fg: string; cursor: string };
  beforeEach(async () => {
    const { schemeByName } = await import('../../console-color-schemes');
    forest = schemeByName('forest')!;
  });

  async function resolveFleet(
    workspaceId: string,
    opts: {
      fleet?: string | null;
      fleetRole?: string | null;
      fleetName?: string | null;
      fleetScheme?: string | null;
      ownerId?: string;
    },
  ) {
    const mod = await import('../routes/agent-mcp/bootstrap-su');
    return mod.resolveFleet(workspaceId, opts);
  }

  it('a NEW fleet (fleetName) carries the fleet color env — the regressed case', async () => {
    createFleetIfAbsentMock.mockResolvedValue({
      record: {
        workspaceId: 'default',
        fleetSlug: 'my-fleet',
        title: 'My Fleet',
        description: null,
        owner: 'su-1',
        leaderOwnerId: 'su-1',
        colorScheme: 'forest',
        createdAt: 0,
        updatedAt: 0,
      },
      created: true,
    });
    const { env, fleetRole, fleetSlug } = await resolveFleet('default', { fleetName: 'My Fleet', ownerId: 'su-1' });
    expect(fleetRole).toBe('leader');
    expect(fleetSlug).toBe('my-fleet');
    expect(env.PAPERCUSP_FLEET_SLUG).toBe('my-fleet');
    expect(env.PAPERCUSP_FLEET_ROLE).toBe('leader');
    // The actual catalog hex — not just "some value" — must reach the env.
    expect(env.PAPERCUSP_FLEET_BG).toBe(forest.bg);
    expect(env.PAPERCUSP_FLEET_FG).toBe(forest.fg);
    expect(env.PAPERCUSP_FLEET_CURSOR).toBe(forest.cursor);
  });

  it('a chosen catalog scheme (fleetScheme) is FORCED at create; unknown/absent → auto-allocate (null)', async () => {
    createFleetIfAbsentMock.mockResolvedValue({
      record: {
        workspaceId: 'default',
        fleetSlug: 'my-fleet',
        title: 'My Fleet',
        description: null,
        owner: 'su-1',
        leaderOwnerId: 'su-1',
        colorScheme: 'forest',
        createdAt: 0,
        updatedAt: 0,
      },
      created: true,
    });
    // A valid catalog name is passed straight through as the forced colorScheme.
    await resolveFleet('default', { fleetName: 'My Fleet', fleetScheme: 'royal-purple', ownerId: 'su-1' });
    expect(createFleetIfAbsentMock).toHaveBeenCalledWith(expect.objectContaining({ colorScheme: 'royal-purple' }));
    // An unknown name is rejected → null → the store auto-allocates the next unused.
    createFleetIfAbsentMock.mockClear();
    await resolveFleet('default', { fleetName: 'My Fleet', fleetScheme: 'not-a-real-scheme', ownerId: 'su-1' });
    expect(createFleetIfAbsentMock).toHaveBeenCalledWith(expect.objectContaining({ colorScheme: null }));
    // No scheme chosen → null (auto-allocate) — unchanged legacy behaviour.
    createFleetIfAbsentMock.mockClear();
    await resolveFleet('default', { fleetName: 'My Fleet', ownerId: 'su-1' });
    expect(createFleetIfAbsentMock).toHaveBeenCalledWith(expect.objectContaining({ colorScheme: null }));
  });

  it('an EXISTING fleet (fleet slug) carries the fleet color env', async () => {
    getFleetSchemeMock.mockResolvedValue({ name: 'forest', bg: forest.bg, fg: forest.fg, cursor: forest.cursor });
    // EI-18278623507151337: joins as `su-2`, NOT the shared getFleetMock record's
    // `leaderOwnerId: 'su-1'`. This case is about the COLOR env on an ordinary member
    // join; an owner that matches the record's leader is now (correctly) kept a LEADER
    // by the composer-side role check, which would make the `member` assertion below
    // assert the wrong thing about a different scenario.
    const { env, fleetRole } = await resolveFleet('default', { fleet: 'team', ownerId: 'su-2' });
    expect(fleetRole).toBe('member');
    expect(env.PAPERCUSP_FLEET_SLUG).toBe('team');
    expect(env.PAPERCUSP_FLEET_BG).toBe(forest.bg);
    expect(env.PAPERCUSP_FLEET_FG).toBe(forest.fg);
    expect(env.PAPERCUSP_FLEET_CURSOR).toBe(forest.cursor);
  });

  it('no fleet ⇒ empty env (no color vars, byte-identical to today)', async () => {
    const { env, fleetSlug, fleetRole } = await resolveFleet('default', {});
    expect(env).toEqual({});
    expect(fleetSlug).toBeNull();
    expect(fleetRole).toBeNull();
  });

  it('an existing fleet with no resolvable scheme keeps slug/role but omits color vars', async () => {
    getFleetSchemeMock.mockResolvedValue(null);
    const { env } = await resolveFleet('default', { fleet: 'ghost' });
    expect(env.PAPERCUSP_FLEET_SLUG).toBe('ghost');
    expect(env.PAPERCUSP_FLEET_BG).toBeUndefined();
  });
});

// WI-1408 (fleet-join-startup-assertion): a --fleet=<slug> join must validate the slug
// is a REAL agent_fleets row before handing back membership env — otherwise a
// typo'd/stale slug "succeeds" silently: PAPERCUSP_FLEET_SLUG gets set to a fleet that
// never existed, a phantom membership invisible to fleet:assignments' roster of real
// rows even though the env var itself is non-null.
describe('resolveFleet — nonexistent-slug rejection (WI-1408)', () => {
  // Same dynamic-import helper as the sibling describe block above (each `describe`
  // is its own closure — the other block's local `resolveFleet` isn't in scope here).
  async function resolveFleet(
    workspaceId: string,
    opts: {
      fleet?: string | null;
      fleetRole?: string | null;
      fleetName?: string | null;
      fleetScheme?: string | null;
      ownerId?: string;
    },
  ) {
    const mod = await import('../routes/agent-mcp/bootstrap-su');
    return mod.resolveFleet(workspaceId, opts);
  }

  it('joining an unknown slug ⇒ empty env, null slug/role, an explanatory notice', async () => {
    getFleetMock.mockResolvedValueOnce(null);
    const { env, fleetSlug, fleetRole, notice } = await resolveFleet('default', { fleet: 'ghost-fleet' });
    expect(env).toEqual({});
    expect(fleetSlug).toBeNull();
    expect(fleetRole).toBeNull();
    expect(notice).toMatch(/ghost-fleet.*does not exist/i);
  });

  it('POST { fleet } for an unknown slug is a hard 409 — never a silent unfleeted launch', async () => {
    getFleetMock.mockResolvedValueOnce(null);
    const res = await callPost({ agent: 'claude', harness_slug: 'papercup', fleet: 'ghost-fleet' });
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.status).toBe('error');
    expect(json.error).toMatch(/fleet join failed/i);
    expect(json.error).toMatch(/ghost-fleet/i);
    // The launch must never have been recorded — the hard-fail is BEFORE session bookkeeping.
    expect(recordAdvSessionMock).not.toHaveBeenCalled();
  });

  it('POST { fleet } for a real slug still returns 200 with fleetSlug/fleetRole in the result', async () => {
    const json = await (await callPost({ agent: 'claude', harness_slug: 'papercup', fleet: 'real-fleet' })).json();
    expect(json.status).toBe('ok');
    expect(json.fleetSlug).toBe('real-fleet');
    expect(json.fleetRole).toBe('member');
  });

  it('no fleet requested at all ⇒ still 200, fleetSlug/fleetRole both null (no assertion fires)', async () => {
    const json = await (await callPost({ agent: 'claude', harness_slug: 'papercup' })).json();
    expect(json.status).toBe('ok');
    expect(json.fleetSlug).toBeNull();
    expect(json.fleetRole).toBeNull();
  });
});

describe('deriveKickoffPrompt (EI-5503 + WI-1962 + WI-1356 — the turn-1 kickoff matrix)', () => {
  it('a bare interactive launch seeds nothing', async () => {
    const { deriveKickoffPrompt } = await import('../routes/agent-mcp/bootstrap-su');
    expect(deriveKickoffPrompt({ planSlug: null, autoMode: false, launchContextPath: null })).toBeNull();
  });

  it('WI-1962: a mission-brief (--launch-context) launch gets the brief kickoff — it must not park', async () => {
    const { deriveKickoffPrompt, LAUNCH_CONTEXT_KICKOFF } = await import('../routes/agent-mcp/bootstrap-su');
    const k = deriveKickoffPrompt({ planSlug: null, autoMode: false, launchContextPath: '/tmp/brief.md' });
    expect(k).toBe(LAUNCH_CONTEXT_KICKOFF);
  });

  it('a plan-bound launch keeps the canonical plan kickoff (plan wins over a brief)', async () => {
    const { deriveKickoffPrompt } = await import('../routes/agent-mcp/bootstrap-su');
    const k = deriveKickoffPrompt({ planSlug: 'p1', autoMode: false, launchContextPath: '/tmp/brief.md' });
    expect(k).toContain('plans:get');
  });

  it('bakes the literal slug + harness into the plan kickoff (ornith 10115: no slug ⇒ parked on ask)', async () => {
    const { deriveKickoffPrompt } = await import('../routes/agent-mcp/bootstrap-su');
    const k = deriveKickoffPrompt({
      planSlug: 'p1',
      harnessSlug: 'papercusp',
      autoMode: false,
      launchContextPath: null,
    });
    expect(k).toContain('handed the plan `p1`');
    expect(k).toContain('{ slug: "p1", harness: "papercusp" }');
    // slug-only launches still name the slug
    const bare = deriveKickoffPrompt({ planSlug: 'p1', autoMode: true, launchContextPath: null });
    expect(bare).toContain('{ slug: "p1" }');
  });

  it('AUTO prepends the activation to whichever base applies (brief / bare)', async () => {
    const { deriveKickoffPrompt, AUTO_MODE_DIRECTIVE, LAUNCH_CONTEXT_KICKOFF } =
      await import('../routes/agent-mcp/bootstrap-su');
    const withBrief = deriveKickoffPrompt({ planSlug: null, autoMode: true, launchContextPath: '/b.md' });
    expect(withBrief).toContain(AUTO_MODE_DIRECTIVE);
    expect(withBrief).toContain(LAUNCH_CONTEXT_KICKOFF);
    const bare = deriveKickoffPrompt({ planSlug: null, autoMode: true, launchContextPath: null });
    expect(bare).toContain(AUTO_MODE_DIRECTIVE);
    expect(bare).not.toContain(LAUNCH_CONTEXT_KICKOFF);
  });

  it('drain-mode P-003: DRAIN prepends the DRAIN activation and REPLACES the plain AUTO one', async () => {
    const { deriveKickoffPrompt, DRAIN_MODE_DIRECTIVE, AUTO_MODE_DIRECTIVE, CONTEXT_DISCIPLINE_DIRECTIVE } =
      await import('../routes/agent-mcp/bootstrap-su');
    // A drain launch is autoMode too (DRAIN implies AUTO server-side) — the DRAIN
    // directive must still win, never both activations.
    const bare = deriveKickoffPrompt({ planSlug: null, autoMode: true, launchContextPath: null, drainMode: true });
    expect(bare).toContain(DRAIN_MODE_DIRECTIVE);
    expect(bare).toContain(CONTEXT_DISCIPLINE_DIRECTIVE);
    expect(bare).not.toContain(AUTO_MODE_DIRECTIVE);
  });

  it('drain-mode P-003: a plan-bound DRAIN launch keeps the canonical plan kickoff under the activation', async () => {
    const { deriveKickoffPrompt, DRAIN_MODE_DIRECTIVE } = await import('../routes/agent-mcp/bootstrap-su');
    const k = deriveKickoffPrompt({ planSlug: 'p1', autoMode: true, launchContextPath: null, drainMode: true });
    expect(k).toContain(DRAIN_MODE_DIRECTIVE);
    expect(k).toContain('plans:get');
  });

  it('drain-mode P-003: omitting drainMode is byte-identical to the pre-drain behavior', async () => {
    const { deriveKickoffPrompt, AUTO_MODE_DIRECTIVE } = await import('../routes/agent-mcp/bootstrap-su');
    const auto = deriveKickoffPrompt({ planSlug: null, autoMode: true, launchContextPath: null });
    expect(auto).toContain(AUTO_MODE_DIRECTIVE);
    expect(deriveKickoffPrompt({ planSlug: null, autoMode: false, launchContextPath: null })).toBeNull();
  });
});

describe('deriveKickoffPrompt — kickoff-prompt-absorption P-004 (guard profile + auto-arm notice)', () => {
  it("loopAutoArmed swaps the AUTO activation's MUST-ARM clause for the already-armed notice", async () => {
    const { deriveKickoffPrompt, AUTO_MODE_DIRECTIVE, AUTO_MODE_DIRECTIVE_LOOP_ARMED } =
      await import('../routes/agent-mcp/bootstrap-su');
    const armed = deriveKickoffPrompt({
      planSlug: 'p1',
      autoMode: true,
      launchContextPath: null,
      loopAutoArmed: true,
    });
    expect(armed).toContain(AUTO_MODE_DIRECTIVE_LOOP_ARMED);
    expect(armed).not.toContain('MUST ARM');
    expect(armed).toContain('ALREADY ARMED');
    // Omitted / false ⇒ the full self-arm instruction (the fallback path).
    const fallback = deriveKickoffPrompt({ planSlug: 'p1', autoMode: true, launchContextPath: null });
    expect(fallback).toContain(AUTO_MODE_DIRECTIVE);
    expect(fallback).toContain('MUST ARM');
  });

  it('autoModeDirective picks by arm outcome (never assume armed)', async () => {
    const { autoModeDirective, AUTO_MODE_DIRECTIVE, AUTO_MODE_DIRECTIVE_LOOP_ARMED } =
      await import('../routes/agent-mcp/bootstrap-su');
    expect(autoModeDirective(true)).toBe(AUTO_MODE_DIRECTIVE_LOOP_ARMED);
    expect(autoModeDirective(false)).toBe(AUTO_MODE_DIRECTIVE);
  });

  it("agent:'claude' gets the lean plan kickoff (orient pointer, absorbed guards dropped)", async () => {
    const { deriveKickoffPrompt } = await import('../routes/agent-mcp/bootstrap-su');
    const k = deriveKickoffPrompt({
      planSlug: 'p1',
      harnessSlug: 'papercusp',
      autoMode: true,
      launchContextPath: null,
      agent: 'claude',
    });
    expect(k).toContain('advance the plan `p1`');
    expect(k).toContain('coord:orient');
    expect(k).toContain('planSlug: "p1"');
    expect(k).not.toContain('NOT hunt for a plan file'); // → P-003b plans-read hook (WI-5229)
    expect(k).not.toContain('NameError'); // → P-003a unknown-tool referral (EI-9011)
  });

  it('omp (ornith/local) and codex keep the full weak-model guard text', async () => {
    const { deriveKickoffPrompt } = await import('../routes/agent-mcp/bootstrap-su');
    for (const agent of ['omp', 'codex', undefined]) {
      const k = deriveKickoffPrompt({
        planSlug: 'p1',
        autoMode: true,
        launchContextPath: null,
        agent,
      });
      expect(k).toContain('plans:get');
      expect(k).toContain('NOT hunt for a plan file');
    }
  });

  it('DRAIN is unaffected by loopAutoArmed (leaders are never auto-armed; DRAIN sequences its own bring-up)', async () => {
    const { deriveKickoffPrompt, DRAIN_MODE_DIRECTIVE } = await import('../routes/agent-mcp/bootstrap-su');
    const k = deriveKickoffPrompt({
      planSlug: null,
      autoMode: true,
      launchContextPath: null,
      drainMode: true,
      loopAutoArmed: true,
    });
    expect(k).toContain(DRAIN_MODE_DIRECTIVE);
    expect(k).not.toContain('ALREADY ARMED');
  });
});

describe('buildLaunchProvenanceFactBody — fleet-safe reporting fallback', () => {
  it('preserves original launcher attribution and teaches the live fleet leader selector', async () => {
    const { buildLaunchProvenanceFactBody } = await import('../routes/agent-mcp/bootstrap-su');
    const body = buildLaunchProvenanceFactBody({
      launchedBy: 'su-ended-launcher',
      planSlug: 'drain-plan',
      launchContextPath: '/tmp/fleet-brief.md',
      fleetSlug: 'nonp2p-bug-drain-headless-0812',
    });

    expect(body).toContain('You were launched by su-ended-launcher on plan drain-plan with brief fleet-brief.md.');
    expect(body).toContain(
      'For live fleet coordination, report milestones + anomalies with coord:send to ["@fleet-leader:nonp2p-bug-drain-headless-0812"]',
    );
    expect(body).toContain('launcher ID above as attribution only, not as the live fleet recipient');
    expect(body).not.toContain('report milestones + anomalies to them while live');
    expect(body).toContain('to: ["@fleet-leader:nonp2p-bug-drain-headless-0812"]');
    expect(body).toContain('survives session retirement and leadership rotation');
  });

  it('keeps fleetless launcher attribution and teaches the durable human fallback', async () => {
    const { buildLaunchProvenanceFactBody } = await import('../routes/agent-mcp/bootstrap-su');
    const body = buildLaunchProvenanceFactBody({ launchedBy: 'su-direct-launcher' });

    expect(body).toContain(
      'You were launched by su-direct-launcher. They are your launcher/supervisor; report milestones + anomalies to them while live.',
    );
    expect(body).toContain('to: ["human"]');
    expect(body).toContain('owner surface survives session retirement');
    expect(body).not.toContain('@fleet-leader:');
  });
});

/**
 * P-021 (D-013) — the PRODUCER half, exercised through the real route handler.
 *
 * The pure gate is unit-tested in omp-native-lsp-gate.test.ts and the argv half
 * in psu-launcher.test.ts, but neither proves the route actually EMITS the env
 * — and "the server resolves it and threads it via envelopeEnv" is the whole
 * mechanism. Without this, the feature could be inert end-to-end while every
 * other test in the change stayed green.
 */
describe('bootstrap-su: PAPERCUSP_OMP_NATIVE_LSP (P-021)', () => {
  const ENV = 'PAPERCUSP_OMP_NATIVE_LSP';
  const envOf = async (body: Record<string, unknown>) =>
    (await (await callPost({ harness_slug: 'papercup', plan_slug: null, ...body })).json())
      .envelopeEnv?.[ENV];

  it('SETS the env for an omp launch on a cloud model', async () => {
    getFlagMock.mockResolvedValue(true);
    expect(await envOf({ agent: 'omp', model: 'claude-bridge/claude-opus-4-8:high' })).toBe('1');
  });

  it('does NOT set it for a LOCAL model — the tier gate holds even with the flag ON', async () => {
    getFlagMock.mockResolvedValue(true);
    expect(await envOf({ agent: 'omp', model: 'ollama-cc/ornith:fast' })).toBeUndefined();
  });

  it('does NOT set it when no model is given — omp falls back to its own local default', async () => {
    getFlagMock.mockResolvedValue(true);
    expect(await envOf({ agent: 'omp' })).toBeUndefined();
  });

  it('does NOT set it on a non-omp backend — the builtin is an omp concept', async () => {
    getFlagMock.mockResolvedValue(true);
    expect(await envOf({ agent: 'claude' })).toBeUndefined();
  });

  it('the flag is a real kill-switch at the route: OFF withholds the env', async () => {
    getFlagMock.mockResolvedValue(false);
    expect(await envOf({ agent: 'omp', model: 'claude-bridge/claude-opus-4-8:high' })).toBeUndefined();
  });
});

describe('EI-21365235532676472: failed-resume binding reclaim', () => {
  beforeEach(() => {
    dbState.advRows = [];
    dbState.beatRows = [];
    resolveSessionStatesMock.mockReset().mockResolvedValue(new Map());
    markAdvSessionEndedMock.mockClear();
  });

  it('uses the hydrated shared oracle and reclaims an ended stranded binding', async () => {
    dbState.advRows = [{ id: '900', display: 'terminal', has_session: true }];
    resolveSessionStatesMock.mockResolvedValueOnce(
      new Map([['su-dead01', { sessionState: 'ended' }]]),
    );
    const res = await callPost({ agent: 'claude', harness_slug: 'papercup', owner_id: 'su-dead01' });
    expect(res.status).toBe(200);
    expect(resolveSessionStatesMock).toHaveBeenCalledWith(
      [{ ownerId: 'su-dead01' }],
      { hydratePerId: true },
    );
    expect(markAdvSessionEndedMock).toHaveBeenCalledTimes(1);
    expect(markAdvSessionEndedMock).toHaveBeenCalledWith(900, null, 'reconciler');
    const json = await res.json();
    expect(json.error ?? '').not.toContain('already bound');
  });

  it('also reclaims a suspect stranded binding (claims-held terminal verdict)', async () => {
    dbState.advRows = [{ id: '901', display: 'terminal', has_session: true }];
    resolveSessionStatesMock.mockResolvedValueOnce(
      new Map([['su-suspect', { sessionState: 'suspect' }]]),
    );
    const res = await callPost({ agent: 'claude', harness_slug: 'papercup', owner_id: 'su-suspect' });
    expect(res.status).toBe(200);
    expect(markAdvSessionEndedMock).toHaveBeenCalledWith(901, null, 'reconciler');
  });

  it.each([
    ['recorded', 'su-recorded'],
    ['live', 'su-live01'],
    [null, 'su-unkn01'],
  ] as const)('keeps a %s oracle verdict blocking the pre-pinned owner', async (state, ownerId) => {
    dbState.advRows = [{ id: '902', display: 'terminal', has_session: true }];
    resolveSessionStatesMock.mockResolvedValueOnce(
      new Map([[ownerId, { sessionState: state }]]),
    );
    const res = await callPost({ agent: 'claude', harness_slug: 'papercup', owner_id: ownerId });
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(String(json.error)).toContain('already bound to live adv session 902');
    expect(markAdvSessionEndedMock).not.toHaveBeenCalled();
  });

  it('fails closed when the shared oracle read rejects', async () => {
    dbState.advRows = [{ id: '903', display: 'terminal', has_session: true }];
    resolveSessionStatesMock.mockRejectedValueOnce(new Error('oracle unavailable'));
    const res = await callPost({ agent: 'claude', harness_slug: 'papercup', owner_id: 'su-oracle-fail' });
    expect(res.status).toBe(409);
    expect(markAdvSessionEndedMock).not.toHaveBeenCalled();
  });
});
