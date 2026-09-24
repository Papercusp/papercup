import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { advSessionRowsMock, advSessionBeginMock } = vi.hoisted(() => {
  const sql = vi.fn(async () => [] as unknown[]);
  const begin = vi.fn(async (fn: (tx: typeof sql) => unknown) => fn(sql));
  return { advSessionRowsMock: sql, advSessionBeginMock: begin };
});
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: Object.assign(advSessionRowsMock, { begin: advSessionBeginMock }) }),
}));

import {
  isDeadTerminalLaunch,
  isFailedTerminalLaunch,
  acquireAdvSessionResume,
  fallbackCodexLaunchSpecFromAdvSession,
  hasAdvSessionTerminalEvidence,
  isAdvSessionLocalLivenessEvidence,
  advSessionLivenessEvidenceCoversAgent,
  ADV_SESSION_LIVENESS_EVIDENCE_AGENT,
  getLatestActiveAdvSessionByOwner,
  readAdvSessionLaunchRecordByOwner,
  listResumableSessions,
  markAdvSessionShutdownAcceptedByOwner,
  reactivateAdvSessionByOwner,
  repairStaleAdvSessionTerminalMarkers,
  shutdownAcceptedOwnerIds,
  toIsoTimestamp,
  type AdvSessionRow,
} from './adv-sessions';

const SOURCE = readFileSync(new URL('./adv-sessions.ts', import.meta.url), 'utf8');

beforeEach(() => {
  advSessionRowsMock.mockReset();
  advSessionRowsMock.mockResolvedValue([]);
  advSessionBeginMock.mockReset();
  advSessionBeginMock.mockImplementation(async (fn: (tx: typeof advSessionRowsMock) => unknown) => fn(advSessionRowsMock));
});

describe('getLatestActiveAdvSessionByOwner', () => {
  it('maps the newest active row and binds the exact owner/workspace predicates', async () => {
    // boundedOrgTxn applies lock_timeout + statement_timeout before the read.
    advSessionRowsMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
      id: 28143,
      workspace_id: 'papercusp-workspace',
      plan_slug: 'retrieval-soft-budget-hard-deadline-2026-09-13',
      agent: 'codex',
      role: null,
      feature: null,
      mode: 'console',
      terminal_bin: null,
      pid: null,
      window_id: '0x01e70b14',
      omp_thread_id: null,
      label: null,
      cwd: '/repo',
      coord_owner_id: 'su-8ee55568',
      session_id: '01a09697-7bd2-78f1-9e1b-f8592b50a23c',
      started_at: '2026-09-12T23:18:15.000Z',
      ended_at: null,
      exit_code: null,
      ended_by: null,
      ended_signal: null,
      }]);

    const result = await getLatestActiveAdvSessionByOwner(' su-8ee55568 ');
    expect(result).toMatchObject({ id: 28143, coordOwnerId: 'su-8ee55568', windowId: '0x01e70b14' });
    const sql = ((advSessionRowsMock.mock.calls as unknown[][]).at(-1)?.[0] as readonly string[]).join(' ');
    expect(sql).toContain('coord_owner_id =');
    expect(sql).toContain('ended_at IS NULL');
    expect(sql).toContain('ORDER BY started_at DESC');
    expect(sql).toContain('LIMIT 1');
  });

  it('does not query for a blank owner id', async () => {
    await expect(getLatestActiveAdvSessionByOwner('   ')).resolves.toBeNull();
    expect(advSessionRowsMock).not.toHaveBeenCalled();
  });
});

