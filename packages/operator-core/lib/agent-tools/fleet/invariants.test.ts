/**
 * Leader-registered custom fleet invariants (P-014, migration 713).
 *
 * These cover the PURE half — placeholder substitution, the roll-up, the
 * brief-facing alert, and the isolation property of the evaluator (which takes
 * an injected runner, so it is testable without a database).
 *
 * The property most worth pinning is the one the feature exists to provide:
 * an invariant that FAILED TO RUN must not read as a passing invariant. That is
 * the same false-clean shape the guards in WI-6730 had, one level up — a check
 * nobody can see is broken is worse than no check, because it actively
 * suppresses the question.
 */
import { describe, expect, it } from 'vitest';
import {
  computeCustomInvariantAlert,
  evaluateFleetInvariants,
  readFleetInvariantEvaluations,
  registerFleetInvariant,
  substituteInvariantPlaceholders,
  summarizeInvariantEvaluations,
  type FleetInvariant,
  type InvariantEvaluation,
} from './invariants';

function inv(over: Partial<FleetInvariant> = {}): FleetInvariant {
  return {
    id: 'id-1',
    workspaceId: 'ws',
    harnessSlug: 'papercusp',
    fleetSlug: 'push-not-poll',
    name: 'parked-on-own-item',
    description: null,
    querySql: 'SELECT 1',
    severity: 'warn',
    active: true,
    createdBy: null,
    ...over,
  };
}

function evaluation(over: Partial<InvariantEvaluation> = {}): InvariantEvaluation {
  return { name: 'n', severity: 'warn', status: 'satisfied', elapsedMs: 1, ...over };
}

describe('substituteInvariantPlaceholders', () => {
  it('substitutes {{fleet}} and {{workspace}} as quoted literals', () => {
    const out = substituteInvariantPlaceholders(
      'SELECT 1 WHERE fleet = {{fleet}} AND ws = {{workspace}}',
      { fleet: 'push-not-poll', workspace: 'papercusp-workspace' },
    );
    expect(out).toBe(
      "SELECT 1 WHERE fleet = 'push-not-poll' AND ws = 'papercusp-workspace'",
    );
  });

  it('tolerates internal whitespace and repeats every occurrence', () => {
    const out = substituteInvariantPlaceholders('{{ fleet }} {{fleet}}', {
      fleet: 'f',
      workspace: 'w',
    });
    expect(out).toBe("'f' 'f'");
  });

  it("escapes a single quote by doubling it, PG's own escape", () => {
    // Non-negotiable: this value is interpolated into SQL text, so a quote that
    // survived unescaped would terminate the literal early.
    const out = substituteInvariantPlaceholders('x = {{fleet}}', {
      fleet: "o'brien",
      workspace: 'w',
    });
    expect(out).toBe("x = 'o''brien'");
  });

  it('leaves SQL without placeholders byte-identical', () => {
    const sql = 'SELECT a FROM t WHERE b = 1';
    expect(substituteInvariantPlaceholders(sql, { fleet: 'f', workspace: 'w' })).toBe(sql);
  });
});

describe('summarizeInvariantEvaluations', () => {
  it('counts violated, critical-violated and errored separately', () => {
    const got = summarizeInvariantEvaluations([
      evaluation({ status: 'satisfied' }),
      evaluation({ status: 'violated', severity: 'warn' }),
      evaluation({ status: 'violated', severity: 'critical' }),
      evaluation({ status: 'error' }),
    ]);
    expect(got).toEqual({ evaluated: 4, violated: 2, criticalViolated: 1, errored: 1 });
  });

  it('does not count an ERRORED critical as a violation', () => {
    // It did not run, so it found nothing — claiming a violation would be as
    // wrong as claiming a pass. It is counted only as errored.
    const got = summarizeInvariantEvaluations([
      evaluation({ status: 'error', severity: 'critical' }),
    ]);
    expect(got).toEqual({ evaluated: 1, violated: 0, criticalViolated: 0, errored: 1 });
  });
});

