import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const advSessionRowsMock = vi.hoisted(() => vi.fn(async () => [] as unknown[]));
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: advSessionRowsMock }),
}));

import {
  isDeadTerminalLaunch,
  isFailedTerminalLaunch,
  fallbackCodexLaunchSpecFromAdvSession,
  readAdvSessionLaunchRecordByOwner,
  markAdvSessionShutdownAcceptedByOwner,
  shutdownAcceptedOwnerIds,
  toIsoTimestamp,
  type AdvSessionRow,
} from './adv-sessions';

const SOURCE = readFileSync(new URL('./adv-sessions.ts', import.meta.url), 'utf8');

beforeEach(() => {
  advSessionRowsMock.mockReset();
  advSessionRowsMock.mockResolvedValue([]);
});

describe('readAdvSessionLaunchRecordByOwner', () => {
  it('maps the newest owner-scoped launch record and keeps the query schema-safe', async () => {
    const launchSpec = { v: 1, workspaceId: 'ws-test', fleet: { slug: 'byoc' } };
    const launchArgv = ['psu', '--fleet=byoc'];
    advSessionRowsMock.mockResolvedValueOnce([
      { workspace_id: 'ws-test', launch_spec: launchSpec, launch_argv: launchArgv },
    ]);

    await expect(readAdvSessionLaunchRecordByOwner('su-member', 'ws-test')).resolves.toEqual({
      workspaceId: 'ws-test',
      launchSpec,
      launchArgv,
    });
    const template = (advSessionRowsMock.mock.calls as unknown[][])[0]?.[0];
    expect(Array.isArray(template)).toBe(true);
    expect((template as readonly string[]).join(' ')).toContain("to_jsonb(a)->'launch_spec'");
    expect((template as readonly string[]).join(' ')).toContain("to_jsonb(a)->'launch_argv'");
  });
});

describe('accepted session shutdown marker (EI-21266145962856513)', () => {
  it('marks only the newest still-open row for an owner', async () => {
    advSessionRowsMock.mockResolvedValueOnce([{ id: 42 }]);
    await expect(markAdvSessionShutdownAcceptedByOwner('su-holder')).resolves.toBe(true);
    const template = (advSessionRowsMock.mock.calls as unknown[][])[0]?.[0];
    expect((template as readonly string[]).join(' ')).toContain('shutdown_accepted_at = now()');
    expect((template as readonly string[]).join(' ')).toContain('ended_at IS NULL');
    expect((template as readonly string[]).join(' ')).toContain('ORDER BY started_at DESC');
  });

  it('reads the marker only from each owner\'s newest row', async () => {
    advSessionRowsMock.mockResolvedValueOnce([
      { coord_owner_id: 'su-marked', shutdown_accepted_at: '2026-08-23T19:00:00Z' },
      { coord_owner_id: 'su-live', shutdown_accepted_at: null },
    ]);
    await expect(shutdownAcceptedOwnerIds(['su-marked', 'su-live', 'fed:remote'])).resolves.toEqual(
      new Set(['su-marked']),
    );
    const template = (advSessionRowsMock.mock.calls as unknown[][])[0]?.[0];
    expect((template as readonly string[]).join(' ')).toContain('DISTINCT ON (coord_owner_id)');
    expect((template as readonly string[]).join(' ')).toContain('ORDER BY coord_owner_id, started_at DESC');
  });

  it('clears accepted shutdown across every reactivation and re-anchor path', () => {
    for (const fn of [
      'claimAdvSessionResume',
      'reactivateAdvSessionByOwner',
      'reanchorAdvSessionNativeId',
      'reanchorAdvSessionNativeIdByOwner',
    ]) {
      const from = SOURCE.indexOf('export async function ' + fn);
      expect(from, fn).toBeGreaterThan(-1);
      const tail = SOURCE.slice(from, from + 3000);
      expect(tail, fn).toMatch(/shutdown_accepted_at = NULL/);
    }
  });
});

describe('fallbackCodexLaunchSpecFromAdvSession', () => {
  const row = (over: Partial<AdvSessionRow> = {}): AdvSessionRow =>
    ({
      id: 16512,
      workspaceId: 'papercusp-workspace',
      harnessSlug: null,
      planSlug: 'drain-plan',
      agent: 'codex',
      coordOwnerId: 'su-current',
      ...over,
    }) as AdvSessionRow;

  it('reconstructs a conservative workspace-scoped Codex launch record', () => {
    expect(fallbackCodexLaunchSpecFromAdvSession(row(), 'su-current')).toEqual({
      v: 1,
      agent: 'codex',
      workspaceId: 'papercusp-workspace',
      harnessSlug: null,
      profile: 'engineer',
      contextSize: null,
      personaTier: null,
      model: null,
      planSlug: 'drain-plan',
      launchedBy: null,
      autoMode: false,
      drainMode: false,
      loopArmed: false,
      fleet: null,
    });
  });

  it('preserves a recorded concrete harness when one exists', () => {
    expect(fallbackCodexLaunchSpecFromAdvSession(row({ harnessSlug: 'papercusp' }), 'su-current')?.harnessSlug).toBe(
      'papercusp',
    );
  });

  it('refuses a different owner or non-Codex session', () => {
    expect(fallbackCodexLaunchSpecFromAdvSession(row(), 'su-other')).toBeNull();
    expect(fallbackCodexLaunchSpecFromAdvSession(row({ agent: 'claude' }), 'su-current')).toBeNull();
  });
});

