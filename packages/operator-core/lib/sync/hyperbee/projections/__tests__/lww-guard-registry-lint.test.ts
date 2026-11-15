/**
 * lww-guard-registry-lint.test.ts — EI-1678.
 *
 * THE GAP: `read-merge.ts`'s POST-CURSOR-RESET DOUBLE-APPLY SAFETY contract is
 * "A NEW projection MUST copy this [fed_hlc/fed_ts LWW] guard shape or reset
 * replays will clobber." That contract is the second correctness floor for
 * federation (a reset re-folds every op from 0 against rows already at the final
 * state, so a guard-less DO UPDATE re-applies a stale op = the EI-117 / EI-1688
 * resurrection class). Today it is enforced only by per-projection integration
 * tests + code review — there is NO single check that a NEWLY-REGISTERED mutable
 * projection actually carries the guard. (The half-wired hive_policy projection
 * that RED'd the green-checkpoint for 7h this session was the registry-bijection
 * cousin of exactly this gap.)
 *
 * THE RULE (clean + non-allowlist): a projection that OVERWRITES on conflict —
 * `ON CONFLICT … DO UPDATE` — is last-writer-wins and MUST guard that statement
 * with the `fed_hlc`/`fed_ts` LWW key. Projections that do NOT overwrite are
 * auto-exempt and need no allowlist:
 *   - `DO NOTHING` (idempotent insert ledger, e.g. usage.ts)
 *   - append-only / del-refusing (e.g. feature-claims.ts)
 *   - bootstrap-only `INSERT … DO NOTHING` (e.g. harness-plan-parts.ts)
 * So keying on `DO UPDATE` classifies correctly without a manual exempt-list that
 * would rot.
 *
 * This is a SOURCE LINT (PG-free, fast): it scans every projection source file
 * and asserts each `DO UPDATE` clause carries a `fed_hlc`/`fed_ts` WHERE guard
 * or guards every scalar assignment while retaining monotonic set contributions.
 * It makes the merge docblock's prose contract MACHINE-ENFORCED for future
 * projections — a guard-less mutable projection fails ONE check instead of
 * escaping to prod.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PROJECTIONS_DIR = fileURLToPath(new URL('../', import.meta.url));

/** Strip TS comments so a `DO UPDATE` in a docblock/comment (e.g. presence.ts's
 *  "DO UPDATE always overwrites…") is not mistaken for real SQL. */
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function stripSqlComments(sql: string): string {
  let result = '';
  let quoted = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]!;
    if (!quoted && c === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      if (end === -1) break;
      i = end;
      result += '\n';
      continue;
    }
    result += c;
    if (c === "'") {
      if (quoted && sql[i + 1] === "'") { result += sql[++i]; continue; }
      quoted = !quoted;
    }
  }
  return result;
}

/** Split SET assignments without splitting function arguments or SQL string literals. */
function assignments(set: string): string[] {
  const result: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let i = 0; i < set.length; i++) {
    const c = set[i];
    if (c === "'") {
      if (quoted && set[i + 1] === "'") { i++; continue; }
      quoted = !quoted;
    } else if (!quoted) {
      if (c === '(') depth++;
      if (c === ')') depth--;
      if (c === ',' && depth === 0) { result.push(set.slice(start, i)); start = i + 1; }
    }
  }
  if (quoted || depth !== 0) return [];
  result.push(set.slice(start));
  return result;
}

/** A subquery's WHERE filters a collection; it cannot protect the upsert's scalars. */
function rowGuard(clause: string): string {
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < clause.length; i++) {
    if (clause[i] === "'") {
      if (quoted && clause[i + 1] === "'") { i++; continue; }
      quoted = !quoted;
    } else if (!quoted) {
      if (clause[i] === '(') depth++;
      if (clause[i] === ')') depth--;
      if (depth === 0 && !/[a-z0-9_]/i.test(clause[i - 1] ?? '')
        && /^WHERE\b/i.test(clause.slice(i))) return clause.slice(i);
    }
  }
  return '';
}

