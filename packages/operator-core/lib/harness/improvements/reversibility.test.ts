import { describe, it, expect } from 'vitest';
import {
  classifyReversibility,
  isAutoReversible,
  effectiveReversibility,
  IRREVERSIBLE_PATH_PATTERNS,
  IRREVERSIBLE_KEYWORDS,
  type Reversibility,
  type ReversibilityInput,
} from './reversibility';

const ALL_REVERSIBILITY: Reversibility[] = ['reversible', 'irreversible', 'unknown'];

function input(p: ReversibilityInput): ReversibilityInput {
  return { title: 'a thing', ...p };
}

describe('classifyReversibility — irreversible PATHS (the authoritative signal)', () => {
  const irreversiblePaths: Array<[string, string]> = [
    ['schema/data migrations', 'libs/papercusp/libs/db/sql/261-something.sql'],
    ['release machinery (operator-core)', 'packages/operator-core/lib/release/deploy-cli.ts'],
    ['release machinery (apps/operator)', 'apps/operator/lib/release/rollback.ts'],
    ['credential material', 'packages/operator-core/lib/credentials/store.ts'],
    ['auth material', 'apps/operator/lib/auth/session.ts'],
  ];
  it.each(irreversiblePaths)('a change touching %s → irreversible', (_label, path) => {
    const d = classifyReversibility(input({ paths: [path] }));
    expect(d.reversibility).toBe('irreversible');
    expect(d.hit).toBeTruthy();
  });

  it('a path wins over an otherwise-reversible-looking footprint', () => {
    const d = classifyReversibility(
      input({ paths: ['apps/operator/app/inbox/EmptyState.tsx', 'libs/papercusp/libs/db/sql/262-x.sql'] }),
    );
    expect(d.reversibility).toBe('irreversible');
    expect(d.hit).toContain('db/sql');
  });
});

describe('classifyReversibility — irreversible-effect KEYWORDS (the pre-paths proxy)', () => {
  it('a migration mention with no paths → irreversible', () => {
    const d = classifyReversibility(input({ title: 'migration 261 backfills the autonomy_policy table' }));
    expect(d.reversibility).toBe('irreversible');
    expect(d.hit).toBe('migration');
  });
  it('a deploy mention → irreversible', () => {
    expect(classifyReversibility(input({ title: 'deploy the staging operator' })).reversibility).toBe('irreversible');
  });
  it('a credential rotation in the body → irreversible', () => {
    const d = classifyReversibility(input({ title: 'token health', body: 'we should rotate credential weekly' }));
    expect(d.reversibility).toBe('irreversible');
  });
  it('destructive data verbs (drop table / purge / hard delete) → irreversible', () => {
    expect(classifyReversibility(input({ title: 'drop table legacy_runs' })).reversibility).toBe('irreversible');
    expect(classifyReversibility(input({ title: 'purge the orphaned dispatch rows' })).reversibility).toBe('irreversible');
    expect(classifyReversibility(input({ title: 'hard delete stale sessions' })).reversibility).toBe('irreversible');
  });
  it('keyword matching is case-insensitive', () => {
    expect(classifyReversibility(input({ title: 'DEPLOY the release' })).reversibility).toBe('irreversible');
  });
  it('a topic word without a destructive verb does NOT over-trip — a plain UI bug stays out of the keyword leg', () => {
    // "delete button" mentions delete but is not a "delete account"/"hard delete" effect.
    const d = classifyReversibility(input({ paths: ['apps/operator/app/x/DeleteButton.tsx'], title: 'the delete button needs a tooltip' }));
    expect(d.reversibility).toBe('reversible'); // has a clean repo footprint, no irreversible marker
  });
});

describe('classifyReversibility — positively reversible (a known repo footprint, nothing irreversible)', () => {
  it('an ordinary code/UI edit with paths → reversible (git-revertable)', () => {
    const d = classifyReversibility(input({ paths: ['apps/operator/app/inbox/EmptyState.tsx'] }));
    expect(d.reversibility).toBe('reversible');
    expect(d.hit).toBeUndefined();
    expect(d.reasons.join(' ')).toMatch(/git-revertable/);
  });
  it('a multi-file code edit, none irreversible → reversible', () => {
    const d = classifyReversibility(
      input({ paths: ['packages/operator-core/lib/issues-engineer.ts', 'packages/operator-core/lib/x.ts'] }),
    );
    expect(d.reversibility).toBe('reversible');
  });
});

describe('classifyReversibility — the fail-safe (P-012): no footprint, no marker → unknown', () => {
  it('a bare title with no paths and no irreversible marker → unknown', () => {
    const d = classifyReversibility(input({ title: 'inbox dedup misses rephrasings' }));
    expect(d.reversibility).toBe('unknown');
    expect(d.reasons.join(' ')).toMatch(/fail-safe/);
  });
  it('an empty input → unknown (never silently reversible)', () => {
    expect(classifyReversibility({}).reversibility).toBe('unknown');
  });
});

describe('isAutoReversible — the binary fail-safe collapse', () => {
  it('ONLY positively-reversible is auto-safe; irreversible AND unknown both fail', () => {
    expect(isAutoReversible('reversible')).toBe(true);
    expect(isAutoReversible('irreversible')).toBe(false);
    expect(isAutoReversible('unknown')).toBe(false);
  });
  it('exactly one of the three values is auto-safe (sweep)', () => {
    expect(ALL_REVERSIBILITY.filter(isAutoReversible)).toEqual(['reversible']);
  });
});

describe('effectiveReversibility — unknown collapses to irreversible', () => {
  it('reversible stays reversible; irreversible + unknown both read irreversible', () => {
    expect(effectiveReversibility('reversible')).toBe('reversible');
    expect(effectiveReversibility('irreversible')).toBe('irreversible');
    expect(effectiveReversibility('unknown')).toBe('irreversible');
  });
  it('effectiveReversibility agrees with isAutoReversible on every value', () => {
    for (const r of ALL_REVERSIBILITY) {
      expect(effectiveReversibility(r) === 'reversible').toBe(isAutoReversible(r));
    }
  });
});

describe('the irreversible vocabulary is non-empty and well-formed', () => {
  it('path patterns + keywords are present (a misedit that empties them is caught)', () => {
    expect(IRREVERSIBLE_PATH_PATTERNS.length).toBeGreaterThan(0);
    expect(IRREVERSIBLE_KEYWORDS.length).toBeGreaterThan(0);
    expect(IRREVERSIBLE_KEYWORDS.every((k) => k === k.toLowerCase())).toBe(true); // matched lower-cased
  });
});