describe('readAdvSessionLaunchRecordByOwner', () => {
  it('maps the newest owner-scoped launch record and keeps the query schema-safe', async () => {
    const launchSpec = { v: 1, workspaceId: 'ws-test', fleet: { slug: 'byoc' } };
    const launchArgv = ['psu', '--fleet=byoc'];
    // WI-6055: the first sql-tag call constructs the conditional workspace
    // fragment; only the outer call executes the SELECT and receives rows.
    advSessionRowsMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { workspace_id: 'ws-test', agent: 'codex', launch_spec: launchSpec, launch_argv: launchArgv },
      ]);

    await expect(readAdvSessionLaunchRecordByOwner('su-member', 'ws-test')).resolves.toEqual({
      workspaceId: 'ws-test',
      agent: 'codex',
      launchSpec,
      launchArgv,
    });
    const template = (advSessionRowsMock.mock.calls as unknown[][]).at(-1)?.[0];
    expect(Array.isArray(template)).toBe(true);
    expect((template as readonly string[]).join(' ')).toContain("to_jsonb(a)->'launch_spec'");
    expect((template as readonly string[]).join(' ')).toContain("to_jsonb(a)->'launch_argv'");
    expect((template as readonly string[]).join(' ')).toContain('agent');
  });
});

describe('listResumableSessions launch provenance', () => {
  it('returns the recorded psu argv needed for source-aware Codex resume inheritance', async () => {
    const launchArgv = [
      'psu',
      '--agent=codex',
      '--headless',
      '--model=gpt-5.6-terra:high',
      '--model-source=explicit',
    ];
    advSessionRowsMock.mockResolvedValueOnce([{ present: true }]).mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        id: 7,
        workspace_id: 'ws-test',
        plan_slug: null,
        agent: 'codex',
        role: null,
        feature: null,
        mode: 'console',
        terminal_bin: null,
        pid: null,
        window_id: null,
        omp_thread_id: null,
        label: null,
        cwd: '/repo',
        coord_owner_id: 'su-7',
        session_id: null,
        launch_argv: launchArgv,
        started_at: '2026-09-07T00:00:00.000Z',
        last_active_at: '2026-09-07T00:00:00.000Z',
        ended_at: null,
        exit_code: null,
        ended_by: null,
        ended_signal: null,
      },
    ]);

    const rows = await listResumableSessions(1);
    expect(rows[0]?.launchArgv).toEqual(launchArgv);
    const template = (advSessionRowsMock.mock.calls as unknown[][]).at(-1)?.[0];
    expect((template as readonly string[]).join(' ')).toContain('a.launch_argv');
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

describe('resume helper contract separation (psu-resume-claim-cutover D-001)', () => {
  it('retires the numeric helper while preserving the owner-keyed activity repair', () => {
    // The negative assertion is paired with a positive control deliberately: a moved,
    // renamed, or empty source file must not make selective retirement look green.
    expect(SOURCE).not.toMatch(/export async function reactivateAdvSession\s*\(/);
    expect(SOURCE).toMatch(/export async function reactivateAdvSessionByOwner\s*\(/);
  });
});

describe('stale adv-session terminal marker repair (EI-21365346411486602)', () => {
  it('treats either half of the terminal tuple as positive death evidence', () => {
    expect(hasAdvSessionTerminalEvidence({ endedAt: null, endedBy: 'reconciler' })).toBe(true);
    expect(hasAdvSessionTerminalEvidence({ endedAt: '2026-08-24T20:00:00Z', endedBy: null })).toBe(true);
    expect(hasAdvSessionTerminalEvidence({ endedAt: null, endedBy: null })).toBe(false);
  });

  it('fills only the missing terminal timestamp for the requested owner', async () => {
    advSessionRowsMock.mockResolvedValueOnce([{ id: 17840 }, { id: 17841 }]);

    await expect(repairStaleAdvSessionTerminalMarkers('su-stale')).resolves.toBe(2);

    const template = (advSessionRowsMock.mock.calls as unknown[][])[0]?.[0];
    const sql = (template as readonly string[]).join(' ');
    expect(sql).toContain('SET ended_at = now()');
    expect(sql).toContain('coord_owner_id');
    expect(sql).toContain('ended_at IS NULL');
    expect(sql).toContain('ended_by IS NOT NULL');
    expect(sql).toContain('RETURNING id');
  });

  it('is a no-op for a blank owner and does not touch the database', async () => {
    await expect(repairStaleAdvSessionTerminalMarkers('   ')).resolves.toBe(0);
    expect(advSessionRowsMock).not.toHaveBeenCalled();
  });

  it('reactivates either half of the terminal tuple only when no keyed resume owns the row', async () => {
    advSessionRowsMock.mockResolvedValueOnce([{ id: 17842 }]);

    await expect(reactivateAdvSessionByOwner('su-half-terminal')).resolves.toBe(true);

    const template = (advSessionRowsMock.mock.calls as unknown[][])[0]?.[0];
    const sql = (template as readonly string[]).join(' ');
    expect(sql).toContain('(ended_at IS NOT NULL OR ended_by IS NOT NULL)');
    expect(sql).toContain('ended_at = NULL');
    expect(sql).toContain('ended_by = NULL');
    expect(sql).toContain('ended_signal = NULL');
    expect(sql).toContain('AND resume_claim_key IS NULL');
    expect(sql).not.toContain('resume_claim_key = NULL');
    expect(sql).not.toContain('resume_claimed_at = NULL');
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
      contextSize: 'trimmed',
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

describe('Codex resume local-liveness evidence (EI-21584243912058462)', () => {
  it('accepts exactly the closed positive discriminant', () => {
    expect(isAdvSessionLocalLivenessEvidence({
      version: 1,
      kind: 'no-live-codex-writer',
    })).toBe(true);
    for (const value of [
      null,
      undefined,
      [],
      { version: 1, kind: 'no-live-codex-writer', extra: true },
      { version: '1', kind: 'no-live-codex-writer' },
      { version: 1, kind: 'free' },
    ]) {
      expect(isAdvSessionLocalLivenessEvidence(value)).toBe(false);
    }
  });

  it('uses the witness only inside the locked Codex recent-active transaction', async () => {
    const tx = vi.fn(async (strings: TemplateStringsArray, ..._values: unknown[]) => {
      const sql = strings.join(' ');
      if (sql.includes('SELECT agent, ended_at')) {
        return [{
          agent: 'codex',
          ended_at: null,
          ended_by: null,
          started_at: new Date(),
          resume_claim_key: null,
          resume_claimed_at: null,
        }];
      }
      if (sql.includes('UPDATE harness_shared.adv_sessions')) {
        return [{ lease_expires_at: new Date(Date.now() + 60_000).toISOString() }];
      }
      return [];
    });
    advSessionBeginMock.mockImplementation(async (fn) => fn(tx as typeof advSessionRowsMock));

    await expect(acquireAdvSessionResume(
      42,
      'resume-key',
      60,
      300,
      { version: 1, kind: 'no-live-codex-writer' },
    )).resolves.toMatchObject({ status: 'acquired', acquired: true });
    expect(tx.mock.calls.some(([strings]) => strings.join(' ').includes('FOR UPDATE'))).toBe(true);
    expect(tx.mock.calls.some(([strings]) => strings.join(' ').includes('UPDATE harness_shared.adv_sessions'))).toBe(true);
  });

  it('keeps a recent row live when the evidence is malformed or unknown', async () => {
    const tx = vi.fn(async (strings: TemplateStringsArray, ..._values: unknown[]) => {
      if (strings.join(' ').includes('SELECT agent, ended_at')) {
        return [{
          agent: 'codex',
          ended_at: null,
          ended_by: null,
          started_at: new Date(),
          resume_claim_key: null,
          resume_claimed_at: null,
        }];
      }
      throw new Error('unexpected write');
    });
    advSessionBeginMock.mockImplementation(async (fn) => fn(tx as typeof advSessionRowsMock));

    await expect(acquireAdvSessionResume(42, 'resume-key', 60, 300, {
      version: 1,
      kind: 'unknown',
    })).resolves.toEqual({ status: 'live', acquired: false });
  });
});

/**
 * WI-2141892 — the same reconciliation for CLAUDE, and the binding that keeps the
 * two oracles from being interchangeable.
 *
 * The bug: a claude session that exited without an end witness (ended_at,
 * exit_code and shutdown_accepted_at all NULL — window closed, host killed) left
 * a row that is non-terminal and recent, so this function refused `live` for the
 * whole 300s window with NO override. `PSU_FORCE_RESUME=1` gates only psu's local
 * double-host guard and never reaches here, so the owner's only routes were to
 * wait or to `--fork`, which mints a fresh identity and abandons the coord
 * ownerId every lock, await and presence row is keyed on.
 */
describe('Claude resume local-liveness evidence (WI-2141892)', () => {
  const recentActiveClaudeRow = () => ({
    agent: 'claude',
    ended_at: null,
    ended_by: null,
    started_at: new Date(), // inside the recent-active window
    resume_claim_key: null,
    resume_claimed_at: null,
  });

  const txFor = (row: Record<string, unknown>) =>
    vi.fn(async (strings: TemplateStringsArray, ..._values: unknown[]) => {
      const sql = strings.join(' ');
      if (sql.includes('SELECT agent, ended_at')) return [row];
      if (sql.includes('UPDATE harness_shared.adv_sessions')) {
        return [{ lease_expires_at: new Date(Date.now() + 60_000).toISOString() }];
      }
      return [];
    });

  it('accepts both closed discriminants and nothing else', () => {
    expect(isAdvSessionLocalLivenessEvidence({ version: 1, kind: 'no-live-claude-process' })).toBe(true);
    expect(isAdvSessionLocalLivenessEvidence({ version: 1, kind: 'no-live-codex-writer' })).toBe(true);
    for (const value of [
      { version: 1, kind: 'no-live-claude-process', extra: true },
      { version: 2, kind: 'no-live-claude-process' },
      { version: 1, kind: 'no-live-claude-writer' },
      { version: 1, kind: 'clean-scan' },
      { version: 1 },
    ]) {
      expect(isAdvSessionLocalLivenessEvidence(value)).toBe(false);
    }
  });

  it('binds each witness kind to the ONE backend whose oracle produced it', () => {
    expect(ADV_SESSION_LIVENESS_EVIDENCE_AGENT).toEqual({
      'no-live-codex-writer': 'codex',
      'no-live-claude-process': 'claude',
      'no-live-omp-process': 'omp',
    });
    // WI-2142101: omp joins on the same terms. claude and omp share one PROBE
    // (both resumes name the session in argv) but NOT one witness kind — a kind
    // names the oracle AND the row it may speak for, so sharing a mechanism must
    // not become sharing an identity.
    expect(isAdvSessionLocalLivenessEvidence({ version: 1, kind: 'no-live-omp-process' })).toBe(true);
    expect(advSessionLivenessEvidenceCoversAgent('omp', { version: 1, kind: 'no-live-omp-process' })).toBe(true);
    expect(advSessionLivenessEvidenceCoversAgent('claude', { version: 1, kind: 'no-live-omp-process' })).toBe(false);
    expect(advSessionLivenessEvidenceCoversAgent('omp', { version: 1, kind: 'no-live-claude-process' })).toBe(false);
    const claudeWitness = { version: 1, kind: 'no-live-claude-process' };
    const codexWitness = { version: 1, kind: 'no-live-codex-writer' };
    expect(advSessionLivenessEvidenceCoversAgent('claude', claudeWitness)).toBe(true);
    expect(advSessionLivenessEvidenceCoversAgent('codex', codexWitness)).toBe(true);
    // Cross-application is the unearned liveness claim: codex's flock says
    // nothing about a claude process, and a /proc scan says nothing about a
    // codex thread's writer.
    expect(advSessionLivenessEvidenceCoversAgent('codex', claudeWitness)).toBe(false);
    expect(advSessionLivenessEvidenceCoversAgent('claude', codexWitness)).toBe(false);
    expect(advSessionLivenessEvidenceCoversAgent('omp', claudeWitness)).toBe(false);
    expect(advSessionLivenessEvidenceCoversAgent(null, claudeWitness)).toBe(false);
    expect(advSessionLivenessEvidenceCoversAgent('claude', null)).toBe(false);
  });

  it('reconciles a recent-active CLAUDE row that the local probe found dead', async () => {
    const tx = txFor(recentActiveClaudeRow());
    advSessionBeginMock.mockImplementation(async (fn) => fn(tx as typeof advSessionRowsMock));

    await expect(acquireAdvSessionResume(22127, 'resume-key', 60, 300, {
      version: 1,
      kind: 'no-live-claude-process',
    })).resolves.toMatchObject({ status: 'acquired', acquired: true });
  });

  it('POSITIVE CONTROL — the same row without a witness still refuses live', async () => {
    // Without this the test above would pass for the wrong reason (e.g. if the
    // row were being read as stale rather than reconciled).
    const tx = txFor(recentActiveClaudeRow());
    advSessionBeginMock.mockImplementation(async (fn) => fn(tx as typeof advSessionRowsMock));

    await expect(acquireAdvSessionResume(22127, 'resume-key', 60, 300))
      .resolves.toEqual({ status: 'live', acquired: false });
  });

  it('refuses a CLAUDE row presented with a codex witness', async () => {
    const tx = vi.fn(async (strings: TemplateStringsArray, ..._values: unknown[]) => {
      if (strings.join(' ').includes('SELECT agent, ended_at')) return [recentActiveClaudeRow()];
      throw new Error('unexpected write');
    });
    advSessionBeginMock.mockImplementation(async (fn) => fn(tx as typeof advSessionRowsMock));

    await expect(acquireAdvSessionResume(22127, 'resume-key', 60, 300, {
      version: 1,
      kind: 'no-live-codex-writer',
    })).resolves.toEqual({ status: 'live', acquired: false });
  });

  it('refuses a CODEX row presented with a claude witness', async () => {
    const tx = vi.fn(async (strings: TemplateStringsArray, ..._values: unknown[]) => {
      if (strings.join(' ').includes('SELECT agent, ended_at')) {
        return [{ ...recentActiveClaudeRow(), agent: 'codex' }];
      }
      throw new Error('unexpected write');
    });
    advSessionBeginMock.mockImplementation(async (fn) => fn(tx as typeof advSessionRowsMock));

    await expect(acquireAdvSessionResume(22127, 'resume-key', 60, 300, {
      version: 1,
      kind: 'no-live-claude-process',
    })).resolves.toEqual({ status: 'live', acquired: false });
  });

  it('never lets a witness override a HELD reservation or a missing row', async () => {
    // The witness reconciles the recent-active liveness read only. It must not
    // touch the single-winner lease or invent a row.
    const held = vi.fn(async (strings: TemplateStringsArray, ..._values: unknown[]) => {
      if (strings.join(' ').includes('SELECT agent, ended_at')) {
        return [{
          ...recentActiveClaudeRow(),
          resume_claim_key: 'another-launchers-key',
          resume_claimed_at: new Date(),
        }];
      }
      throw new Error('unexpected write');
    });
    advSessionBeginMock.mockImplementation(async (fn) => fn(held as typeof advSessionRowsMock));
    await expect(acquireAdvSessionResume(22127, 'my-key', 60, 300, {
      version: 1,
      kind: 'no-live-claude-process',
    })).resolves.toMatchObject({ status: 'reserved', acquired: false });

    const missing = vi.fn(async () => []);
    advSessionBeginMock.mockImplementation(async (fn) => fn(missing as typeof advSessionRowsMock));
    await expect(acquireAdvSessionResume(22127, 'my-key', 60, 300, {
      version: 1,
      kind: 'no-live-claude-process',
    })).resolves.toEqual({ status: 'missing', acquired: false });
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
 * WI-37743/P-002 — `adoptStartingTerminalLaunch` COMPLETES a launcher's own
 * starting row instead of inserting a duplicate beside it. Its entire safety
 * rests on the identity + lifecycle predicates in one WHERE clause, so they are
 * guarded here.
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

  it('allows only a terminal precursor or an already-claimed workbench precursor', () => {
    expect(adopt).toContain('display = ${DISPLAY_TERMINAL_LAUNCH}');
    expect(adopt).toContain("display = 'workbench' AND launched_at IS NOT NULL");
  });

  it('never adopts an unclaimed workbench row', () => {
    // launched_at is the server-side claim PUI wins BEFORE opening the pane.
    // Omitting this guard would let copied argv route around the single launcher.
    expect(adopt).not.toMatch(/OR\s+display = 'workbench'\s*[)\n]/);
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
