/**
 * Guard: no production path may mint a work-item at status 'todo'.
 *
 * WHY THIS EXISTS (EI-21460610464031791). `claimFloorsWhereSql` defaults to
 * `states = ['open']` and matches it with a RAW `status = ANY(...)` predicate. There is
 * no alias fold at READ time, so `FEATURE_STATE_ALIASES` (todo -> open) — which only
 * runs on the validated agent write path — does NOT rescue a row inserted by raw SQL.
 * A row born 'todo' is therefore born PERMANENTLY UNCLAIMABLE: it is minted, it counts
 * as work in every census, and no self-select door will ever hand it to anyone.
 *
 * This failed silently and expensively. Two raw INSERTs bypassing `createWorkItem` were
 * writing 'todo': the plan-run minter in `harness/routines/plan-run-action.ts` stranded
 * 15 trigger- and heartbeat-minted rows between 2026-08-12 and 2026-08-25 (inbound Gmail
 * mail produced a work-item nothing ever executed) before it was rewritten onto canonical
 * promotion in 4b0d4cc344; `blueprint/blueprint-run-action.ts` was armed with the same
 * defect on its work-item mode. Nothing failed loudly in either case — the rows simply
 * accumulated.
 *
 * The canonical minter (`createWorkItem`) spells 'open' and carries its own comment
 * saying "writing 'todo' here would strand every new feature". This test extends that
 * single-site care to every raw INSERT, because the defect is invisible at the call site:
 * the INSERT succeeds, the row exists, and only a claim that never comes reveals it.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const LIB_ROOT = join(__dirname);
const TARGET_TABLE = 'INSERT INTO harness_shared.work_items';

/**
 * Rigs that deliberately seed throwaway rows and are NOT production dispatch paths.
 * SHRINK-ONLY: never add a production minter here — fix the minter instead. Removing an
 * entry (by migrating that rig to 'open') is always welcome.
 */
const RIG_ALLOWLIST: readonly string[] = [
  'gym/blueprint-cycle.ts',
  'gym/smoke.ts',
  'gym/runner-ports.ts',
  'external-bench/bench-harness-live.ts',
];

/**
 * Strip SQL line comments before looking for the status literal.
 *
 * This is load-bearing, not tidiness: the surrounding code documents this very bug in
 * prose, so a naive scan flags every comment that MENTIONS 'todo' and reports the fixed
 * files as broken. (Observed while writing this guard — the first version failed on the
 * fix's own explanatory comment.)
 */
export function stripSqlLineComments(sql: string): string {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
}

/** Does this source text contain a raw work_items INSERT whose status literal is 'todo'? */
export function writesTodoStatus(source: string): boolean {
  let from = source.indexOf(TARGET_TABLE);
  while (from !== -1) {
    // Bound the statement: whichever terminator comes first after the INSERT.
    const rest = source.slice(from, from + 2000);
    const endMarkers = ['DO NOTHING', 'RETURNING'];
    let end = rest.length;
    for (const marker of endMarkers) {
      const at = rest.indexOf(marker);
      if (at !== -1 && at < end) end = at + marker.length;
    }
    if (stripSqlLineComments(rest.slice(0, end)).includes(`'todo'`)) return true;
    from = source.indexOf(TARGET_TABLE, from + 1);
  }
  return false;
}

function collectSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectSourceFiles(full, acc);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      acc.push(full);
    }
  }
  return acc;
}

describe('work-item minters are born claimable', () => {
  // ── Controls. These prove the detector can actually FAIL, permanently and without
  // ── mutating the shared tree (a copy-out/restore probe races git-sync's sweep).
  describe('detector controls', () => {
    const BAD = `
      await sql.unsafe(\`INSERT INTO harness_shared.work_items (
        harness_slug, feature_id, status, attempts
      ) VALUES ($1, $2, 'todo', 0)
      ON CONFLICT (harness_slug, feature_id) DO NOTHING\`);
    `;
    const GOOD = `
      await sql.unsafe(\`INSERT INTO harness_shared.work_items (
        harness_slug, feature_id, status, attempts
      ) VALUES ($1, $2, 'open', 0)
      ON CONFLICT (harness_slug, feature_id) DO NOTHING\`);
    `;
    const COMMENT_ONLY = `
      await sql.unsafe(\`INSERT INTO harness_shared.work_items (
        harness_slug, feature_id, status, attempts
      ) VALUES (
        -- 'open' is the unified claimable token; this wrote 'todo' until EI-21460610464031791
        $1, $2, 'open', 0)
      ON CONFLICT (harness_slug, feature_id) DO NOTHING\`);
    `;

    it('CATCHES a raw INSERT that writes the unclaimable status', () => {
      expect(writesTodoStatus(BAD)).toBe(true);
    });

    it('PASSES a raw INSERT that writes the claimable token', () => {
      expect(writesTodoStatus(GOOD)).toBe(false);
    });

    it('does not flag a comment that merely MENTIONS the unclaimable status', () => {
      // Calibration for the exact false positive this guard hit while being written.
      expect(writesTodoStatus(COMMENT_ONLY)).toBe(false);
    });
  });

  it('no production path mints a work-item at the unclaimable status', () => {
    const offenders = collectSourceFiles(LIB_ROOT)
      .filter((file) => {
        const source = readFileSync(file, 'utf8');
        return source.includes(TARGET_TABLE) && writesTodoStatus(source);
      })
      .map((file) => file.slice(LIB_ROOT.length + 1))
      .filter((rel) => !RIG_ALLOWLIST.some((allowed) => rel.endsWith(allowed)));

    expect(
      offenders,
      `These minters write status 'todo', which NO claim floor admits (claimFloorsWhereSql ` +
        `defaults to ['open'] and does not alias-fold at read time). Rows they create are ` +
        `born permanently unclaimable — minted, counted, never dispatched. Write 'open' ` +
        `instead, or route through createWorkItem, which already does.`,
    ).toEqual([]);
  });
});