/**
 * WI-6589 — `first_seen_at` must stay a BIRTH, so nothing may bump it.
 *
 * This is a source-level guard rather than a behavioural one on purpose: the bug
 * it prevents is invisible to any unit test that seeds rows itself. The old
 * floor read `MIN(started_at)`, and `started_at` IS bumped in place by four
 * resume/re-anchor paths in this file — so production kept exactly one row per
 * coord owner and MIN === MAX === the latest launch. A test that seeds two rows
 * for one owner asserts a shape production cannot produce and passes while the
 * system is broken (measured: 6,957 targeted messages across 78 owners sat below
 * their computed floor). The only durable invariant is the one enforced here:
 * `first_seen_at` is written at INSERT and never again.
 */
describe('adv_sessions birth timestamp (WI-6589)', () => {
  it('the coord-owner birth floor reads first_seen_at, never the bumped started_at', () => {
    expect(SOURCE).toMatch(/SELECT MIN\(first_seen_at\) AS started_at/);
    expect(SOURCE).not.toMatch(/SELECT MIN\(started_at\)/);
  });

  it('no UPDATE statement in this module touches first_seen_at', () => {
    const offending = SOURCE.split('UPDATE harness_shared.adv_sessions')
      .slice(1)
      // Each fragment runs to the end of its tagged-template literal.
      .map((tail) => tail.slice(0, tail.indexOf('`')))
      .filter((stmt) => stmt.includes('first_seen_at'));
    expect(offending).toEqual([]);
  });

  it('recordAdvSession leaves first_seen_at to its column DEFAULT', () => {
    // Naming it in the INSERT would let a caller pass a value, which is the same
    // hole by another route.
    const inserts = SOURCE.split('INSERT INTO harness_shared.adv_sessions')
      .slice(1)
      .map((tail) => tail.slice(0, tail.indexOf('`')));
    expect(inserts.length).toBeGreaterThan(0);
    expect(inserts.filter((stmt) => stmt.includes('first_seen_at'))).toEqual([]);
  });
});

/**
 * WI-37743 — `adoptStartingTerminalLaunch` COMPLETES a launcher's own starting
 * row instead of inserting a duplicate beside it. Its entire safety rests on
 * three conjuncts in one WHERE clause, so they are guarded here.
 *
 * Source-level, like the birth-timestamp guards above and for the same reason:
 * the failure this prevents is a row-SELECTION bug, and a unit test that seeds
 * its own rows proves only that the statement runs — it cannot show which rows
 * a weakened predicate would ALSO have matched. Dropping `session_id IS NULL`
 * is the dangerous one: the UPDATE would then overwrite the session_id of a
 * LIVE session's row, silently re-pointing the board at the wrong process. That
 * is invisible to a behavioural test that never seeds a live row to be stolen.
 */
describe('adoptStartingTerminalLaunch is narrowly guarded (WI-37743)', () => {
  const adopt = (() => {
    const from = SOURCE.indexOf('export async function adoptStartingTerminalLaunch');
    expect(from).toBeGreaterThan(-1);
    const stmt = SOURCE.slice(from);
    return stmt.slice(0, stmt.indexOf('RETURNING id'));
  })();

  it('only ever touches a row that has NO session yet', () => {
    // Without this, adopting steals a live session's row.
    expect(adopt).toMatch(/AND session_id IS NULL/);
  });

  it('only ever touches a row that has not ended', () => {
    // A reconciler-stamped row is a CLOSED launch; completing it would resurrect it.
    expect(adopt).toMatch(/AND ended_at IS NULL/);
  });

  it('only ever touches a terminal-launch row, never a workbench/console row', () => {
    expect(adopt).toMatch(/AND display = \$\{DISPLAY_TERMINAL_LAUNCH\}/);
  });

  it('is pinned to one explicit row id — never a predicate-only match', () => {
    // The caller resolves WHICH precursor (newest wins); this statement must not
    // widen that to "any starting row for this owner".
    expect(adopt).toMatch(/WHERE id = \$\{opts\.id\}/);
  });

  it('COALESCEs the optional columns so adopting cannot blank existing values', () => {
    // The launcher's row already carries plan_slug/label/cwd; a plain assignment
    // would null them out whenever bootstrap happens not to pass one.
    for (const col of ['plan_slug', 'label', 'cwd', 'mode', 'launch_argv']) {
      expect(adopt).toMatch(new RegExp(`${col}\\s*=\\s*COALESCE\\(`));
    }
  });

  it('assigns session_id unconditionally — it is the whole point of adopting', () => {
    // COALESCE here would make the adopt a no-op on the column that matters.
    expect(adopt).toMatch(/SET session_id = \$\{opts\.sessionId\}/);
  });
});

