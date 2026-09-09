/**
 * Tests for per-fire substitution telemetry
 * (plan `bash-substitution-reachable-ceiling-2026-08-01`, P-003).
 *
 * Two properties carry the weight here, and both are the kind that fail
 * SILENTLY — producing a plausible number rather than an error:
 *
 *  1. The gate's own tool must never count as compliance. `locks:check_command`
 *     is what the hook calls to GET the advisory, so it is very often the firing
 *     session's next invocation. Counting it would measure the hook calling
 *     itself, on exactly the commands the rules target.
 *  2. "no follow-up call" must never be recorded as `complied = false`. A dead
 *     session is not a defiant agent, and conflating them biases every
 *     compliance rate in the direction that flatters intervention.
 *
 * The whole point of P-003 is to make this plan's iterations measurable, so a
 * quietly wrong measurement is worse here than none — the same failure D-048
 * documented one layer down, where a lossy corpus transform manufactured
 * favourable evidence.
 */

import { describe, expect, it } from 'vitest';
import {
  COMPLIANCE_ABANDON_MS,
  COMPLIANCE_SETTLE_MS,
  GATE_TOOL_NAME,
  HOOK_CALL_ORIGIN,
  recordSubstitutionFires,
  resolveFireCompliance,
} from './fires';
import type { SubstitutionMatch } from './match';

interface FakeCall {
  text: string;
  values: unknown[];
}

/** A tagged-template stand-in for the postgres client, dispatching on query text. */
function fakeSql(handler: (text: string, values: unknown[]) => unknown[]) {
  const calls: FakeCall[] = [];
  const fn = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join(' ? ').replace(/\s+/g, ' ').trim();
    calls.push({ text, values });
    return Promise.resolve(handler(text, values));
  };
  return Object.assign(fn, { calls });
}

const match = (over: Partial<SubstitutionMatch> = {}): SubstitutionMatch => ({
  intentLabel: 'file-range-read',
  toolName: 'capability:read',
  tier: 'advise',
  advisoryText: 'use capability:read',
  atom: "sed -n '1,40p' a.ts",
  ...over,
});

describe('recordSubstitutionFires', () => {
  it('writes one fire and bumps the row counters per match', async () => {
    const sql = fakeSql((text) => (text.startsWith('INSERT') ? [{ row_id: '7' }] : []));
    const written = await recordSubstitutionFires({
      workspaceId: 'ws',
      ownerId: 'su-abc',
      matches: [match(), match({ intentLabel: 'service-logs', toolName: 'logs:read' })],
      client: sql as never,
    });

    expect(written).toBe(2);
    const updates = sql.calls.filter((c) => c.text.startsWith('UPDATE'));
    expect(updates).toHaveLength(2);
    expect(updates[0].text).toContain('match_count = match_count + 1');
    expect(updates[0].text).toContain('last_fired_at = now()');
  });

  it('records the tier AS OF THE FIRE, which is what makes a promotion measurable', () => {
    // Reading the tier at analysis time instead would attribute every historical
    // fire to whatever tier the row ended up at — and make every promotion look
    // effective by construction.
    const sql = fakeSql((text) => (text.startsWith('INSERT') ? [{ row_id: '1' }] : []));
    return recordSubstitutionFires({
      workspaceId: 'ws',
      ownerId: 'su-abc',
      matches: [match({ tier: 'observe' })],
      client: sql as never,
    }).then(() => {
      expect(sql.calls[0].values).toContain('observe');
    });
  });

  it('writes nothing when the registry row has since been deleted', async () => {
    const sql = fakeSql(() => []); // INSERT ... SELECT matched no row
    const written = await recordSubstitutionFires({
      workspaceId: 'ws',
      ownerId: 'su-abc',
      matches: [match()],
      client: sql as never,
    });
    expect(written).toBe(0);
    expect(sql.calls.filter((c) => c.text.startsWith('UPDATE'))).toHaveLength(0);
  });

  it('swallows a database failure rather than breaking the gate', async () => {
    // The caller is a PreToolUse hook on every shell command from every agent.
    // Telemetry that can wedge a command is worse than no telemetry.
    const exploding = (() => {
      throw new Error('connection refused');
    }) as never;
    await expect(
      recordSubstitutionFires({
        workspaceId: 'ws',
        ownerId: 'su-abc',
        matches: [match()],
        client: exploding,
      }),
    ).resolves.toBe(0);
  });

  it('does nothing at all when nothing matched', async () => {
    const sql = fakeSql(() => []);
    expect(
      await recordSubstitutionFires({
        workspaceId: 'ws',
        ownerId: 'su-abc',
        matches: [],
        client: sql as never,
      }),
    ).toBe(0);
    expect(sql.calls).toHaveLength(0);
  });
});

