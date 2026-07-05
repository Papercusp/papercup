/**
 * boot-spec — hermeticity recurrence guard (gym-unwedge-scout-novelty-2026-07-02
 * GYM-1). The gym-operator inherits bg-host's env via a `...process.env` spread,
 * so EVERY DSN key any resolver consults must be pinned to the gym container URI
 * — one unpinned key (HARNESS_DATABASE_URL, the org-pg APP resolver's TOP
 * precedence, which never falls back to DATABASE_URL) sent the operator to the
 * live PG's hardcoded default credentials and killed every gym cycle for 12 days.
 */
import { describe, expect, it } from 'vitest';
import { buildGymOperatorBootSpec } from './boot-spec';

describe('buildGymOperatorBootSpec — hermetic DSN pinning', () => {
  it('pins EVERY consulted DSN key to the gym database', () => {
    const spec = buildGymOperatorBootSpec({
      pinnedCheckoutPath: '/tmp/repo',
      harnessCommit: 'a'.repeat(40),
      gymDatabaseUrl: 'postgresql://test:test@127.0.0.1:59999/gym',
      honoPort: 3976,
      workspaceId: 'ws-test',
      agentCmd: 'node fake-agent.js',
    });
    // The full consulted set: getHarnessAdminUrl (HARNESS_ADMIN > DATABASE_URL),
    // the org-pg APP resolver (HARNESS_DATABASE_URL, top precedence, no
    // DATABASE_URL fallback), and the worker pg-bootstrap (PAPERCUSP_DATABASE_URL).
    for (const key of [
      'DATABASE_URL',
      'HARNESS_ADMIN_DATABASE_URL',
      'HARNESS_DATABASE_URL',
      'PAPERCUSP_DATABASE_URL',
    ]) {
      expect(spec.env[key], `${key} must be pinned to the gym DB`).toBe(
        'postgresql://test:test@127.0.0.1:59999/gym',
      );
    }
    // Layer-3: the URL-REWRITE inputs must be pinned too — pgbouncerEnabled()
    // defaults ON for server-class hosts and would re-point the pinned URL at
    // the live pooler (:6432) whose credentials the container lacks.
    expect(spec.env.PAPERCUSP_PGBOUNCER, 'sandbox must dial its container DIRECTLY').toBe('0');
    // Layer-5: the WORKSPACE-RESOLUTION leaks must be pinned too — a leaked
    // PAPERCUSP_HIVE_HOME_SLUG fatals home-harness validation against the
    // hermetic registry (the gym operator runs no hive).
    expect(spec.env.PAPERCUSP_HIVE_HOME_SLUG, 'gym operator runs NO hive').toBe('');
    // WI-2604 root cause (1): a leaked PAPERCUSP_MCP_PROXY_BASE (bg-host's dev-api
    // service sets it, fronting the LIVE :3070 operator) makes resolveSpawnOperatorBase
    // / resolveAgentMcpBaseUrl point every gym eval agent's .mcp.json at the LIVE
    // operator instead of this dedicated gym instance — which verifies against a
    // DIFFERENT spawn-signing-key (live DB, not this gym DB's preminted one) →
    // invalid_signature on every spawn.
    expect(spec.env.PAPERCUSP_MCP_PROXY_BASE, 'eval agents must hand-shake THIS instance, not a leaked live proxy').toBe('');
  });
});
