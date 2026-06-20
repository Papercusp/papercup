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
 * and asserts each `DO UPDATE` clause carries a `fed_hlc`/`fed_ts` WHERE guard.
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

/**
 * For each REAL-SQL `DO UPDATE` in `src`, return the clauses (the SQL from the
 * `DO UPDATE` to the end of its `sql\`…\`` template) that LACK a fed_hlc/fed_ts
 * guard with a WHERE. An empty array = every overwrite is LWW-guarded.
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
    const clause = src.slice(start, close === -1 ? start + 1200 : close);
    const hasGuard = /\bWHERE\b/i.test(clause) && /\bfed_(hlc|ts)\b/.test(clause);
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
