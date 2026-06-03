import { describe, it, expect } from 'vitest';
import { buildGymOperatorBootSpec, type GymOperatorBootConfig } from '../boot-spec';

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

  it('throws when the harness commit is not a pinned SHA (D-016 demands a real pin)', () => {
    expect(() => buildGymOperatorBootSpec({ ...base, harnessCommit: 'main' })).toThrow();
  });

  it('sets AGENT_CMD only when provided; ALWAYS pins AGENT_MODELS to seal the inherited env', () => {
    // AGENT_CMD: caller-provided (gym callers always pass it).
    expect(buildGymOperatorBootSpec(base).env.AGENT_CMD).toBeUndefined();
    // AGENT_MODELS: always pinned — default '{}' so the launcher's inherited AGENT_MODELS
    // (e.g. .env.local's {worker:opus}) can't leak in and run the gym worker on a different
    // model than declared (reproducibility, D-016 + bounded cost).
    expect(JSON.parse(buildGymOperatorBootSpec(base).env.AGENT_MODELS)).toEqual({});
    const pinned = buildGymOperatorBootSpec({
      ...base,
      agentCmd: 'claude -p',
      agentModels: { worker: 'claude-sonnet-4-6' },
    });
    expect(pinned.env.AGENT_CMD).toBe('claude -p');
    expect(JSON.parse(pinned.env.AGENT_MODELS)).toEqual({ worker: 'claude-sonnet-4-6' });
  });
});
