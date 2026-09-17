import { describe, expect, it } from 'vitest';
import {
  PROJECT_HISTORY_EVENTS_BACKING_TABLES,
  PROJECT_HISTORY_EVENTS_QUERY_NAME,
  buildEventId,
  projectHistoryEventsArgsSchema,
  readProjectHistoryEvents,
  type ProjectHistoryEventsArgs,
} from './project-history-events';
import { isRegisteredV2 } from './index';
import { TABLE_TO_QUERY_NAMES } from './table-to-query-names';

/**
 * A postgres.js-shaped tag stub. Every call returns a thenable, so embedded
 * FRAGMENT calls (sql`TRUE`) are harmless values, and the OUTERMOST call — the
 * one actually awaited, and therefore the last one evaluated — resolves to the
 * canned rows. `calls` keeps the raw template pieces so a test can assert on
 * the generated SQL text itself.
 */
function makeSqlStub(rows: unknown[]) {
  const calls: { sql: string; values: unknown[] }[] = [];
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ sql: strings.join('?'), values });
    return Promise.resolve(rows);
  };
  return { sql: tag as never, calls };
}

/** The SQL of the outermost (awaited) call — the real query. */
function mainSql(calls: { sql: string }[]): string {
  return calls[calls.length - 1]?.sql ?? '';
}

/**
 * Every call's SQL joined. A postgres.js FRAGMENT (sql`...`) is embedded in the
 * outer template as a VALUE, not as text, so a conditional predicate built as a
 * fragment never appears in `mainSql` — assert those here instead.
 */
function allSql(calls: { sql: string }[]): string {
  return calls.map((c) => c.sql).join('\n');
}

const baseArgs: ProjectHistoryEventsArgs = {
  harnessSlug: 'papercusp',
  limit: 50,
};

describe('projectHistoryEvents — row mapping (the P-010/P-011 consumer contract)', () => {
  it('maps a DB row to the consumer contract and coerces bigint-as-string to a number', async () => {
    // postgres.js returns bigint columns as STRINGS. If that reaches the client
    // untouched, `tsMs` sorts lexicographically and the timeline silently
    // interleaves — which is why the coercion is asserted rather than assumed.
    const { sql } = makeSqlStub([
      {
        kind: 'work-item.completed',
        ts_ms: '1789600000000',
        actor: 'su-9b321e53',
        subject_kind: 'work-item',
        subject_id: 'WI-10001643',
        title: 'Live history-events resolver',
        status: 'done',
        plan_slug: 'project-history-tab-desktop-and-portal-2026-09-16',
        harness_slug: 'papercusp',
      },
    ]);

    const [row] = await readProjectHistoryEvents(sql, baseArgs);

    expect(row).toEqual({
      eventId: 'work-item.completed:WI-10001643:1789600000000',
      kind: 'work-item.completed',
      tsMs: 1789600000000,
      actor: 'su-9b321e53',
      subjectKind: 'work-item',
      subjectId: 'WI-10001643',
      title: 'Live history-events resolver',
      status: 'done',
      planSlug: 'project-history-tab-desktop-and-portal-2026-09-16',
      harnessSlug: 'papercusp',
    });
    expect(typeof row!.tsMs).toBe('number');
  });

  it('falls back to the subject id for a title and keeps absent fields null, not empty string', async () => {
    const { sql } = makeSqlStub([
      {
        kind: 'plan-item.status',
        ts_ms: 1789600000001,
        actor: null,
        subject_kind: 'plan-item',
        subject_id: 'some-plan#P-004',
        title: null,
        status: 'dropped',
        plan_slug: 'some-plan',
        harness_slug: 'papercusp',
      },
    ]);

    const [row] = await readProjectHistoryEvents(sql, baseArgs);

    expect(row!.title).toBe('some-plan#P-004');
    expect(row!.actor).toBeNull();
  });

  it('builds an eventId that is stable and unique per (kind, subject, ms)', () => {
    expect(buildEventId('work-item.created', 'WI-1', 5)).toBe('work-item.created:WI-1:5');
    // Two events on the SAME subject in the SAME millisecond must still differ,
    // or the tuple cursor collapses them and a page boundary drops one.
    expect(buildEventId('work-item.created', 'WI-1', 5)).not.toBe(
      buildEventId('work-item.claimed', 'WI-1', 5),
    );
  });
});

