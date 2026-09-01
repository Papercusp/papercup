/** P-008 (WI-1961441): the recorded half of the bounded recut hatch. */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fakeSql = { unsafe: vi.fn(async (..._a: unknown[]) => Object.assign([] as unknown[], { count: 0 })) };
const sqlRows = (rows: unknown[]) => Object.assign(rows, { count: rows.length });
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: fakeSql }),
}));

import {
  FROZEN_REPAIR_ESCAPE_HISTORY_CAP,
  FROZEN_REPAIR_ESCAPE_WINDOW_MS,
  readRecentFrozenCandidateEscapes,
  recordFrozenCandidateEscape,
} from './frozen-candidate-escape-ledger';

const target = { workspaceId: 'ws-42', installSlug: 'my-harness' };

beforeEach(() => {
  fakeSql.unsafe.mockClear();
  fakeSql.unsafe.mockImplementation(async (..._a: unknown[]) => Object.assign([] as unknown[], { count: 0 }));
});

describe('P-008 escape ledger — the recorded, per-day bound behind maxCandidateEscapes', () => {
  it('the window is one rolling day: the owner decision is 0 → 1/day, so the day IS the budget denominator', () => {
    expect(FROZEN_REPAIR_ESCAPE_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('read counts only in-window entries on the scoped routine row, guarding non-numeric atMs', async () => {
    fakeSql.unsafe.mockResolvedValueOnce(sqlRows([{ escapes: 2 }]));
    await expect(
      readRecentFrozenCandidateEscapes(target, FROZEN_REPAIR_ESCAPE_WINDOW_MS, 1_000_000),
    ).resolves.toBe(2);
    expect(fakeSql.unsafe).toHaveBeenCalledWith(
      expect.stringMatching(
        // The three tenant/scope predicates, the numeric guard, and the strict cutoff — a
        // count computed without any one of these answers about a different population.
        /workspace_id = \$1[\s\S]+install_slug = \$2[\s\S]+target_role = 'system:green-checkpoint'[\s\S]+e->>'atMs' ~ '\^\[0-9\]\+\$'[\s\S]+\(e->>'atMs'\)::bigint > \$3::bigint/,
      ),
      ['ws-42', 'my-harness', 1_000_000 - FROZEN_REPAIR_ESCAPE_WINDOW_MS],
    );
  });

  it('read returns 0 (not NaN/undefined) when the ledger is empty or the row is absent', async () => {
    fakeSql.unsafe.mockResolvedValueOnce(sqlRows([]));
    await expect(readRecentFrozenCandidateEscapes(target)).resolves.toBe(0);
  });

  it('read is throw-transparent so the engine caller can fail CLOSED (budget-spent), never open', async () => {
    fakeSql.unsafe.mockRejectedValueOnce(new Error('pg down'));
    await expect(readRecentFrozenCandidateEscapes(target)).rejects.toThrow('pg down');
  });

  it('record prepends newest-first, trims to the cap, creates gate_health when missing, in ONE scoped statement', async () => {
    const entry = {
      atMs: 123,
      abandonedCandidate: 'a'.repeat(40),
      repairHead: 'b'.repeat(40),
      reason: 'attempts-exhausted',
      ordinal: 1,
    };
    await recordFrozenCandidateEscape(target, entry);
    expect(fakeSql.unsafe).toHaveBeenCalledTimes(1);
    const [query, params] = fakeSql.unsafe.mock.calls[0] as [string, unknown[]];
    // Nested jsonb_set: the inner one materializes gate_health so the outer path always
    // resolves — jsonb_set cannot create intermediate keys on its own.
    expect(query).toMatch(
      /jsonb_set\(\s*jsonb_set\(\s*COALESCE\(metadata, '\{\}'::jsonb\),\s*'\{gate_health\}',\s*COALESCE\(metadata->'gate_health', '\{\}'::jsonb\),\s*true\s*\),\s*'\{gate_health,candidateEscapes\}'/,
    );
    // Newest-first: the new entry ($3) is PREPENDED before the stored array, and the trim
    // keeps the FIRST cap entries in order — dropping the prepend or the ORDER BY silently
    // turns the cap into "keep the oldest", which un-counts fresh escapes from the window.
    expect(query).toMatch(/\$3::jsonb \|\| COALESCE\(metadata->'gate_health'->'candidateEscapes', '\[\]'::jsonb\)/);
    expect(query).toMatch(/WITH ORDINALITY[\s\S]+ORDER BY ord[\s\S]+LIMIT 10/);
    expect(FROZEN_REPAIR_ESCAPE_HISTORY_CAP).toBe(10);
    expect(query).toMatch(
      /WHERE workspace_id = \$1\s+AND install_slug = \$2\s+AND target_role = 'system:green-checkpoint'/,
    );
    expect(params).toEqual(['ws-42', 'my-harness', JSON.stringify([entry])]);
  });
});
