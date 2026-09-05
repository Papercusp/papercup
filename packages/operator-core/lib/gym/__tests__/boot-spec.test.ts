import { describe, it, expect, afterEach, vi } from 'vitest';
import { AGENT_ROLES } from '@papercusp/agent-mcp';
import {
  buildGymOperatorBootSpec,
  scrubLauncherClaudeSessionEnv,
  gymWorkerInvokeTimeoutMs,
  DEFAULT_GYM_WORKER_INVOKE_TIMEOUT_MS,
  type GymOperatorBootConfig,
} from '../boot-spec';

/**
 * P-001 "minimal bootable unit": the dedicated gym-operator is ONE headless
 * operator+DBOS process booted from a PINNED papercup checkout (D-016), pointed
 * at a DEDICATED gym PG database (never the live one), on a DEDICATED port, with
 * the DBOS autoloop scoped (default: manual — the runner starts pipelines
 * explicitly for determinism). This pure builder yields the exact spawn spec;
 * the caller merges spec.env onto process.env so the explicit gym overrides win.
 */
const base: GymOperatorBootConfig = {
  pinnedCheckoutPath: '/scratch/gym/checkout',
  harnessCommit: '0123456789abcdef0123456789abcdef01234567',
  gymDatabaseUrl: 'postgresql://gym:pw@localhost:5432/papercusp_gym',
  honoPort: 3970,
  workspaceId: 'gym-ws',
};

