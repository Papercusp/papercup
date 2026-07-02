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
  });
});
