/**
 * agent-economy-flywheel P-003 (E1, WI-10004287), clause AUTO-BAR-R-12:
 * "Generating shadow statements creates no payment voucher."
 *
 * The reader is the only part of shadow metering that touches Postgres, so the clause holds
 * exactly when every statement the reader can issue is a read. This drives the full
 * `readShadowStatement` path through a recording fake `sql` that answers the two queries with
 * representative rows (so pricing runs end to end, not just the empty path) and asserts:
 *   - only the plain tagged-template call is used: any other client method (`begin`, `unsafe`,
 *     `json`, `listen`, `notify`, ...) throws, so a transaction or raw write cannot slip in;
 *   - every issued statement is a read, and none names a voucher, payment, ledger or channel
 *     relation;
 *   - the statement still carries a non-zero would-have-charged amount, so "no voucher" is not
 *     the vacuous result of pricing nothing.
 * The write detector has its own positive controls so it cannot pass by matching nothing.
 *
 * The integration test (`shadow-metering-reader.integration.test.ts`) covers the SQL against
 * real migrations; this file covers the "no write" property at the unit layer the clause names.
 */
import type { Sql } from 'postgres';
import { describe, expect, it } from 'vitest';
import { readShadowStatement } from './shadow-metering-reader';

/** A write verb or side-effecting function anywhere in the statement. */
const WRITE_RE =
  /\b(insert|update|delete|merge|upsert|truncate|copy|call|create|alter|drop|grant|revoke|lock|vacuum|refresh|nextval|setval|pg_notify|lo_import|lo_unlink|set_config)\b/i;
/** Relations a payment or voucher would be written to. */
const PAYMENT_RE = /voucher|payment|ledger|channel|invoice|charge_|settle/i;

function isReadOnlyStatement(text: string): boolean {
  const trimmed = text.trim();
  return /^(select|with)\b/i.test(trimmed) && !WRITE_RE.test(trimmed) && !PAYMENT_RE.test(trimmed);
}

interface Recorded {
  text: string;
  values: unknown[];
}

/** A `sql` stand-in that records every tagged-template call and refuses any other method. */
function recordingSql(answer: (text: string) => unknown[]): { sql: Sql; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('$?');
    calls.push({ text, values });
    return Promise.resolve(answer(text));
  };
  const sql = new Proxy(tag, {
    get(_target, prop) {
      throw new Error(`shadow metering reader used sql.${String(prop)}; only read queries are allowed`);
    },
  });
  return { sql: sql as unknown as Sql, calls };
}

const USAGE_ROWS = [
  {
    attributed: true,
    agent: 'claude',
    profile: 'papercusp-engineer',
    spec_layers: ['domain:papercusp-engineer'],
    axis_layers: [],
    cost_source: 'provider',
    cost_usd: '1.000000',
    samples: '10',
  },
  {
    attributed: false,
    agent: null,
    profile: null,
    spec_layers: null,
    axis_layers: null,
    cost_source: 'estimated',
    cost_usd: '0.500000',
    samples: '4',
  },
];
const TOOL_ROWS = [
  { attributed: true, calls: '7' },
  { attributed: false, calls: '3' },
];

function answer(text: string): unknown[] {
  // D-018 point 4: the cost-basis read (the only one that names the price stamp).
  if (text.includes('price_table_version')) return [{ samples: '12', stale: '0', unpriced: '0', lower_bound: '0' }];
  return text.includes('tool_invocations_identity_attribution') ? TOOL_ROWS : USAGE_ROWS;
}

describe('readShadowStatement issues no writes (AUTO-BAR-R-12)', () => {
  it('detects writes and payment relations (positive controls for the detector)', () => {
    expect(isReadOnlyStatement('SELECT 1 FROM harness_shared.agent_usage_samples')).toBe(true);
    expect(isReadOnlyStatement('WITH s AS (SELECT 1) SELECT * FROM s')).toBe(true);
    expect(isReadOnlyStatement('INSERT INTO harness_shared.cupboard_vouchers VALUES (1)')).toBe(false);
    expect(isReadOnlyStatement('WITH v AS (INSERT INTO t VALUES (1) RETURNING 1) SELECT * FROM v')).toBe(false);
    expect(isReadOnlyStatement('SELECT nextval(\'harness_shared.seq\')')).toBe(false);
    expect(isReadOnlyStatement('SELECT * FROM harness_shared.payment_channels')).toBe(false);
    expect(isReadOnlyStatement('SELECT pg_notify(\'x\', \'y\')')).toBe(false);
  });

  it('prices a workspace-month using only read queries and names no payment relation', async () => {
    const { sql, calls } = recordingSql(answer);
    const statement = await readShadowStatement(sql, { workspaceId: 'ws-1', month: '2026-09' });

    // usage + tool calls + the D-018 cost basis.
    expect(calls).toHaveLength(3);
    expect(statement.costBasis).toMatchObject({ samples: 12, staleSamples: 0, unpricedSamples: 0 });
    for (const call of calls) {
      expect(isReadOnlyStatement(call.text), call.text).toBe(true);
      expect(call.values).toContain('ws-1');
    }
    // Pricing really ran: the attributed spec-layer line produced a markup to (not) charge.
    expect(statement.totals.wouldHaveChargedMicros).toBe(200_000);
    expect(statement.totals.wouldHaveChargedMicros).toBe(statement.totals.markupMicros);
    expect(statement.zeroPriced.toolCalls).toEqual({ attributed: 7, unattributed: 3 });
  });

  it('uses no client method other than a plain query, so no transaction or raw write is possible', async () => {
    const { sql } = recordingSql(answer);
    expect(() => (sql as unknown as { begin: unknown }).begin).toThrow(/sql\.begin/);
    expect(() => (sql as unknown as { unsafe: unknown }).unsafe).toThrow(/sql\.unsafe/);
    // The full read path completes under that refusal.
    await expect(readShadowStatement(sql, { workspaceId: 'ws-1', month: '2026-09' })).resolves.toBeDefined();
  });
});