describe('computeCustomInvariantAlert', () => {
  it('is silent when every invariant is satisfied', () => {
    expect(computeCustomInvariantAlert([evaluation(), evaluation()])).toBeUndefined();
  });

  it('is silent when there are no invariants at all', () => {
    // A fleet that registered none must not acquire a permanent empty alert.
    expect(computeCustomInvariantAlert([])).toBeUndefined();
  });

  it('names each violated invariant and its violation count', () => {
    const alert = computeCustomInvariantAlert([
      evaluation({ name: 'parked-on-own-item', status: 'violated', violationCount: 3 }),
    ]);
    expect(alert?.reason).toContain('parked-on-own-item(3)');
    expect(alert?.reason).toContain('1 custom invariant(s) VIOLATED');
  });

  it('marks a truncated violation count with + so a cap does not read as the true total', () => {
    const alert = computeCustomInvariantAlert([
      evaluation({ name: 'x', status: 'violated', violationCount: 20, truncated: true }),
    ]);
    expect(alert?.reason).toContain('x(20+)');
  });

  it('calls out how many violations were critical', () => {
    const alert = computeCustomInvariantAlert([
      evaluation({ name: 'a', status: 'violated', violationCount: 1, severity: 'critical' }),
      evaluation({ name: 'b', status: 'violated', violationCount: 1, severity: 'warn' }),
    ]);
    expect(alert?.reason).toContain('1 of them critical');
  });

  it('FIRES on an errored invariant even when nothing is violated', () => {
    // The property this feature lives or dies on. A check that cannot run is
    // not a passing check; staying silent here would recreate the false-clean
    // failure the invariants exist to surface.
    const alert = computeCustomInvariantAlert([
      evaluation({ name: 'broken-check', status: 'error', error: 'syntax error' }),
    ]);
    expect(alert).toBeDefined();
    expect(alert?.reason).toContain('broken-check');
    expect(alert?.reason).toContain('FAILED TO RUN');
    expect(alert?.reason).toContain('not a');
  });
});