describe('resolveFireCompliance', () => {
  const NOW = new Date('2026-08-02T12:00:00Z');
  const settled = new Date(NOW.getTime() - COMPLIANCE_SETTLE_MS - 1000);
  const abandoned = new Date(NOW.getTime() - COMPLIANCE_ABANDON_MS - 1000);

  /** A resolver harness: canned pending fires + a canned "next call". */
  function harness(pending: unknown[], next: Array<{ tool_name: string }>) {
    return fakeSql((text) => {
      if (text.includes('FROM harness_shared.bash_tool_substitution_fires')) return pending;
      if (text.includes('FROM harness_shared.tool_invocations')) return next;
      return [];
    });
  }

  it('records compliance when the next call used the named tool', async () => {
    const sql = harness(
      [{ id: '1', session_id: 'su-a', tool_name: 'capability:read', fired_at: settled }],
      [{ tool_name: 'capability:read' }],
    );
    const out = await resolveFireCompliance({ workspaceId: 'ws', client: sql as never, now: NOW });

    expect(out).toEqual({ examined: 1, measured: 1, noFollowUp: 0 });
    const update = sql.calls.find((c) => c.text.startsWith('UPDATE'))!;
    expect(update.values).toContain(true);
  });

  it('records non-compliance when the next call used something else', async () => {
    const sql = harness(
      [{ id: '1', session_id: 'su-a', tool_name: 'capability:read', fired_at: settled }],
      [{ tool_name: 'capability:bash' }],
    );
    const out = await resolveFireCompliance({ workspaceId: 'ws', client: sql as never, now: NOW });

    expect(out.measured).toBe(1);
    expect(sql.calls.find((c) => c.text.startsWith('UPDATE'))!.values).toContain(false);
  });

  it('EXCLUDES the gate\'s own tool from "the next call"', async () => {
    // The hook calls locks:check_command to obtain the advisory, so it is very
    // often the chronologically next invocation. If this exclusion is ever
    // dropped, compliance measures the gate calling itself — and does so on
    // precisely the commands the rules target, which is the worst possible
    // correlation for a metric to have.
    const sql = harness(
      [{ id: '1', session_id: 'su-a', tool_name: 'capability:read', fired_at: settled }],
      [{ tool_name: 'capability:read' }],
    );
    await resolveFireCompliance({ workspaceId: 'ws', client: sql as never, now: NOW });

    const lookup = sql.calls.find((c) => c.text.includes('FROM harness_shared.tool_invocations'))!;
    expect(lookup.text).toContain('tool_name <>');
    expect(lookup.values).toContain(GATE_TOOL_NAME);
  });

  it('EXCLUDES every hook-emitted invocation, not only the gate tool', async () => {
    // Naming one hook tool could never have been enough. Filter on the DECLARED
    // `call_origin` column rather than a list of tool names: the list is a second
    // copy of what the emitting hook already declares, and it rotted exactly that
    // way — written when locks:check_command was the only hook tool, never updated
    // as activity:report and coord:glance joined it.
    const sql = harness(
      [{ id: '1', session_id: 'su-a', tool_name: 'capability:read', fired_at: settled }],
      [{ tool_name: 'capability:read' }],
    );
    await resolveFireCompliance({ workspaceId: 'ws', client: sql as never, now: NOW });

    const lookup = sql.calls.find((c) => c.text.includes('FROM harness_shared.tool_invocations'))!;
    expect(lookup.text).toContain('call_origin IS DISTINCT FROM');
    expect(lookup.values).toContain(HOOK_CALL_ORIGIN);
    // The specific exclusion still stands alongside the general one.
    expect(lookup.values).toContain(GATE_TOOL_NAME);
  });

  it('does not let a hook-emitted row stand in for the agent\'s next call', async () => {
    // The regression this pins, and the reason compliance read 5/71,086 (0.007%)
    // before the predicate existed: the advisory fires at PreToolUse of a shell
    // command, the command runs, and the PostToolUse activity-report hook calls
    // `activity:report`. That row sits between the fire and the agent's next move
    // BY CONSTRUCTION, so a resolver taking the literal next invocation compares
    // against the hook and records non-compliance for an agent that DID comply.
    const invocations = [
      { tool_name: 'activity:report', call_origin: 'hook' },
      { tool_name: 'capability:read', call_origin: 'agent' },
    ];
    const sql = fakeSql((text) => {
      if (text.includes('FROM harness_shared.bash_tool_substitution_fires')) {
        return [{ id: '1', session_id: 'su-a', tool_name: 'capability:read', fired_at: settled }];
      }
      if (text.includes('FROM harness_shared.tool_invocations')) {
        // Stand in for the predicate the query actually declares, so removing it
        // from fires.ts fails this test rather than silently passing it.
        const rows = text.includes('call_origin IS DISTINCT FROM')
          ? invocations.filter((r) => r.call_origin !== 'hook')
          : invocations;
        return rows.slice(0, 1);
      }
      return [];
    });

    const out = await resolveFireCompliance({ workspaceId: 'ws', client: sql as never, now: NOW });

    expect(out.measured).toBe(1);
    expect(sql.calls.find((c) => c.text.startsWith('UPDATE'))!.values).toContain(true);
  });

  it('keeps an unclassified row eligible as the next call', async () => {
    // `IS DISTINCT FROM 'hook'` rather than `= 'agent'`: only 'hook' is declared
    // by its emitter, so a NULL/'unknown' origin must stay eligible. Skipping it
    // would advance past a real agent action and bias compliance UPWARD — the
    // direction that flatters the intervention.
    const invocations = [
      { tool_name: 'capability:bash', call_origin: null },
      { tool_name: 'capability:read', call_origin: 'agent' },
    ];
    const sql = fakeSql((text) => {
      if (text.includes('FROM harness_shared.bash_tool_substitution_fires')) {
        return [{ id: '1', session_id: 'su-a', tool_name: 'capability:read', fired_at: settled }];
      }
      if (text.includes('FROM harness_shared.tool_invocations')) {
        const rows = invocations.filter((r) => r.call_origin !== 'hook');
        return rows.slice(0, 1);
      }
      return [];
    });

    const out = await resolveFireCompliance({ workspaceId: 'ws', client: sql as never, now: NOW });

    // The unclassified bash call is the honest next call, and it is not the named
    // tool — so this is a real `false`, not a skipped row.
    expect(out.measured).toBe(1);
    expect(sql.calls.find((c) => c.text.startsWith('UPDATE'))!.values).toContain(false);
  });

  it('leaves a settled-but-recent fire alone when no next call exists yet', async () => {
    const sql = harness(
      [{ id: '1', session_id: 'su-a', tool_name: 'capability:read', fired_at: settled }],
      [],
    );
    const out = await resolveFireCompliance({ workspaceId: 'ws', client: sql as never, now: NOW });

    expect(out).toEqual({ examined: 1, measured: 0, noFollowUp: 0 });
    expect(sql.calls.filter((c) => c.text.startsWith('UPDATE'))).toHaveLength(0);
  });

  it('closes an abandoned fire with complied left NULL, never false', async () => {
    // The three-state distinction this whole design turns on: unresolved /
    // resolved-with-no-evidence / measured. Writing `false` here would report a
    // session that simply ended as an agent that ignored the advisory.
    const sql = harness(
      [{ id: '1', session_id: 'su-a', tool_name: 'capability:read', fired_at: abandoned }],
      [],
    );
    const out = await resolveFireCompliance({ workspaceId: 'ws', client: sql as never, now: NOW });

    expect(out).toEqual({ examined: 1, measured: 0, noFollowUp: 1 });
    const update = sql.calls.find((c) => c.text.startsWith('UPDATE'))!;
    expect(update.text).toContain('resolved_at = now()');
    expect(update.text).not.toContain('complied =');
    expect(update.values).not.toContain(false);
  });

  it('closes an abandoned fire when pooled Postgres returns fired_at as a string', async () => {
    // The production org pool uses prepare:false, so timestamptz values arrive
    // in PostgreSQL wire format instead of as Date objects. A direct string <
    // Date comparison coerces the string to NaN and silently skips abandonment.
    const sql = harness(
      [
        {
          id: '1',
          session_id: 'su-a',
          tool_name: 'capability:read',
          fired_at: '2026-08-02 10:59:59.000000+00',
        },
      ],
      [],
    );
    const out = await resolveFireCompliance({ workspaceId: 'ws', client: sql as never, now: NOW });

    expect(out).toEqual({ examined: 1, measured: 0, noFollowUp: 1 });
    expect(sql.calls.find((c) => c.text.startsWith('UPDATE'))?.text).toContain(
      'resolved_at = now()',
    );
  });

  it('closes a fire with no session id instead of re-scanning it forever', async () => {
    const sql = harness(
      [{ id: '1', session_id: null, tool_name: 'capability:read', fired_at: abandoned }],
      [],
    );
    const out = await resolveFireCompliance({ workspaceId: 'ws', client: sql as never, now: NOW });

    expect(out.noFollowUp).toBe(1);
    // No point asking tool_invocations who "they" were.
    expect(sql.calls.some((c) => c.text.includes('FROM harness_shared.tool_invocations'))).toBe(
      false,
    );
  });

  it('only considers fires that have settled', async () => {
    const sql = harness([], []);
    await resolveFireCompliance({ workspaceId: 'ws', client: sql as never, now: NOW });
    const select = sql.calls[0];
    expect(select.text).toContain('resolved_at IS NULL');
    // The settle cutoff, not `now` — resolving at t+0 would race the answer into
    // existence, since "what did they do next" has not happened yet.
    const cutoff = select.values.find((v): v is Date => v instanceof Date)!;
    expect(NOW.getTime() - cutoff.getTime()).toBe(COMPLIANCE_SETTLE_MS);
  });
  it('is a quiet no-op when the telemetry schema has not been migrated yet', async () => {
    // Migration 720 needs ACCESS EXCLUSIVE on a table every operator reads on a
    // 30s cycle, so it lands in a restart window and the code ships first. A
    // warning per routines tick during that gap would train the reader to ignore
    // the channel the real failures arrive on.
    const missing = Object.assign(new Error('relation does not exist'), { code: '42P01' });
    const sql = (() => {
      throw missing;
    }) as never;
    await expect(
      resolveFireCompliance({ workspaceId: 'ws', client: sql, now: NOW }),
    ).resolves.toEqual({ examined: 0, measured: 0, noFollowUp: 0 });
  });

  it('still propagates a genuine database error rather than reporting zero work', async () => {
    // The dual of the test above: swallowing everything would hide a broken
    // resolver behind the same silence as a pending migration.
    const boom = (() => {
      throw Object.assign(new Error('connection reset'), { code: '08006' });
    }) as never;
    await expect(
      resolveFireCompliance({ workspaceId: 'ws', client: boom, now: NOW }),
    ).rejects.toThrow(/connection reset/);
  });
});