describe('buildGymOperatorBootSpec', () => {
  it('runs the hono host from the pinned checkout apps/operator', () => {
    const spec = buildGymOperatorBootSpec(base);
    expect(spec.cwd).toBe('/scratch/gym/checkout/apps/operator');
    expect(spec.args).toContain('bin/hono-host.ts');
  });

  it('points BOTH admin-DSN resolution paths at the dedicated gym PG (hermetic isolation)', () => {
    const { env } = buildGymOperatorBootSpec(base);
    // getHarnessAdminUrl() reads HARNESS_ADMIN_DATABASE_URL > DATABASE_URL > embedded-pg.json.
    // Pin both so neither the live DATABASE_URL nor a live embedded-pg.json can leak in.
    expect(env.DATABASE_URL).toBe(base.gymDatabaseUrl);
    expect(env.HARNESS_ADMIN_DATABASE_URL).toBe(base.gymDatabaseUrl);
  });

  it('ALSO pins PAPERCUSP_DATABASE_URL — the key the WORKER subprocess pg-bootstrap reads', () => {
    // The worker subprocess (invoke-once → orchestrator pg-bootstrap.defaultDsn) resolves
    // its DSN from PAPERCUSP_DATABASE_URL > ~/.papercusp/embedded-pg.json > :5432/papercusp.
    // It does NOT read DATABASE_URL/HARNESS_ADMIN_DATABASE_URL. If the gym leaves this unset
    // the worker connects to the LIVE dev DB (a hermeticity breach) where the gym harness
    // schema doesn't exist → `UPDATE harness_features` 42P01s. Pin it to the gym PG so the
    // worker (inheriting the operator's env) connects to the dedicated gym database.
    const { env } = buildGymOperatorBootSpec(base);
    expect(env.PAPERCUSP_DATABASE_URL).toBe(base.gymDatabaseUrl);
  });

  it('enables DBOS, pins the port, bind host, and workspace', () => {
    const { env } = buildGymOperatorBootSpec(base);
    expect(env.PAPERCUSP_DBOS_ENABLE).toBe('1');
    expect(env.PAPERCUSP_HONO_PORT).toBe('3970');
    expect(env.PAPERCUSP_BIND_HOST).toBe('127.0.0.1');
    expect(env.PAPERCUSP_WORKSPACE_ID).toBe('gym-ws');
    // Not the desktop/IPC context.
    expect(env.PAPERCUSP_IPC_ENABLE).toBe('0');
    // EI-368: headless utility profile — no voice cluster / hyperbee substrate /
    // embedder warm-up in the gym-operator (native-surface containment).
    expect(env.PAPERCUSP_UTILITY_HOST).toBe('1');
  });

  it('seals backgroundWorkers ON + blanks VITEST so DBOS launches (readiness gate) regardless of inherited env', () => {
    // The readiness gate is `dbosEnabled ? dbosLaunched : true`; backgroundWorkersEnabled()
    // (which bundles the DBOS launch) defaults OFF under VITEST or an inherited
    // PAPERCUSP_BACKGROUND_WORKERS=0. Without sealing these the gym operator binds HTTP but
    // /api/health/ready stays 503 → the 120s readiness timeout. The spec must pin them.
    const { env } = buildGymOperatorBootSpec(base);
    expect(env.PAPERCUSP_BACKGROUND_WORKERS).toBe('1');
    expect(env.VITEST).toBe('');
  });

  it('pins the dedicated gym operator to one process so DBOS serves its HTTP requests', () => {
    // The shared dev shell exports PAPERCUSP_CLUSTER/PAPERCUSP_CLUSTER_WORKERS.
    // If those leak into the gym child, only the clustered primary launches DBOS
    // while request workers call DBOS APIs before launch.
    const { env } = buildGymOperatorBootSpec(base);
    expect(env.PAPERCUSP_CLUSTER).toBe('0');
    expect(env.PAPERCUSP_CLUSTER_WORKERS).toBe('0');
  });

  it('defaults the autoloop to manual (none) so runs are started explicitly', () => {
    expect(buildGymOperatorBootSpec(base).env.PAPERCUSP_DBOS_ORCHESTRATOR_HARNESSES).toBe('none');
    expect(buildGymOperatorBootSpec({ ...base, autoloopScope: 'gym-x,gym-y' }).env.PAPERCUSP_DBOS_ORCHESTRATOR_HARNESSES)
      .toBe('gym-x,gym-y');
  });

  it('pins DBOS app-version to the harness commit — isolates gym DBOS + stable recovery', () => {
    const { env } = buildGymOperatorBootSpec(base);
    expect(env.DBOS__APPVERSION).toContain('0123456789ab');
    // deterministic
    expect(buildGymOperatorBootSpec(base).env.DBOS__APPVERSION).toBe(env.DBOS__APPVERSION);
  });

  it('WI-2604: blanks PAPERCUSP_MCP_PROXY_BASE so spawned eval agents hand-shake THIS instance, not a leaked live-operator proxy', () => {
    // bg-host's dev-api service sets PAPERCUSP_MCP_PROXY_BASE (fronting the LIVE :3070
    // operator). Both resolveSpawnOperatorBase (spawn-mcp.ts) and resolveAgentMcpBaseUrl
    // (mcp-base-url.ts) check this env var BEFORE the spawning host's own
    // PAPERCUSP_HONO_PORT, so an unblanked leak pointed every gym eval agent's .mcp.json
    // at the live operator instead of this dedicated gym-operator — which verifies
    // against a DIFFERENT spawn-signing-key (the live DB's, not the gym DB's preminted
    // one) → invalid_signature on every spawn.
    const { env } = buildGymOperatorBootSpec(base);
    expect(env.PAPERCUSP_MCP_PROXY_BASE).toBe('');
  });

  it('throws when the harness commit is not a pinned SHA (D-016 demands a real pin)', () => {
    expect(() => buildGymOperatorBootSpec({ ...base, harnessCommit: 'main' })).toThrow();
  });

  it('EI-481: widens PAPERCUSP_DBOS_INVOKE_TIMEOUT_MS to the gym-operator default (wider than the shared 45min fleet default)', () => {
    const { env } = buildGymOperatorBootSpec(base);
    expect(env.PAPERCUSP_DBOS_INVOKE_TIMEOUT_MS).toBe(String(DEFAULT_GYM_WORKER_INVOKE_TIMEOUT_MS));
    expect(DEFAULT_GYM_WORKER_INVOKE_TIMEOUT_MS).toBeGreaterThan(45 * 60 * 1000);
  });

  it('EI-481: cfg.invokeTimeoutMs overrides the default', () => {
    const { env } = buildGymOperatorBootSpec({ ...base, invokeTimeoutMs: 123_000 });
    expect(env.PAPERCUSP_DBOS_INVOKE_TIMEOUT_MS).toBe('123000');
  });

  it('sets AGENT_CMD only when provided and pins every built-in role to canonical Sol xhigh', () => {
    // AGENT_CMD: caller-provided (gym callers always pass it).
    expect(buildGymOperatorBootSpec(base).env.AGENT_CMD).toBeUndefined();
    // AGENT_MODELS: always pinned so neither inherited overrides nor heterogeneous
    // committed role floors can move a Gym-spawned role off the learning policy.
    const defaults = JSON.parse(buildGymOperatorBootSpec(base).env.AGENT_MODELS) as Record<string, string>;
    expect(Object.keys(defaults).sort()).toEqual([...AGENT_ROLES].sort());
    expect(new Set(Object.values(defaults))).toEqual(new Set(['gpt-5.6-sol:xhigh']));

    // Zero-LLM fixtures can explicitly suppress model resolution so a Codex-shaped
    // spec does not backend-swap their injected Node command.
    const pinned = buildGymOperatorBootSpec({
      ...base,
      agentCmd: 'node fake-agent.js',
      agentModels: {},
    });
    expect(pinned.env.AGENT_CMD).toBe('node fake-agent.js');
    expect(JSON.parse(pinned.env.AGENT_MODELS)).toEqual({});
  });
});

