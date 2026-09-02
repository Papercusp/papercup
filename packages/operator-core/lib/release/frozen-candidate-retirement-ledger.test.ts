/** WI-2141736 Layer 3: the durable, bounded record of a dispatch-infeasibility retirement. */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fakeSql = { unsafe: vi.fn(async (..._a: unknown[]) => Object.assign([] as unknown[], { count: 0 })) };
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: fakeSql }),
}));

import {
  FROZEN_REPAIR_RETIREMENT_HISTORY_CAP,
  recordFrozenCandidateRetirement,
} from './frozen-candidate-retirement-ledger';

const target = { workspaceId: 'ws-42', installSlug: 'my-harness' };

beforeEach(() => {
  fakeSql.unsafe.mockClear();
  fakeSql.unsafe.mockImplementation(async (..._a: unknown[]) => Object.assign([] as unknown[], { count: 0 }));
});

describe('WI-2141736 Layer 3 retirement ledger — durable, queryable record of a dispatch-infeasible retire', () => {
  it('the history cap matches the escape ledger convention (bounded, not unbounded growth)', () => {
    expect(FROZEN_REPAIR_RETIREMENT_HISTORY_CAP).toBe(10);
  });

  it('record prepends newest-first, trims to the cap, creates gate_health when missing, in ONE scoped statement — same shape as the escape ledger, a DIFFERENT gate_health key', async () => {
    const entry = {
      atMs: 456,
      abandonedCandidate: 'c'.repeat(40),
      repairHead: 'd'.repeat(40),
      reason: 'dispatch-infeasible',
      attempts: 0,
      ageMs: 900_000,
    };
    await recordFrozenCandidateRetirement(target, entry);
    expect(fakeSql.unsafe).toHaveBeenCalledTimes(1);
    const [query, params] = fakeSql.unsafe.mock.calls[0] as [string, unknown[]];
    // Nested jsonb_set: the inner one materializes gate_health so the outer path always
    // resolves — jsonb_set cannot create intermediate keys on its own.
    expect(query).toMatch(
      /jsonb_set\(\s*jsonb_set\(\s*COALESCE\(metadata, '\{\}'::jsonb\),\s*'\{gate_health\}',\s*COALESCE\(metadata->'gate_health', '\{\}'::jsonb\),\s*true\s*\),\s*'\{gate_health,frozenCandidateRetirements\}'/,
    );
    // A DISTINCT key from candidateEscapes — retirements (no fixer dispatchable at all) and
    // escapes (an exhausted-pin budget spend) are independent exhaustion classes; conflating
    // them into one array would silently widen what the P-008 escape budget window counts.
    expect(query).not.toMatch(/candidateEscapes/);
    // Newest-first: the new entry ($3) is PREPENDED before the stored array, and the trim
    // keeps the FIRST cap entries in order.
    expect(query).toMatch(
      /\$3::jsonb \|\| COALESCE\(metadata->'gate_health'->'frozenCandidateRetirements', '\[\]'::jsonb\)/,
    );
    expect(query).toMatch(/WITH ORDINALITY[\s\S]+ORDER BY ord[\s\S]+LIMIT 10/);
    expect(query).toMatch(
      /WHERE workspace_id = \$1\s+AND install_slug = \$2\s+AND target_role = 'system:green-checkpoint'/,
    );
    expect(params).toEqual(['ws-42', 'my-harness', JSON.stringify([entry])]);
  });

  it('propagates a write failure to the caller (the caller is expected to catch it and log, never block on it)', async () => {
    fakeSql.unsafe.mockRejectedValueOnce(new Error('pg down'));
    await expect(
      recordFrozenCandidateRetirement(target, {
        atMs: 1,
        abandonedCandidate: 'e'.repeat(40),
        repairHead: 'f'.repeat(40),
        reason: 'dispatch-infeasible',
        attempts: 0,
        ageMs: 1,
      }),
    ).rejects.toThrow('pg down');
  });
});