describe('toIsoTimestamp', () => {
  it('passes Date objects through to ISO', () => {
    const value = new Date('2026-05-24T20:38:01.608Z');
    expect(toIsoTimestamp(value)).toBe('2026-05-24T20:38:01.608Z');
  });

  it('normalizes postgres text timestamps to ISO', () => {
    expect(toIsoTimestamp('2026-05-24 16:38:01.608162-04')).toBe('2026-05-24T20:38:01.608Z');
  });

  it('returns null for nullish values', () => {
    expect(toIsoTimestamp(null)).toBeNull();
    expect(toIsoTimestamp(undefined)).toBeNull();
  });

  it('throws on invalid timestamps', () => {
    expect(() => toIsoTimestamp('not-a-timestamp')).toThrow(/invalid timestamp/i);
  });
});

/**
 * WI-6821 — the owner clicked "+ new session", the launch died, and the popup sat
 * on "Starting up — waiting for this session to come online…" because NOTHING
 * ever marked the row failed. A dead launch and a still-booting one were
 * indistinguishable, so the roster advertised the corpse for the whole window and
 * the only correction was a 60s client-side timer (a guess, not evidence).
 *
 * These pin the two predicates that make the difference an OBSERVATION. Both are
 * pure with an injected `pidAlive`, so the decision is provable without spawning
 * real processes — which is the point: detection must be testable, not merely
 * watched in production.
 */
describe('terminal-launch death detection (WI-6821)', () => {
  const launch = (over: Partial<AdvSessionRow> = {}): AdvSessionRow =>
    ({
      id: 1,
      display: 'terminal',
      pid: 4242,
      sessionId: null,
      endedAt: null,
      ...over,
    }) as AdvSessionRow;

  const gone = () => false;
  const alive = () => true;

  describe('isDeadTerminalLaunch', () => {
    it('calls a terminal launch dead when its pid is gone and it never registered', () => {
      expect(isDeadTerminalLaunch(launch(), gone)).toBe(true);
    });

    it('never calls a launch dead while its terminal process is still alive', () => {
      expect(isDeadTerminalLaunch(launch(), alive)).toBe(false);
    });

    // The safe direction, and the one that matters under pid-wrap (~daily on this
    // box): a RECYCLED pid can only ever read alive, so wrap can make us MISS a
    // dead launch — it can never make us declare a live one dead.
    it('treats a registered session as booted even if its recorded pid is gone', () => {
      expect(isDeadTerminalLaunch(launch({ sessionId: 'sess-1' }), gone)).toBe(false);
    });

    // No handle means NO EVIDENCE. Guessing here would fabricate a diagnosis,
    // which is the exact bug class this item exists to remove.
    it('says nothing about a launch with no recorded pid', () => {
      expect(isDeadTerminalLaunch(launch({ pid: null }), gone)).toBe(false);
    });

    it('leaves an already-reconciled row alone', () => {
      expect(isDeadTerminalLaunch(launch({ endedAt: '2026-08-02T02:25:00.000Z' }), gone)).toBe(
        false,
      );
    });

    // Only `display='terminal'` rows are local by construction, which is what
    // makes the pid a sound liveness handle without a host column.
    it('refuses to probe a row that is not a terminal launch', () => {
      expect(isDeadTerminalLaunch(launch({ display: 'workbench' }), gone)).toBe(false);
      expect(isDeadTerminalLaunch(launch({ display: null }), gone)).toBe(false);
    });
  });

  describe('isFailedTerminalLaunch', () => {
    it('reads failure off PERSISTED state — ended, never registered', () => {
      expect(isFailedTerminalLaunch(launch({ endedAt: '2026-08-02T02:25:00.000Z' }))).toBe(true);
    });

    it('is false while the launch is still within its boot window', () => {
      expect(isFailedTerminalLaunch(launch())).toBe(false);
    });

    // A session that booted and later ended is an ORDINARY end and belongs in the
    // `ended` list — calling it a failed launch would be a second kind of lie.
    it('is false for a session that registered before it ended', () => {
      expect(
        isFailedTerminalLaunch(launch({ endedAt: '2026-08-02T02:25:00.000Z', sessionId: 'sess-1' })),
      ).toBe(false);
    });
  });

  // We never reap this process — it is not our child — so we never observe a
  // status. Writing a sentinel would invent a fact, which is precisely the
  // failure mode being fixed; `session_id IS NULL` is the marker we actually know.
  it('the reconciler stamps ended_at and does NOT invent an exit_code', () => {
    const stmt = SOURCE.split('UPDATE harness_shared.adv_sessions')
      .slice(1)
      .map((tail) => tail.slice(0, tail.indexOf('`')))
      .find((s) => s.includes('session_id IS NULL') && s.includes('ended_at = now()'));
    expect(stmt).toBeDefined();
    expect(stmt).not.toMatch(/exit_code\s*=/);
  });

  // Dropping the row instead of flagging it would leave SessionChatModal to fall
  // through to "No recent Claude session found for this agent" — replacing a
  // spinner with a shrug. The tier must still SELECT the failed row.
  it('the starting tier still selects launches that ended without registering', () => {
    expect(SOURCE).toMatch(/AND \(ended_at IS NULL OR session_id IS NULL\)/);
  });
});
