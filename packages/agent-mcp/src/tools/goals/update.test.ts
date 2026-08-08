/**
 * goals:update — closing the loop on a goal record
 * (goal-mode-2026-08-07 P-009).
 *
 * The failure this file exists to prevent is a PARTIAL update that silently
 * destroys state: reporting spend must not clear the kill criterion recorded at
 * creation, and an omitted field must not be written back as null. That is why
 * the handler resolves every column in JS against a prior read instead of
 * leaning on SQL COALESCE — COALESCE cannot express "detach this parent", and a
 * conditional SQL fragment to work around it is worse.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import tool from './update';

type Call = { sql: string; params: unknown[] };
let calls: Call[] = [];
let existingRow: Record<string, unknown> | null = null;

function makeTx() {
  return (strings: TemplateStringsArray, ...params: unknown[]) => {
    const sql = strings.join('?');
    calls.push({ sql, params });
    if (/^\s*SELECT/.test(sql)) {
      return Promise.resolve(existingRow ? [existingRow] : []);
    }
    return Promise.resolve([]);
  };
}

const CTX = () => ({ tx: makeTx() as never, workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp' });
const updateCall = () => calls.find((c) => /UPDATE harness_shared\.goals/.test(c.sql))!;

/**
 * The metadata param as an OBJECT. Substring-matching the stringified params
 * cannot see it: the metadata is itself JSON, so inside a JSON.stringify of the
 * param list its quotes are escaped (`\"spentCents\":999`) and a plain
 * `toContain('"spentCents":999')` fails against a perfectly correct write.
 */
const writtenMetadata = (): Record<string, unknown> => {
  const jsonParam = updateCall().params.find(
    (p): p is string => typeof p === 'string' && p.trimStart().startsWith('{'),
  );
  return jsonParam ? JSON.parse(jsonParam) : {};
};

beforeEach(() => {
  calls = [];
  existingRow = {
    title: 'Ship a paid app',
    body: 'the original statement',
    status: 'active',
    parent_id: null,
    budget_cents: '50000',
    metadata: { killCriterion: 'no paying user after 2 weeks' },
  };
});

describe('goals:update — partial writes preserve untouched state', () => {
  it('reporting spend does NOT clear the kill criterion', async () => {
    await tool.handler(tool.args.parse({ id: 'g1', spentCents: 1234 }) as never, CTX() as never);
    expect(writtenMetadata()).toEqual({
      killCriterion: 'no paying user after 2 weeks',
      spentCents: 1234,
    });
  });

  it('revising the kill criterion does NOT clear previously reported spend', async () => {
    existingRow!.metadata = { killCriterion: 'old', spentCents: 999 };
    await tool.handler(tool.args.parse({ id: 'g1', killCriterion: 'new' }) as never, CTX() as never);
    expect(writtenMetadata()).toEqual({ killCriterion: 'new', spentCents: 999 });
  });

  it('leaves unrelated metadata keys alone (merge, not replace)', async () => {
    existingRow!.metadata = { killCriterion: 'k', ownerNote: 'keep me' };
    await tool.handler(tool.args.parse({ id: 'g1', spentCents: 7 }) as never, CTX() as never);
    expect(writtenMetadata()).toEqual({ killCriterion: 'k', ownerNote: 'keep me', spentCents: 7 });
  });

  it('an omitted field is written back as its previous value, never as null', async () => {
    await tool.handler(tool.args.parse({ id: 'g1', status: 'killed' }) as never, CTX() as never);
    const params = updateCall().params;
    expect(params).toContain('Ship a paid app'); // title preserved
    expect(params).toContain('the original statement'); // body preserved
    expect(params).toContain('killed'); // the one field that moved
  });

  it('preserves the declared ceiling as a NUMBER when untouched (bigint arrives as a string)', async () => {
    await tool.handler(tool.args.parse({ id: 'g1', status: 'achieved' }) as never, CTX() as never);
    expect(updateCall().params).toContain(50000);
  });
});

describe('goals:update — parent re-parenting', () => {
  it('leaves the parent alone when parentId is omitted', async () => {
    existingRow!.parent_id = 'parent-abc';
    await tool.handler(tool.args.parse({ id: 'g1', status: 'paused' }) as never, CTX() as never);
    expect(updateCall().params).toContain('parent-abc');
  });

  it('DETACHES the parent on an explicit null — the case COALESCE cannot express', async () => {
    existingRow!.parent_id = 'parent-abc';
    await tool.handler(tool.args.parse({ id: 'g1', parentId: null }) as never, CTX() as never);
    expect(updateCall().params).not.toContain('parent-abc');
  });
});

describe('goals:update — closing a goal', () => {
  it('accepts the terminal statuses that stop the ratchet', async () => {
    for (const status of ['killed', 'achieved']) {
      expect(tool.args.safeParse({ id: 'g1', status }).success).toBe(true);
    }
  });

  it('rejects an invented status rather than writing it', () => {
    expect(tool.args.safeParse({ id: 'g1', status: 'sunsetted' }).success).toBe(false);
  });

  it('degrades rather than throwing when the goal does not exist', async () => {
    existingRow = null;
    // `handler` is typed as the ToolResult | ToolResponse union, which does not
    // narrow on a bare `.data`; the rest of this package's tests carry the
    // resulting TS2339s in its baseline, so narrow here rather than add to it.
    const res = (await tool.handler(tool.args.parse({ id: 'nope' }) as never, CTX() as never)) as {
      data: unknown;
      degraded?: boolean;
      degradedReasons?: string[];
    };
    expect(res.data).toBeNull();
    expect(res.degraded).toBe(true);
    expect(res.degradedReasons?.join(' ')).toContain('nope');
    // and must not have attempted the write
    expect(calls.some((c) => /UPDATE/.test(c.sql))).toBe(false);
  });

  it('requires an id', () => {
    expect(tool.args.safeParse({}).success).toBe(false);
    expect(tool.args.safeParse({ id: '' }).success).toBe(false);
  });
});
