/**
 * agent-attribution-contract.test.ts — WI-1500: the backend-coverage CONTRACT for
 * agent attribution (the "claude-only seam" regression class).
 *
 * The gpt-5.4 backend switch broke THREE attribution surfaces one by one — the TUI
 * transcript mirror (no session id), the placement-watchdog zombie signal
 * (agent_activity empty for codex), and roster labels — each because the surface was
 * populated/consumed for the claude backend only and NOTHING failed the build when a
 * backend landed without coverage.
 *
 * The contract mechanism is TOTALITY over `InteractiveBackend`: every fixture /
 * expectation table below is a `Record<InteractiveBackend, ...>`, so
 *   • ADDING a backend to the union without adding its attribution fixtures here is
 *     a TYPE error (the build goes red before the backend ships uncovered), and
 *   • REMOVING/regressing a surface's per-backend population turns a runtime
 *     expectation red (a missing durable key must degrade to an EXPLICIT
 *     missingReason — silent absence is exactly the seam class).
 * Registered as the `agent-attribution` area of BACKEND_PARITY_SMOKE_MATRIX, whose
 * own test pins this file's existence.
 */
import { describe, expect, it } from 'vitest';
import type { AdvSessionRow } from './adv-sessions';
import {
  BACKEND_FEATURE_CAPABILITIES,
  accountProviderForInteractiveBackend,
  type InteractiveBackend,
} from './backend-feature-capabilities';
import { isSessionThinking } from './claude-sessions';
import {
  nativeSessionHandleForAdvSession,
  nativeSessionHandleForSpawnedAgent,
  type NativeSessionDeps,
  type SpawnedAgentNativeSessionInput,
} from './native-session-handles';
import { isCodexSessionThinking, isOmpThreadThinking } from './session-transcript-resolvers';

/** The enabled-backend enumeration, derived from the capability table (the source of
 *  truth a new backend MUST be added to) — never a hand-maintained copy. */
const BACKENDS = Object.keys(BACKEND_FEATURE_CAPABILITIES) as InteractiveBackend[];

const adv = (overrides: Partial<AdvSessionRow> = {}): AdvSessionRow => ({
  id: 7,
  workspaceId: 'ws',
  planSlug: null,
  agent: 'claude',
  role: null,
  feature: null,
  mode: 'console',
  terminalBin: null,
  pid: null,
  windowId: null,
  ompThreadId: null,
  label: null,
  cwd: '/repo',
  coordOwnerId: 'su-attr',
  sessionId: null,
  display: null,
  launchArgv: null,
  launchedAt: null,
  startedAt: '2026-07-02T00:00:00.000Z',
  endedAt: null,
  exitCode: null,
  ...overrides,
});

/** Canonical FULLY-ATTRIBUTED spawned_agents fixture per backend. */
const SPAWNED_POPULATED: Record<InteractiveBackend, SpawnedAgentNativeSessionInput> = {
  claude: { spawnId: 's-claude', sessionOwner: 'owner-claude', backend: 'claude', sessionId: 'claude-native-uuid' },
  codex: { spawnId: 's-codex', sessionOwner: 'owner-codex', backend: 'codex', codexHome: '/codex/home-1', rolloutId: 'rollout-1' },
  omp: { spawnId: 's-omp', sessionOwner: 'owner-omp', backend: 'omp', ompThreadId: 'thread-1', agentHome: '/omp/agent' },
};

/** The same fixture with the durable key ABSENT — must degrade explicitly. */
const SPAWNED_BARE: Record<InteractiveBackend, SpawnedAgentNativeSessionInput> = {
  claude: { spawnId: 's-claude-bare', backend: 'claude' },
  codex: { spawnId: 's-codex-bare', backend: 'codex' },
  omp: { spawnId: 's-omp-bare', backend: 'omp' },
};

/** Canonical FULLY-ATTRIBUTED adv_sessions fixture per backend. */
const ADV_POPULATED: Record<InteractiveBackend, { row: AdvSessionRow; deps?: NativeSessionDeps }> = {
  claude: { row: adv({ agent: 'claude', sessionId: 'claude-adv-session' }) },
  codex: {
    row: adv({ agent: 'codex' }),
    deps: { codexHomeForSessionKey: (key) => `/codex/adv-${key}`, findCodexRolloutId: () => 'rollout-adv' },
  },
  omp: { row: adv({ agent: 'omp', ompThreadId: 'thread-adv' }), deps: { ompAgentHome: () => '/omp/agent' } },
};