describe('gymWorkerInvokeTimeoutMs (EI-481)', () => {
  const ENV_KEY = 'PAPERCUSP_GYM_WORKER_INVOKE_TIMEOUT_MS';
  const original = process.env[ENV_KEY];
  afterEach(() => {
    if (original === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = original;
  });

  it('defaults to DEFAULT_GYM_WORKER_INVOKE_TIMEOUT_MS when unset', () => {
    delete process.env[ENV_KEY];
    expect(gymWorkerInvokeTimeoutMs()).toBe(DEFAULT_GYM_WORKER_INVOKE_TIMEOUT_MS);
  });

  it('honors a valid positive override', () => {
    process.env[ENV_KEY] = '600000';
    expect(gymWorkerInvokeTimeoutMs()).toBe(600_000);
  });

  it('fails soft (with a warning) to the default on a non-numeric / non-positive value', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      process.env[ENV_KEY] = 'not-a-number';
      expect(gymWorkerInvokeTimeoutMs()).toBe(DEFAULT_GYM_WORKER_INVOKE_TIMEOUT_MS);
      process.env[ENV_KEY] = '-5';
      expect(gymWorkerInvokeTimeoutMs()).toBe(DEFAULT_GYM_WORKER_INVOKE_TIMEOUT_MS);
      process.env[ENV_KEY] = '0';
      expect(gymWorkerInvokeTimeoutMs()).toBe(DEFAULT_GYM_WORKER_INVOKE_TIMEOUT_MS);
      expect(warn).toHaveBeenCalledTimes(3);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('scrubLauncherClaudeSessionEnv (EI-232)', () => {
  it('deletes every launcher Claude-Code session var so a real-mode gym agent auths against ~/.claude, not the launcher session', () => {
    const leaked: NodeJS.ProcessEnv = {
      PATH: '/usr/bin',
      CLAUDE_CONFIG_DIR: '/home/agent/.papercusp/session-claude/su-abc123',
      CLAUDE_CODE_SESSION_ID: 'su-abc123',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDECODE: '1',
    };
    const scrubbed = scrubLauncherClaudeSessionEnv(leaked);
    expect(scrubbed.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(scrubbed.CLAUDE_CODE_SESSION_ID).toBeUndefined();
    expect(scrubbed.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(scrubbed.CLAUDECODE).toBeUndefined();
    // Untouched vars survive.
    expect(scrubbed.PATH).toBe('/usr/bin');
  });

  it('mutates the passed object in place AND returns it (matches spawn({env}) call shape)', () => {
    const env: NodeJS.ProcessEnv = { CLAUDE_CONFIG_DIR: '/leaked' };
    const returned = scrubLauncherClaudeSessionEnv(env);
    expect(returned).toBe(env);
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
  });

  it('is a no-op (no throw) when none of the four vars are present', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    expect(() => scrubLauncherClaudeSessionEnv(env)).not.toThrow();
    expect(env).toEqual({ PATH: '/usr/bin' });
  });
});
