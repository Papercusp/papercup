/**
 * messages-outbox-pushdown.test.ts — EI-19323734935411369: `readOutbox` was the
 * last PRIMARY caller of the unbounded `coordLog.readLines('messages')`. It
 * loaded the ENTIRE messages surface (measured 2026-08-02: 76,209 rows / 63 MB
 * of JSONB bodies, per call, 349,842 calls) only to filter by `from` in JS —
 * even though every routine caller already passes `since_ts`.
 *
 * These pin the sender+since pushdown and, more importantly, the three traps it
 * could regress into:
 *   - the `id DESC` cap order (EI-19314819320465915 — `ASC` silently freezes the
 *     view on the OLDEST rows once a sender exceeds the cap),
 *   - an unparseable `since_ts` (NaN) reaching `new Date(...).toISOString()`,
 *   - the fast path and the fallback drifting apart in what they RETURN.
 *
 * The messages-get-by-id.test.ts recipe: only ./log is mocked, so both branches
 * are exercised with no DB.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/coordination/messages-outbox-pushdown.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sqlMock, readLinesMock, fastPathState } = vi.hoisted(() => ({
  sqlMock: vi.fn(),
  readLinesMock: vi.fn(async () => [] as unknown[]),
  fastPathState: { on: false },
}));

vi.mock('./log', () => ({
  coordLog: { readLines: readLinesMock },
  coordSql: () => sqlMock,
  coordWorkspaceId: () => 'default',
  coordHasPgFastPath: () => fastPathState.on,
}));

import type { CoordEnvelope } from '@papercusp/coordination/core';
import { readOutbox, OUTBOX_FAST_PATH_ROW_CAP } from './messages';

function env(p: Partial<CoordEnvelope> = {}): CoordEnvelope {
  return {
    ts: '2026-08-02T12:00:00.000Z',
    msg_id: 'm0',
    from: 'alice',
    to: ['bob'],
    kind: 'message',
    ...p,
  } as CoordEnvelope;
}

/**
 * `sql` is a tagged template AND is called again for the conditional
 * `AND ts >= …` fragment. JS evaluates substitutions before the outer tag, so
 * the fragment call lands FIRST. This routes only the SELECT call to `rows`,
 * and records the outer call's text + values for assertion.
 */
function primeSql(rows: { body: unknown }[]) {
  const seen: { text: string; values: unknown[] }[] = [];
  sqlMock.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = Array.isArray(strings) ? strings.join('?') : String(strings);
    if (!text.includes('SELECT body')) return { fragment: text, values }; // the AND ts >= … piece
    seen.push({ text, values });
    return Promise.resolve(rows);
  });
  return seen;
}

beforeEach(() => {
  vi.clearAllMocks();
  fastPathState.on = false;
  readLinesMock.mockResolvedValue([]);
});