/** The adv_sessions leg with the durable key not (yet) linked. */
const ADV_UNLINKED: Record<InteractiveBackend, { row: AdvSessionRow; deps?: NativeSessionDeps }> = {
  claude: { row: adv({ agent: 'claude', sessionId: null }) },
  codex: {
    row: adv({ agent: 'codex' }),
    deps: { codexHomeForSessionKey: (key) => `/codex/adv-${key}`, findCodexRolloutId: () => null },
  },
  omp: { row: adv({ agent: 'omp', ompThreadId: null }), deps: { ompAgentHome: () => '/omp/agent' } },
};

/** The transcript/"thinking" resolver each backend contributes to the roster (the
 *  TUI-transcript-mirror seam): claude keys by native sessionId, codex by its
 *  per-session CODEX_HOME (adv row id), omp by thread id — see adv-roster's dispatch. */
const TRANSCRIPT_THINKING_RESOLVER: Record<InteractiveBackend, unknown> = {
  claude: isSessionThinking,
  codex: isCodexSessionThinking,
  omp: isOmpThreadThinking,
};

describe('agent attribution backend contract (WI-1500)', () => {
  it('derives a non-empty backend enumeration from the capability table', () => {
    expect(BACKENDS.length).toBeGreaterThan(0);
  });

  it('every backend declares the identical feature set (no backend silently missing capability rows)', () => {
    const [first, ...rest] = BACKENDS;
    const expected = Object.keys(BACKEND_FEATURE_CAPABILITIES[first]).sort();
    for (const backend of rest) {
      expect(Object.keys(BACKEND_FEATURE_CAPABILITIES[backend]).sort(), backend).toEqual(expected);
    }
  });

  it('every backend yields a POPULATED spawned-agent handle from its canonical fixture', () => {
    for (const backend of BACKENDS) {
      const handle = nativeSessionHandleForSpawnedAgent(SPAWNED_POPULATED[backend]);
      expect(handle.backend, backend).toBe(backend);
      expect(handle.source, backend).toBe('spawned_agents');
      expect(handle.ownerId, backend).toBe(`owner-${backend}`);
      expect(handle.exactResumeSupported, backend).toBe(true);
      expect(handle.missingReason, backend).toBeNull();
    }
  });

  it('a spawned handle missing its durable key degrades EXPLICITLY (missingReason set), never silently', () => {
    for (const backend of BACKENDS) {
      const handle = nativeSessionHandleForSpawnedAgent(SPAWNED_BARE[backend]);
      expect(handle.backend, backend).toBe(backend);
      expect(handle.exactResumeSupported, backend).toBe(false);
      expect(handle.missingReason, backend).toBeTruthy();
    }
  });

  it('every backend yields a POPULATED adv_sessions handle from its canonical fixture', () => {
    for (const backend of BACKENDS) {
      const { row, deps } = ADV_POPULATED[backend];
      const handle = nativeSessionHandleForAdvSession(row, deps);
      expect(handle, backend).not.toBeNull();
      expect(handle?.backend, backend).toBe(backend);
      expect(handle?.source, backend).toBe('adv_sessions');
      expect(handle?.ownerId, backend).toBe('su-attr');
      expect(handle?.exactResumeSupported, backend).toBe(true);
      expect(handle?.missingReason, backend).toBeNull();
    }
  });

  it('an unlinked adv_sessions row still resolves a handle with an EXPLICIT missing reason', () => {
    for (const backend of BACKENDS) {
      const { row, deps } = ADV_UNLINKED[backend];
      const handle = nativeSessionHandleForAdvSession(row, deps);
      expect(handle, backend).not.toBeNull();
      expect(handle?.backend, backend).toBe(backend);
      expect(handle?.exactResumeSupported, backend).toBe(false);
      expect(handle?.missingReason, backend).toBeTruthy();
    }
  });

  it('every backend contributes a transcript/thinking resolver to the roster', () => {
    for (const backend of BACKENDS) {
      expect(typeof TRANSCRIPT_THINKING_RESOLVER[backend], backend).toBe('function');
    }
  });

  it('every backend maps to an account provider (account/usage attribution)', () => {
    for (const backend of BACKENDS) {
      expect(accountProviderForInteractiveBackend(backend), backend).toBeTruthy();
    }
  });
});
