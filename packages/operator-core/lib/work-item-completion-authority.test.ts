import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  COMPLETION_AUTHORITY_TRANSITIONS,
  WORK_ITEM_COMPLETION_AUTHORITIES,
  authorityForCompletion,
  canTransition,
  countsTowardBurnDown,
  isLegacyClose,
  isSufficientEvidence,
  isWorkItemCompletionAuthority,
  transitionsFrom,
  type WorkItemCompletionAuthority,
} from './work-item-completion-authority';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
// 677 introduced the column and its CHECK (the value set lives there). 678 attempted a
// rename, was abandoned as impossible, and survives as comment-only documentation
// (D-009). Both are read so that editing either out of step with this module fails here.
const MIGRATION_VALUES = join(REPO_ROOT, 'libs/papercusp/libs/db/sql/677-work-item-authority-state.sql');
const MIGRATION_RENAME = join(
  REPO_ROOT,
  'libs/papercusp/libs/db/sql/678-rename-authority-to-completion-authority.sql',
);

describe('the authority state table', () => {
  it('only references declared authority values', () => {
    for (const t of COMPLETION_AUTHORITY_TRANSITIONS) {
      expect(isWorkItemCompletionAuthority(t.to), `bad \`to\`: ${t.to}`).toBe(true);
      if (t.from !== null) expect(isWorkItemCompletionAuthority(t.from), `bad \`from\`: ${t.from}`).toBe(true);
      expect(t.by.length, `edge ${t.from}→${t.to} permits no actor`).toBeGreaterThan(0);
      expect(t.when.trim().length, `edge ${t.from}→${t.to} has no condition`).toBeGreaterThan(0);
    }
  });

  it('declares each (from,to) edge exactly once', () => {
    const seen = COMPLETION_AUTHORITY_TRANSITIONS.map((t) => `${t.from}→${t.to}`);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('never transitions back to null — the legacy-close exemption must be unreachable', () => {
    // D-005 exempts terminal rows with a null authority from nagging and reclassification.
    // If any live code path could clear an authority back to null, that exemption would be
    // reachable by an agent wanting its under-evidenced close to stop nagging.
    for (const t of COMPLETION_AUTHORITY_TRANSITIONS) {
      expect(t.to as WorkItemCompletionAuthority | null).not.toBeNull();
    }
  });

  it('reaches every declared authority from a fresh close', () => {
    const reached = new Set<WorkItemCompletionAuthority>();
    let frontier: (WorkItemCompletionAuthority | null)[] = [null];
    while (frontier.length) {
      const next: WorkItemCompletionAuthority[] = [];
      for (const from of frontier) {
        for (const to of transitionsFrom(from)) {
          if (!reached.has(to)) {
            reached.add(to);
            next.push(to);
          }
        }
      }
      frontier = next;
    }
    expect([...reached].sort()).toEqual([...WORK_ITEM_COMPLETION_AUTHORITIES].sort());
  });

  it('keeps the deliberate non-edges absent', () => {
    // Each of these is a design choice documented on COMPLETION_AUTHORITY_TRANSITIONS, not an
    // oversight — so assert them, or a later edit will "helpfully" add them back.
    expect(canTransition('committed', 'pending_human')).toBe(false);
    expect(canTransition('pending_human', 'proposed')).toBe(false);
  });

  it('lets only the gate mint an authority from nothing', () => {
    for (const t of COMPLETION_AUTHORITY_TRANSITIONS.filter((e) => e.from === null)) {
      expect(t.by.some((a) => a === 'gate' || a === 'system')).toBe(true);
      expect(t.by).not.toContain('corroboration');
    }
  });

  it('never lets a system close land in `proposed`', () => {
    // `proposed` means "an agent owes evidence". A reaper owes nothing, and nagging one
    // is noise that teaches agents to skim the nag channel.
    for (const t of COMPLETION_AUTHORITY_TRANSITIONS.filter((e) => e.to === 'proposed')) {
      expect(t.by).not.toContain('system');
    }
  });

  it('reaches `validated` only by corroboration — the reserved-value honesty check', () => {
    // `validated` ships with no writer on purpose. If someone wires a gate edge into it,
    // this fails and forces the decision to be made explicitly rather than by drift.
    const into = COMPLETION_AUTHORITY_TRANSITIONS.filter((t) => t.to === 'validated');
    expect(into).toHaveLength(1);
    expect(into[0]!.from).toBe('committed');
    expect(into[0]!.by).toEqual(['corroboration']);
  });

  it('lets any settled claim be contradicted', () => {
    for (const settled of ['proposed', 'committed', 'validated'] as const) {
      expect(canTransition(settled, 'invalid')).toBe(true);
    }
  });

  it('gates transitions by actor', () => {
    expect(canTransition('pending_human', 'committed', 'owner')).toBe(true);
    expect(canTransition('pending_human', 'committed', 'gate')).toBe(false);
    expect(canTransition('committed', 'validated', 'gate')).toBe(false);
    expect(canTransition('committed', 'validated', 'corroboration')).toBe(true);
  });
});

describe('burn-down semantics', () => {
  it('counts the two authoritative values', () => {
    expect(countsTowardBurnDown('committed', true)).toBe(true);
    expect(countsTowardBurnDown('validated', true)).toBe(true);
  });

  it('excludes unsettled and contradicted claims', () => {
    expect(countsTowardBurnDown('proposed', true)).toBe(false);
    expect(countsTowardBurnDown('pending_human', true)).toBe(false);
    expect(countsTowardBurnDown('invalid', true)).toBe(false);
  });

  it('counts a legacy terminal close (D-005) — never retroactively invalidate history', () => {
    // ~9,600 rows were closed under the old contract. Flipping this line to `false`
    // deletes two thirds of completion history from every burn-down and leader brief.
    expect(countsTowardBurnDown(null, true)).toBe(true);
    expect(isLegacyClose(null, true)).toBe(true);
  });

  it('never counts a non-terminal row, whatever its authority', () => {
    for (const a of [null, ...WORK_ITEM_COMPLETION_AUTHORITIES]) {
      expect(countsTowardBurnDown(a, false)).toBe(false);
    }
    expect(isLegacyClose(null, false)).toBe(false);
  });
});

describe('the evidence minimum for `committed`', () => {
  it('requires verifiedHow AND a run/result', () => {
    expect(isSufficientEvidence({ verifiedHow: 'unit', testsRun: 'npm run test:affected' })).toBe(true);
    expect(isSufficientEvidence({ verifiedHow: 'integration', testResult: '9/9 green' })).toBe(true);
  });

  it('rejects a partial evidence object with no verifiedHow', () => {
    // P-002 measured 4.2% of evidence-bearing rows in exactly this shape. A presence
    // check ("is _completionEvidence set?") passes every one of them.
    expect(isSufficientEvidence({ testsRun: 'ran the suite', testResult: 'green' })).toBe(false);
  });

  it('rejects a bare label with nothing behind it', () => {
    expect(isSufficientEvidence({ verifiedHow: 'unit' })).toBe(false);
  });

  it('rejects change-descriptions that assert no check', () => {
    // filesChanged/addedTests say what changed; neither says anything was verified.
    expect(isSufficientEvidence({ verifiedHow: 'manual', filesChanged: ['a.ts'], addedTests: true })).toBe(false);
  });

  it('rejects absent, empty, and whitespace-only evidence', () => {
    expect(isSufficientEvidence(undefined)).toBe(false);
    expect(isSufficientEvidence(null)).toBe(false);
    expect(isSufficientEvidence({})).toBe(false);
    expect(isSufficientEvidence({ verifiedHow: 'unit', testsRun: '   ' })).toBe(false);
  });

  it('maps evidence to the authority a close lands in', () => {
    expect(authorityForCompletion({ verifiedHow: 'unit', testResult: '9/9 green' })).toBe('committed');
    expect(authorityForCompletion({ testResult: '9/9 green' })).toBe('proposed');
    expect(authorityForCompletion(undefined)).toBe('proposed');
  });
});

describe('schema/type drift guard', () => {
  it('keeps the TS union and the migration CHECK constraint in agreement', () => {
    // The whole point of D-004 is that a rule kept in one place and restated in another
    // drifts. This module and the CHECK constraint are two statements of one value set,
    // so assert they agree rather than trusting that a future edit updates both.
    const sql = readFileSync(MIGRATION_VALUES, 'utf8');
    const check = /CHECK \(authority IS NULL OR authority IN\s*\(([^)]*)\)/m.exec(sql);
    expect(check, 'migration 677 no longer declares the CHECK constraint').toBeTruthy();
    const inSql = [...check![1]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
    expect(inSql.sort()).toEqual([...WORK_ITEM_COMPLETION_AUTHORITIES].sort());
  });

  it('does not reintroduce the abandoned rename — the column is rename-proof (D-009)', () => {
    // 678 originally tried to rename this column to `completion_authority` and had to be
    // abandoned: harness_features_consolidated has ~2,485 dependent views, and renaming a
    // column a view exposes requires DROP + CREATE of that view (CREATE OR REPLACE can
    // only APPEND). The abandoned file is kept as comment-only documentation.
    //
    // This guards the specific way that lesson gets lost: someone reads D-009, agrees the
    // homograph is bad, and re-adds the DROP. A DROP VIEW on either consolidated view is
    // the thing that crash-loops the operator on boot, so fail here instead.
    const sql = readFileSync(MIGRATION_RENAME, 'utf8');
    expect(sql).not.toMatch(/RENAME COLUMN authority TO completion_authority/);
    expect(sql.replace(/--[^\n]*/g, '')).not.toMatch(
      /DROP\s+VIEW[\s\S]*?(harness_features_consolidated|engineer_issues)/i,
    );
  });
});