function guardedAssignments(clause: string, table: string): boolean {
  const set = clause.replace(/^DO\s+UPDATE\s+SET\s+/i, '').trim().replace(/;$/, '');
  const parts = assignments(set);
  if (parts.length === 0) return false;
  const target = table.toLowerCase();
  const order = `harness_shared.fed_order_key(excluded.fed_hlc,excluded.fed_ts)>=harness_shared.fed_order_key(${target}.fed_hlc,${target}.fed_ts)`;
  return parts.every(part => {
    const match = /^\s*([a-z_][a-z0-9_]*)\s*=\s*([\s\S]+)$/i.exec(part);
    if (!match) return false;
    const column = match[1]!.toLowerCase();
    const value = match[2]!.toLowerCase().replace(/\s+/g, '');
    // The predicate, incoming field and retained field must all match this assignment.
    if (value === `casewhen${order}thenexcluded.${column}else${target}.${column}end`) return true;
    const jsonUnion = `coalesce((selectjsonb_agg(distinctvalueorderbyvalue)fromjsonb_array_elements(coalesce(${target}.${column},'[]'::jsonb)||excluded.${column})),'[]'::jsonb)`;
    if (value === jsonUnion) return true;
    // Only the alias name varies; filters, replacement and one-sided sets fail closed.
    const arrayUnion = value.replace(/as[a-z_][a-z0-9_]*\(value\)/, 'asitems(value)');
    return arrayUnion === `array(selectdistinctvaluefromunnest(coalesce(${target}.${column},'{}'::text[])||excluded.${column})asitems(value)orderbyvalue)`;
  });
}

/**
 * For each REAL-SQL `DO UPDATE` in `src`, return the clauses (the SQL from the
 * `DO UPDATE` to the end of its `sql\`…\`` template) that LACK a fed_hlc/fed_ts
 * row guard or individually guarded assignments. An empty array = every overwrite is LWW-guarded.
 */
export function unguardedDoUpdateClauses(rawSrc: string): string[] {
  const src = stripComments(rawSrc);
  const out: string[] = [];
  const re = /DO\s+UPDATE/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const start = m.index;
    // The clause lives inside one sql`…` template; its end is the next backtick.
    const close = src.indexOf('`', start);
    const clause = stripSqlComments(src.slice(start, close === -1 ? start + 1200 : close));
    const templateStart = src.lastIndexOf('`', start);
    const table = /INSERT\s+INTO\s+([a-z_][a-z0-9_.]*)/i.exec(src.slice(templateStart, start))?.[1];
    const hasGuard = /\bfed_(hlc|ts)\b/.test(rowGuard(clause))
      || (table !== undefined && guardedAssignments(clause, table));
    if (!hasGuard) out.push(clause.slice(0, 160).replace(/\s+/g, ' ').trim());
  }
  return out;
}

function projectionFiles(): string[] {
  return readdirSync(PROJECTIONS_DIR)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'register-all.ts' && f !== 'index.ts');
}

describe('EI-1678 — every mutable (DO UPDATE) projection carries the fed_hlc/fed_ts LWW guard', () => {
  const files = projectionFiles();

  it('the projections dir is non-empty (the lint actually has files to scan)', () => {
    expect(files.length).toBeGreaterThan(10); // ~22 projections today
  });

  for (const file of files) {
    const src = readFileSync(PROJECTIONS_DIR + file, 'utf8');
    if (!/DO\s+UPDATE/i.test(src)) continue; // DO NOTHING / append-only → LWW-exempt
    it(`${file}: every DO UPDATE overwrite is fed_hlc/fed_ts-guarded`, () => {
      const unguarded = unguardedDoUpdateClauses(src);
      expect(unguarded).toEqual([]); // a guard-less mutable upsert = the EI-117 resurrection class
    });
  }
});