describe('evaluateFleetInvariants', () => {
  it('reports zero rows as satisfied and rows as violated, carrying the rows as evidence', async () => {
    const out = await evaluateFleetInvariants(
      {
        invariants: [
          inv({ name: 'empty', querySql: 'SELECT empty' }),
          inv({ name: 'hits', id: 'id-2', querySql: 'SELECT hits' }),
        ],
        workspaceId: 'ws',
        fleetSlug: 'f',
      },
      {
        runQuery: (async (sqlText: string) =>
          sqlText.includes('hits')
            ? { rows: [{ a: 1 }, { a: 2 }], truncated: false }
            : { rows: [], truncated: false }) as never,
      },
    );
    // Distinguish by name; the runner keys off each invariant's own SQL text.
    const empty = out.find((o) => o.name === 'empty');
    const hits = out.find((o) => o.name === 'hits');
    expect(empty?.status).toBe('satisfied');
    expect(empty?.rows).toBeUndefined();
    expect(hits?.status).toBe('violated');
    expect(hits?.violationCount).toBe(2);
    expect(hits?.rows).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('ISOLATES a throwing invariant — it errors alone and its siblings still evaluate', async () => {
    // The brief is read on a monitor tick; one bad registry entry must never
    // cost the leader the rest of the fleet's signal.
    const out = await evaluateFleetInvariants(
      {
        invariants: [
          inv({ name: 'bad', querySql: 'SELECT boom' }),
          inv({ name: 'good', querySql: 'SELECT ok', id: 'id-2' }),
        ],
        workspaceId: 'ws',
        fleetSlug: 'f',
      },
      {
        runQuery: (async (sqlText: string) => {
          if (sqlText.includes('boom')) throw new Error('syntax error at or near "boom"');
          return { rows: [], truncated: false };
        }) as never,
      },
    );
    expect(out).toHaveLength(2);
    const bad = out.find((o) => o.name === 'bad');
    const good = out.find((o) => o.name === 'good');
    expect(bad?.status).toBe('error');
    expect(bad?.error).toContain('boom');
    expect(good?.status).toBe('satisfied');
  });

  it('substitutes placeholders before running, so a copied invariant checks THIS fleet', async () => {
    let seen = '';
    await evaluateFleetInvariants(
      {
        invariants: [inv({ querySql: 'SELECT 1 WHERE f = {{fleet}}' })],
        workspaceId: 'ws',
        fleetSlug: 'the-actual-fleet',
      },
      {
        runQuery: (async (sqlText: string) => {
          seen = sqlText;
          return { rows: [], truncated: false };
        }) as never,
      },
    );
    expect(seen).toBe("SELECT 1 WHERE f = 'the-actual-fleet'");
  });

  it('propagates the truncated flag so a capped result is not read as the whole story', async () => {
    const out = await evaluateFleetInvariants(
      { invariants: [inv()], workspaceId: 'ws', fleetSlug: 'f' },
      {
        runQuery: (async () => ({ rows: [{ a: 1 }], truncated: true })) as never,
      },
    );
    expect(out[0]?.truncated).toBe(true);
  });

  it('returns an empty array for an empty registry rather than fabricating an entry', async () => {
    const out = await evaluateFleetInvariants(
      { invariants: [], workspaceId: 'ws', fleetSlug: 'f' },
      { runQuery: (async () => ({ rows: [], truncated: false })) as never },
    );
    expect(out).toEqual([]);
  });
});

describe('readFleetInvariantEvaluations', () => {
  it('uses undefined only for a successful read with no active invariants', async () => {
    const out = await readFleetInvariantEvaluations(
      { workspaceId: 'ws', fleetSlug: 'f' },
      { list: async () => [] },
    );
    expect(out).toBeUndefined();
  });

  it('turns a registry-read failure into a visible critical error evaluation', async () => {
    const out = await readFleetInvariantEvaluations(
      { workspaceId: 'ws', fleetSlug: 'f' },
      {
        list: async () => {
          throw new Error('registry unavailable');
        },
      },
    );
    expect(out).toEqual([
      expect.objectContaining({
        name: 'fleet-invariant-registry',
        severity: 'critical',
        status: 'error',
        error: expect.stringContaining('registry unavailable'),
      }),
    ]);
    expect(computeCustomInvariantAlert(out ?? [])?.reason).toContain('FAILED TO RUN');
  });

  it('turns an unexpected evaluator failure into the same visible error channel', async () => {
    const out = await readFleetInvariantEvaluations(
      { workspaceId: 'ws', fleetSlug: 'f' },
      {
        list: async () => [inv()],
        evaluate: async () => {
          throw new Error('evaluation orchestration failed');
        },
      },
    );
    expect(out?.[0]).toMatchObject({
      name: 'fleet-invariant-registry',
      severity: 'critical',
      status: 'error',
    });
    expect(out?.[0]?.error).toContain('evaluation orchestration failed');
  });
});

/**
 * EI-20025951137999772 — registration must PROVE the check, not just store it.
 *
 * The gap these pin: `registerFleetInvariant` used to assert only that the SQL
 * was a single read STATEMENT, which is a claim about shape. Two failures got
 * through it. A statement that cannot EXECUTE registered clean and then errored
 * on every future brief. Worse, a statement that executes but can never MATCH
 * registered clean and reported "satisfied" forever — because this registry's
 * contract is rows == violated, so zero rows is the SAFE reading, and a dead
 * guard is therefore indistinguishable from a healthy fleet.
 *
 * The falsifier is the adversarial fixture: a deliberately-wrong input that
 * MUST return rows. These tests are also that fixture applied to the guard
 * itself — each asserts the new refusal actually fires, so the guard is not
 * merely registered here but shown to transition.
 */
describe('registerFleetInvariant proves the check can run and fire', () => {
  /** A sql tag that answers list-reads with [] and INSERT with one row. */
  function fakeSql() {
    const calls: string[] = [];
    const tag = ((strings: TemplateStringsArray | string, ...vals: unknown[]) => {
      const text = Array.isArray(strings) ? (strings as readonly string[]).join('?') : String(strings);
      if (text.trim() !== '') calls.push(text);
      void vals;
      return Promise.resolve(/INSERT INTO/i.test(text) ? [{ id: 'new-id' }] : []);
    }) as unknown as Parameters<typeof registerFleetInvariant>[1];
    return { tag, calls };
  }

  /** A sql tag that FAILS the test if the registration ever reaches the database. */
  function forbiddenSql() {
    return ((..._a: unknown[]) => {
      throw new Error('registration reached the database despite failing its proof');
    }) as unknown as Parameters<typeof registerFleetInvariant>[1];
  }

  const base = {
    workspaceId: 'papercusp-workspace',
    fleetSlug: 'push-not-poll',
    name: 'spec-drift',
    querySql: 'SELECT 1 FROM harness_shared.cup_claim_specs WHERE revision <> 7',
  };

  it('refuses a single-read statement that does not actually RUN, before touching the db', async () => {
    const result = await registerFleetInvariant(base, forbiddenSql(), {
      runQuery: async () => {
        throw new Error('column "revsion" does not exist');
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal');
    expect(result.error).toContain('did not RUN');
    expect(result.error).toContain('column "revsion" does not exist');
  });

  it('refuses when the falsifier returns ZERO rows — the dead-guard case', async () => {
    const result = await registerFleetInvariant(
      { ...base, falsifierSql: 'SELECT 1 FROM harness_shared.cup_claim_specs WHERE revision <> -1' },
      forbiddenSql(),
      // Invariant runs clean (0 rows == satisfied); the falsifier ALSO returns
      // nothing, which is the tell that the instrument cannot fire at all.
      { runQuery: async () => ({ rows: [], truncated: false }) as never },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal');
    expect(result.error).toContain('ZERO rows');
    expect(result.error).toContain('not proven able to fire');
  });

  it('registers when the falsifier DOES fire, and reports how many rows proved it', async () => {
    const { tag, calls } = fakeSql();
    let call = 0;
    const result = await registerFleetInvariant(
      { ...base, falsifierSql: 'SELECT 1 FROM harness_shared.cup_claim_specs WHERE revision <> -1' },
      tag,
      {
        // 1st = the invariant (satisfied), 2nd = the falsifier (fires).
        runQuery: async () =>
          (++call === 1 ? { rows: [], truncated: false } : { rows: [{ n: 1 }, { n: 2 }], truncated: false }) as never,
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.falsifierRows).toBe(2);
    expect(calls.some((c) => /INSERT INTO/i.test(c))).toBe(true);
  });

  it('still registers without a falsifier, but reports no fire-proof', async () => {
    const { tag } = fakeSql();
    const result = await registerFleetInvariant(base, tag, {
      runQuery: async () => ({ rows: [], truncated: false }) as never,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.falsifierRows).toBeUndefined();
  });
});