describe('projectHistoryEvents — generated SQL', () => {
  it('normalises every timestamptz source to epoch milliseconds', async () => {
    // The backing columns are deliberately mixed: created_ts/closed_ts and the
    // plan-part columns are bigint ms, while first_claimed_at/state_changed_at/
    // last_progress_at/plan_items.updated_at are timestamptz. A missed
    // conversion does not error — it sorts 1970 against today — so each
    // timestamptz source is asserted to go through extract(epoch)*1000.
    const { sql, calls } = makeSqlStub([]);
    await readProjectHistoryEvents(sql, baseArgs);
    const text = mainSql(calls);

    for (const col of [
      'wi.first_claimed_at',
      'wi.state_changed_at',
      'wi.last_progress_at',
      'pi.updated_at',
    ]) {
      expect(text).toContain(`(extract(epoch FROM ${col}) * 1000)::bigint`);
    }
    // ...and the already-bigint columns are NOT double-converted.
    expect(text).not.toContain('extract(epoch FROM wi.created_ts)');
    expect(text).not.toContain('extract(epoch FROM wi.closed_ts)');
  });

  it('excludes the observation lane', async () => {
    // A raw predicate over work_items is mostly lane='observation' (turn-end
    // agent reflections). The work_items:* tools exclude them by default and
    // raw SQL does not, so a project timeline must exclude them explicitly.
    const { sql, calls } = makeSqlStub([]);
    await readProjectHistoryEvents(sql, baseArgs);
    expect(mainSql(calls)).toContain("wi.lane IS DISTINCT FROM 'observation'");
  });

  it('emits all seven event kinds from the three sources', async () => {
    const { sql, calls } = makeSqlStub([]);
    await readProjectHistoryEvents(sql, baseArgs);
    const text = mainSql(calls);
    for (const kind of [
      'work-item.created',
      'work-item.claimed',
      'work-item.state-changed',
      'work-item.checkpoint',
      'work-item.completed',
      'plan-item.status',
      'plan.decision',
    ]) {
      expect(text).toContain(`'${kind}'`);
    }
  });

  it('orders reverse-chronologically and breaks ties on eventId', async () => {
    const { sql, calls } = makeSqlStub([]);
    await readProjectHistoryEvents(sql, baseArgs);
    expect(mainSql(calls)).toContain('ORDER BY ts_ms DESC, event_id DESC');
  });

  it('uses a TUPLE cursor when beforeEventId is supplied, and a bare bound when it is not', async () => {
    const withTie = makeSqlStub([]);
    await readProjectHistoryEvents(withTie.sql, {
      ...baseArgs,
      beforeMs: 100,
      beforeEventId: 'work-item.created:WI-1:100',
    });
    expect(allSql(withTie.calls)).toContain('(ts_ms, event_id) <');

    const withoutTie = makeSqlStub([]);
    await readProjectHistoryEvents(withoutTie.sql, { ...baseArgs, beforeMs: 100 });
    expect(allSql(withoutTie.calls)).not.toContain('(ts_ms, event_id) <');
    expect(allSql(withoutTie.calls)).toContain('ts_ms <');
  });

  it('scopes by workspace only when a workspaceId is supplied', async () => {
    const scoped = makeSqlStub([]);
    await readProjectHistoryEvents(scoped.sql, { ...baseArgs, workspaceId: 'ws-1' });
    expect(scoped.calls.some((c) => c.values.includes('ws-1'))).toBe(true);

    const unscoped = makeSqlStub([]);
    await readProjectHistoryEvents(unscoped.sql, baseArgs);
    expect(unscoped.calls.some((c) => c.values.includes('ws-1'))).toBe(false);
  });
});

describe('projectHistoryEvents — args validation', () => {
  it('defaults limit to 50 and caps it at 200', () => {
    expect(projectHistoryEventsArgsSchema.parse({ harnessSlug: 'x' }).limit).toBe(50);
    expect(() => projectHistoryEventsArgsSchema.parse({ harnessSlug: 'x', limit: 201 })).toThrow();
    expect(() => projectHistoryEventsArgsSchema.parse({ harnessSlug: 'x', limit: 0 })).toThrow();
  });

  it('requires a harnessSlug — an unscoped feed would leak across harnesses', () => {
    expect(() => projectHistoryEventsArgsSchema.parse({})).toThrow();
    expect(() => projectHistoryEventsArgsSchema.parse({ harnessSlug: '' })).toThrow();
  });
});

describe('projectHistoryEvents — registration', () => {
  it('is registered in the v2 dispatcher', () => {
    expect(isRegisteredV2(PROJECT_HISTORY_EVENTS_QUERY_NAME)).toBe(true);
  });
});

describe('projectHistoryEvents — invalidation', () => {
  it('every backing table bridges a write to this query name', () => {
    // This is the half that makes the tab LIVE. Its sources are written from
    // ~40 app paths and also from raw SQL, MCP-tool writes and migrations that
    // never run app code, so the PG-trigger bridge — not an enumerated set of
    // notify call sites — is what actually reaches subscribers.
    for (const table of PROJECT_HISTORY_EVENTS_BACKING_TABLES) {
      const bridged = (TABLE_TO_QUERY_NAMES[table] ?? []).map((n) =>
        typeof n === 'string' ? n : n.name,
      );
      expect(bridged, `${table} must bridge to the live history feed`).toContain(
        PROJECT_HISTORY_EVENTS_QUERY_NAME,
      );
    }
  });

  it('names exactly the three tables the resolver actually reads', () => {
    // Guards the pairing: a source added to the SQL without a bridge entry is a
    // feed that silently stops updating for that event kind.
    expect([...PROJECT_HISTORY_EVENTS_BACKING_TABLES]).toEqual([
      'harness_shared.work_items',
      'harness_shared.plan_items',
      'harness_shared.harness_plan_parts',
    ]);
  });
});
