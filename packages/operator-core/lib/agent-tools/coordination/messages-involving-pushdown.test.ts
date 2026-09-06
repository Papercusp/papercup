/**
 * messages-involving-pushdown.test.ts — EI-19323734935411369 (the
 * getAgentCoordState leg): `adv-agent-detail.ts`'s `getAgentCoordState` called
 * `coordLog.readLines('messages')` UNCONDITIONALLY on every agent-dossier
 * open/poll (`getAgentDetail`) — the ENTIRE messages surface (measured
 * 2026-08-02: 76,209 rows / 63 MB of JSONB bodies, per call), just to filter to
 * "sent by OR addressed to OR broadcast to THIS owner" in JS.
 * `readInvolvingOwner` pushes that exact union down into SQL, bounded.
 *
 * These pin:
 *   - the union predicate (from = owner OR to @> owner OR to @> '*'),
 *   - ALL kinds included (unlike readInbox, which excludes the owner's own
 *     sends and non-directed notify kinds by default — this function must NOT
 *     inherit that narrowing, since deriveCoordState needs the same population
 *     readLines used to return),
 *   - the `id DESC` cap order (EI-19314819320465915 — ASC silently freezes the
 *     view on the OLDEST rows once an owner's involving-set exceeds the cap),
 *   - the fast path and the fallback never drifting apart in what they RETURN.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/coordination/messages-involving-pushdown.test.ts
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
import { readInvolvingOwner, INVOLVING_FAST_PATH_ROW_CAP } from './messages';

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

function primeSql(rows: { body: unknown }[]) {
  const seen: { text: string; values: unknown[] }[] = [];
  sqlMock.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = Array.isArray(strings) ? strings.join('?') : String(strings);
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

describe('readInvolvingOwner — non-PG backend (fallback)', () => {
  it('falls back to the full readLines read', async () => {
    const all = [env({ msg_id: 'a1' }), env({ msg_id: 'b1', from: 'bob', to: ['carol'] })];
    readLinesMock.mockResolvedValue(all);
    const out = await readInvolvingOwner('alice');
    expect(out).toEqual(all);
    expect(sqlMock).not.toHaveBeenCalled();
  });
});

describe('readInvolvingOwner — PG fast path (sender-or-recipient pushdown)', () => {
  beforeEach(() => {
    fastPathState.on = true;
  });

  it('pushes the from-OR-to-OR-broadcast union + workspace + surface into SQL', async () => {
    const seen = primeSql([{ body: env({ msg_id: 'a1' }) }]);
    const out = await readInvolvingOwner('alice');

    expect(out.map((e) => e.msg_id)).toEqual(['a1']);
    expect(readLinesMock).not.toHaveBeenCalled();
    expect(seen).toHaveLength(1);
    const text = seen[0].text.replace(/\s+/g, ' ');
    expect(text).toContain("body->>'from'");
    expect(text).toContain("(body->'to') ?");
    expect(text).not.toContain('jsonb_exists');
    expect(seen[0].values).toContain('alice');
  });

  it('caps rows with ORDER BY id DESC — never ASC, which would freeze the view on the OLDEST rows', async () => {
    const seen = primeSql([]);
    await readInvolvingOwner('alice');

    const sqlText = seen[0].text.replace(/\s+/g, ' ');
    expect(sqlText).toContain('ORDER BY id DESC');
    expect(sqlText).not.toContain('ORDER BY id ASC');
    expect(seen[0].values).toContain(INVOLVING_FAST_PATH_ROW_CAP);
  });

  it('a JSON-STRING body is parsed (PgCoordLog may hand back text)', async () => {
    primeSql([{ body: JSON.stringify(env({ msg_id: 'a1' })) }]);
    const out = await readInvolvingOwner('alice');
    expect(out[0].msg_id).toBe('a1');
  });

  it('includes ALL kinds — does not inherit readInbox’s default notify/self-send exclusion', async () => {
    // deriveCoordState needs the owner's own sends AND non-directed notify kinds
    // (e.g. for "last message"), unlike readInbox's default population.
    primeSql([
      { body: env({ msg_id: 'self-sent', from: 'alice', to: ['bob'] }) },
      { body: env({ msg_id: 'ambient-notify', from: 'system', to: ['alice'], kind: 'notify' }) },
    ]);
    const out = await readInvolvingOwner('alice');
    expect(out.map((e) => e.msg_id).sort()).toEqual(['ambient-notify', 'self-sent']);
  });

  it('warns — never silently truncates — when the row cap is hit', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    primeSql(
      Array.from({ length: INVOLVING_FAST_PATH_ROW_CAP }, (_, i) => ({
        body: env({ msg_id: `m${i}`, ts: new Date(Date.UTC(2026, 7, 2, 12, 0, 0) + i).toISOString() }),
      })),
    );
    await readInvolvingOwner('alice');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('fast-path row cap'));
    warn.mockRestore();
  });

  it('a query error falls back to the authoritative full read rather than losing the involving-set', async () => {
    sqlMock.mockImplementation(() => {
      throw new Error('connection terminated');
    });
    const all = [env({ msg_id: 'a1' })];
    readLinesMock.mockResolvedValue(all);
    const out = await readInvolvingOwner('alice');
    expect(out).toEqual(all);
    expect(readLinesMock).toHaveBeenCalledWith('messages');
  });

  it('both paths return the SAME result for the same data (no drift between fast path and fallback)', async () => {
    const rows = [
      env({ msg_id: 'a2', from: 'alice', ts: '2026-08-02T12:00:02.000Z' }),
      env({ msg_id: 'to-alice', from: 'bob', to: ['alice'], ts: '2026-08-02T12:00:01.000Z' }),
      env({ msg_id: 'broadcast', from: 'carol', to: ['*'], ts: '2026-08-02T12:00:03.000Z' }),
    ];
    primeSql(rows.map((body) => ({ body })));
    const viaPg = await readInvolvingOwner('alice');

    fastPathState.on = false;
    readLinesMock.mockResolvedValue(rows);
    const viaLines = await readInvolvingOwner('alice');

    expect(viaPg).toEqual(viaLines);
  });

  it('a custom limit is threaded into the SQL LIMIT', async () => {
    const seen = primeSql([]);
    await readInvolvingOwner('alice', 500);
    expect(seen[0].values).toContain(500);
  });
});