describe('readOutbox — non-PG backend (fallback)', () => {
  it('filters by sender and sorts ascending by (ts, msg_id)', async () => {
    readLinesMock.mockResolvedValue([
      env({ msg_id: 'b1', from: 'bob', ts: '2026-08-02T12:00:00.000Z' }),
      env({ msg_id: 'a2', from: 'alice', ts: '2026-08-02T12:00:02.000Z' }),
      env({ msg_id: 'a1', from: 'alice', ts: '2026-08-02T12:00:01.000Z' }),
    ]);
    const out = await readOutbox('alice');
    expect(out.map((e) => e.msg_id)).toEqual(['a1', 'a2']);
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it('since_ts filters strictly later than the cutoff', async () => {
    readLinesMock.mockResolvedValue([
      env({ msg_id: 'old', ts: '2026-08-02T12:00:00.000Z' }),
      env({ msg_id: 'at', ts: '2026-08-02T12:00:01.000Z' }),
      env({ msg_id: 'new', ts: '2026-08-02T12:00:02.000Z' }),
    ]);
    const out = await readOutbox('alice', { since_ts: '2026-08-02T12:00:01.000Z' });
    expect(out.map((e) => e.msg_id)).toEqual(['new']);
  });
});

describe('readOutbox — PG fast path (sender pushdown)', () => {
  beforeEach(() => {
    fastPathState.on = true;
  });

  it('pushes sender + workspace + surface into SQL and never scans the whole surface', async () => {
    const seen = primeSql([{ body: env({ msg_id: 'a1' }) }]);
    const out = await readOutbox('alice');

    expect(out.map((e) => e.msg_id)).toEqual(['a1']);
    expect(readLinesMock).not.toHaveBeenCalled();
    expect(seen).toHaveLength(1);
    expect(seen[0].text).toContain("body->>'from'");
    expect(seen[0].values).toContain('alice');
  });

  it('caps rows with ORDER BY id DESC — never ASC, which would freeze the view on the OLDEST rows', async () => {
    const seen = primeSql([]);
    await readOutbox('alice');

    const sqlText = seen[0].text.replace(/\s+/g, ' ');
    expect(sqlText).toContain('ORDER BY id DESC');
    expect(sqlText).not.toContain('ORDER BY id ASC');
    expect(seen[0].values).toContain(OUTBOX_FAST_PATH_ROW_CAP);
  });

  it('a since_ts becomes a SKEW-PADDED ts lower bound (padded EARLIER, never later)', async () => {
    const seen = primeSql([]);
    const since = '2026-08-02T12:00:00.000Z';
    await readOutbox('alice', { since_ts: since });

    // The padded bound rides the fragment call, not the SELECT call.
    const fragment = sqlMock.mock.results
      .map((r) => r.value)
      .find((v) => v && typeof v === 'object' && 'fragment' in v) as
      | { fragment: string; values: unknown[] }
      | undefined;
    expect(fragment?.fragment).toContain('AND ts >=');
    const bound = String(fragment?.values[0]);
    expect(new Date(bound).getTime()).toBeLessThan(new Date(since).getTime());
  });

  it('omits the ts bound entirely when no since_ts is given (the sync-resolver call shape)', async () => {
    primeSql([]);
    await readOutbox('alice');
    const fragments = sqlMock.mock.results
      .map((r) => r.value)
      .filter((v) => v && typeof v === 'object' && 'fragment' in v) as { fragment: string }[];
    expect(fragments.every((f) => !f.fragment.includes('AND ts >='))).toBe(true);
  });

  it('an UNPARSEABLE since_ts does not throw (NaN must never reach toISOString) and drops the bound', async () => {
    primeSql([{ body: env({ msg_id: 'a1' }) }]);
    const out = await readOutbox('alice', { since_ts: 'not-a-timestamp' });
    // NaN degrades to "no lower bound" — the pre-existing behaviour, not a crash.
    expect(out.map((e) => e.msg_id)).toEqual(['a1']);
    const fragments = sqlMock.mock.results
      .map((r) => r.value)
      .filter((v) => v && typeof v === 'object' && 'fragment' in v) as { fragment: string }[];
    expect(fragments.every((f) => !f.fragment.includes('AND ts >='))).toBe(true);
  });

  it('re-sorts ASCENDING even though SQL fetched DESC — the SQL order picks rows, not presentation', async () => {
    primeSql([
      { body: env({ msg_id: 'a3', ts: '2026-08-02T12:00:03.000Z' }) },
      { body: env({ msg_id: 'a2', ts: '2026-08-02T12:00:02.000Z' }) },
      { body: env({ msg_id: 'a1', ts: '2026-08-02T12:00:01.000Z' }) },
    ]);
    const out = await readOutbox('alice');
    expect(out.map((e) => e.msg_id)).toEqual(['a1', 'a2', 'a3']);
  });

  it('a JSON-STRING body is parsed (PgCoordLog may hand back text)', async () => {
    primeSql([{ body: JSON.stringify(env({ msg_id: 'a1' })) }]);
    const out = await readOutbox('alice');
    expect(out[0].msg_id).toBe('a1');
  });

  it('re-applies the sender filter as the final authority, so a mismatched row can never leak', async () => {
    primeSql([{ body: env({ msg_id: 'a1' }) }, { body: env({ msg_id: 'b1', from: 'bob' }) }]);
    const out = await readOutbox('alice');
    expect(out.map((e) => e.msg_id)).toEqual(['a1']);
  });

  it('re-applies since_ts as the final authority (the SQL bound is padded, so it over-fetches on purpose)', async () => {
    primeSql([
      { body: env({ msg_id: 'padded-in', ts: '2026-08-02T11:55:00.000Z' }) },
      { body: env({ msg_id: 'real', ts: '2026-08-02T12:00:05.000Z' }) },
    ]);
    const out = await readOutbox('alice', { since_ts: '2026-08-02T12:00:00.000Z' });
    expect(out.map((e) => e.msg_id)).toEqual(['real']);
  });

  it('warns — never silently truncates — when the row cap is hit', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    primeSql(
      Array.from({ length: OUTBOX_FAST_PATH_ROW_CAP }, (_, i) => ({
        body: env({ msg_id: `m${i}`, ts: new Date(Date.UTC(2026, 7, 2, 12, 0, 0) + i).toISOString() }),
      })),
    );
    await readOutbox('alice');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('fast-path row cap'));
    warn.mockRestore();
  });

  it('a query error falls back to the authoritative full read rather than losing the outbox', async () => {
    sqlMock.mockImplementation((strings: TemplateStringsArray) => {
      const text = Array.isArray(strings) ? strings.join('?') : String(strings);
      if (!text.includes('SELECT body')) return { fragment: text, values: [] };
      throw new Error('connection terminated');
    });
    readLinesMock.mockResolvedValue([env({ msg_id: 'a1' }), env({ msg_id: 'b1', from: 'bob' })]);
    const out = await readOutbox('alice');
    expect(out.map((e) => e.msg_id)).toEqual(['a1']);
    expect(readLinesMock).toHaveBeenCalledWith('messages');
  });

  it('both paths return the SAME result for the same data (no drift between fast path and fallback)', async () => {
    const rows = [
      env({ msg_id: 'a2', ts: '2026-08-02T12:00:02.000Z' }),
      env({ msg_id: 'a1', ts: '2026-08-02T12:00:01.000Z' }),
      env({ msg_id: 'b1', from: 'bob', ts: '2026-08-02T12:00:03.000Z' }),
    ];
    primeSql(rows.map((body) => ({ body })));
    const viaPg = await readOutbox('alice');

    fastPathState.on = false;
    readLinesMock.mockResolvedValue(rows);
    const viaLines = await readOutbox('alice');

    expect(viaPg).toEqual(viaLines);
  });
});