describe('EI-1678 — the lint matcher has teeth (negative + positive controls)', () => {
  const scalar = (column: string) => `${column} = CASE WHEN harness_shared.fed_order_key(EXCLUDED.fed_hlc, EXCLUDED.fed_ts) >= harness_shared.fed_order_key(t.fed_hlc, t.fed_ts) THEN EXCLUDED.${column} ELSE t.${column} END`;
  const mixed = (extra = '') => 'sql`INSERT INTO t (k,v,fed_ts) VALUES (1,2,3) ON CONFLICT (k) DO UPDATE SET '
    + [scalar('v'), scalar('fed_ts'), scalar('fed_hlc'),
      "devices = COALESCE((SELECT jsonb_agg(DISTINCT value ORDER BY value) FROM jsonb_array_elements(COALESCE(t.devices, '[]'::jsonb) || EXCLUDED.devices)), '[]'::jsonb)",
      "revoked = ARRAY(SELECT DISTINCT value FROM unnest(COALESCE(t.revoked, '{}'::text[]) || EXCLUDED.revoked) AS revoked(value) ORDER BY value)",
    ].join(', ') + extra + '`';

  it('accepts scalar clocks plus both monotonic set shapes', () => {
    expect(unguardedDoUpdateClauses(mixed())).toEqual([]);
  });

  it('ignores SQL comment punctuation without dropping quoted SQL values', () => {
    const commented = mixed().replace('DO UPDATE SET', "DO UPDATE SET\n -- an op's clock (including HLC)\n");
    expect(unguardedDoUpdateClauses(commented)).toEqual([]);
    expect(unguardedDoUpdateClauses("sql`INSERT INTO t(k,v) VALUES(1,2) ON CONFLICT(k) DO UPDATE SET v='no--WHERE fed_ts'`"))
      .toHaveLength(1);
  });

  it.each([
    mixed(', status = EXCLUDED.status'),
    mixed().replace('THEN EXCLUDED.v', 'THEN EXCLUDED.status'),
    mixed().replace('ELSE t.v', 'ELSE t.status'),
    mixed().replace('>=', '<='),
    mixed().replace('t.fed_ts)', 'other.fed_ts)'),
    mixed().replace('|| EXCLUDED.devices', ''),
    mixed().replace('|| EXCLUDED.revoked', ''),
    mixed().replace('AS revoked(value) ORDER BY', 'AS revoked(value) WHERE value <> \'old\' ORDER BY'),
    mixed().replace("COALESCE(t.revoked, '{}'::text[])", "'{}'::text[]"),
  ])('rejects an unguarded scalar, mismatched clock/field or non-monotonic collection: %s', source => {
    expect(unguardedDoUpdateClauses(source)).toHaveLength(1);
  });

  it('FLAGS a guard-less DO UPDATE (the bug it must catch)', () => {
    const bad = 'sql`INSERT INTO t (k,v,fed_ts) VALUES (1,2,3) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v`';
    expect(unguardedDoUpdateClauses(bad).length).toBe(1);
  });
  it('PASSES a fed_hlc/fed_ts-guarded DO UPDATE (the correct shape)', () => {
    const good =
      'sql`INSERT INTO t (k,v,fed_ts,fed_hlc) VALUES (1,2,3,$1) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v, fed_ts=EXCLUDED.fed_ts WHERE EXCLUDED.fed_hlc >= t.fed_hlc OR t.fed_ts <= EXCLUDED.fed_ts`';
    expect(unguardedDoUpdateClauses(good)).toEqual([]);
  });
  it('does NOT flag a DO NOTHING upsert (the legitimately-exempt append-only/ledger shape)', () => {
    const ledger = 'sql`INSERT INTO usage (h, event_id) VALUES ($1,$2) ON CONFLICT (h, event_id) DO NOTHING`';
    expect(unguardedDoUpdateClauses(ledger)).toEqual([]);
  });
});
