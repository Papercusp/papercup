/**
 * Tests for the substitution matcher (plan
 * `bash-to-tool-substitution-2026-07-26`, P-015).
 *
 * The matcher is what turns a registry row into something an agent actually
 * sees, so its failure modes are the ones that matter operationally: a rule
 * that silently never fires (enforcement that does nothing), a rule that fires
 * on the wrong thing (an advisory that teaches a falsehood), and a rule that
 * hangs or throws (a wedged gate, fleet-wide). There is a test below for each.
 */

import { describe, expect, it } from 'vitest';

import { auditPair, meetsAuditFloor } from './equivalence';
import {
  atomsOf,
  compileRegistryPattern,
  matchAtomsToSubstitutions,
  matchCommandToSubstitutions,
  normalizeRegistryFlags,
  strongestTier,
  LAUNCH_SITE_ADVISORY_INTENTS,
  MAX_MATCHABLE_ATOM_LENGTH,
  type SubstitutionRow,
} from './match';
import { loadPairFixtures } from './corpus';
import { BASH_GATE_PAIRS } from './pairs';
import { unsafeDependencyInstall } from './pairs/dependency-install';
import { fileLockCoordinationDomain } from '../agent-tools/locks/coordination-domain';

/** A registry row with sane defaults, overridable per test. */
function row(over: Partial<SubstitutionRow> = {}): SubstitutionRow {
  return {
    intentLabel: 'file-range-read',
    bashPattern: String.raw`sed\s+-n\s+['"]?\s*\d+\s*,\s*\d+\s*p['"]?\s+\S`,
    bashPatternFlags: '',
    toolName: 'capability:read',
    tier: 'advise',
    advisoryText: 'use capability:read',
    equivalenceVerdict: 'equivalent',
    ...over,
  };
}

describe('matchCommandToSubstitutions — per-atom semantics', () => {
  it('matches a pattern behind a leading `cd`, which whole-line matching would miss', () => {
    const hits = matchCommandToSubstitutions("cd /repo && sed -n '1,40p' a.ts", [row()]);
    expect(hits).toHaveLength(1);
    expect(hits[0].atom).toBe("sed -n '1,40p' a.ts");
  });

  it('reports the ATOM that matched, not the whole command line', () => {
    // What an `observe` tier logs must be the thing the pattern claimed, or the
    // observation window (P-020) reviews evidence it cannot act on.
    //
    // The fixture used to end `| wc -l`. That pipe was incidental to what this
    // test is about, and D-045 now withholds a capability:read advisory whose
    // stdout feeds a pipe — so the piped form returns no hit at all and could no
    // longer exercise atom reporting. Kept multi-atom via `;` to preserve the
    // actual subject. (That a casual fixture reached for a piped read is itself
    // a small sign of how ordinary the form is.)
    const hits = matchCommandToSubstitutions("ls -la; sed -n '5,9p' b.ts", [row()]);
    expect(hits[0].atom).toBe("sed -n '5,9p' b.ts");
  });

  it('emits ONE match per row even when several atoms match it', () => {
    const hits = matchCommandToSubstitutions("sed -n '1,2p' a.ts && sed -n '3,4p' b.ts", [row()]);
    expect(hits).toHaveLength(1);
  });

  it('returns nothing for a command no row claims', () => {
    expect(matchCommandToSubstitutions('npm run build', [row()])).toEqual([]);
  });

  it('returns nothing for an empty command or an empty registry', () => {
    expect(matchCommandToSubstitutions('   ', [row()])).toEqual([]);
    expect(matchCommandToSubstitutions("sed -n '1,2p' a.ts", [])).toEqual([]);
  });
});

describe('matchCommandToSubstitutions — cwd-aware shared-tree policy (EI-204040)', () => {
  const dependencyRow = () =>
    row({
      intentLabel: unsafeDependencyInstall.intentLabel,
      bashPattern: unsafeDependencyInstall.bashPattern.source,
      bashPatternFlags: unsafeDependencyInstall.bashPattern.flags,
      toolName: unsafeDependencyInstall.toolName,
      tier: 'deny',
      advisoryText: unsafeDependencyInstall.advisoryText,
      equivalenceVerdict: unsafeDependencyInstall.expectedVerdict,
    });
  const canonicalTree = fileLockCoordinationDomain();

  it('keeps the historical deny when the caller supplies no cwd context', () => {
    expect(matchCommandToSubstitutions('npm install', [dependencyRow()])).toHaveLength(1);
  });

  it('denies a bare install in the file-lock coordination tree', () => {
    expect(matchCommandToSubstitutions('npm install', [dependencyRow()], { cwd: canonicalTree })).toHaveLength(1);
  });

  it('does not claim a bare install whose cwd is an independent tree', () => {
    expect(matchCommandToSubstitutions('npm install', [dependencyRow()], { cwd: '/tmp/wi204040-scratch' })).toEqual([]);
  });

  it('uses a leading literal cd to exempt a scratch tree even when the outer cwd is canonical', () => {
    const command = `cd /tmp/wi204040-scratch && npm install`;
    expect(matchCommandToSubstitutions(command, [dependencyRow()], { cwd: canonicalTree })).toEqual([]);
  });

  it('uses a leading literal cd to retain the deny when it enters the canonical tree', () => {
    const command = `cd ${canonicalTree} && npm install`;
    expect(matchCommandToSubstitutions(command, [dependencyRow()], { cwd: '/tmp/wi204040-scratch' })).toHaveLength(1);
  });
});

/**
 * D-045 — guidance fires only where the tool is a FULLY EQUIVALENT substitute for
 * what the agent actually wrote (owner ruling, 2026-08-18).
 *
 * The case that produced the rule: `capability:read` returns a numbered, headed,
 * paged rendering, so it answers `cat FILE` faithfully but cannot feed the next
 * stage of `cat FILE | grep X`. A live `deny` rollout blocked exactly those
 * commands; the advice was wrong there even at `advise`.
 */
describe('matchCommandToSubstitutions — advice is withheld where the tool is not equivalent', () => {
  const catRow = () =>
    row({ intentLabel: 'file-whole-read', bashPattern: String.raw`cat\s+\S+$`, toolName: 'capability:read' });

  it('advises on a whole-command read', () => {
    expect(matchCommandToSubstitutions('cat package.json', [catRow()])).toHaveLength(1);
  });

  it('withholds the advisory when the read feeds a pipe', () => {
    expect(matchCommandToSubstitutions('cat package.json | grep name', [catRow()])).toHaveLength(0);
    expect(matchCommandToSubstitutions('cat package.json | head -3 | wc -l', [catRow()])).toHaveLength(0);
  });

  it('still advises the LAST stage of a pipeline, whose own stdout is free', () => {
    // The rule is about an atom's stdout, not about "appears in a pipeline". A
    // terminal stage hands its output to the agent, exactly like a bare command,
    // so suppressing it would withhold correct advice.
    const hits = matchCommandToSubstitutions('grep -rn x . | cat summary.txt', [catRow()]);
    expect(hits).toHaveLength(1);
  });

  it('does NOT suppress a tool that subsumes the whole pipeline', () => {
    // The counter-case that makes this a rule rather than a blanket ban:
    // testing:run returns failing tests structurally, so it replaces the `tail`
    // too. Suppressing here would withhold good advice.
    const testsRow = row({
      intentLabel: 'run-test-files',
      bashPattern: String.raw`npm\s+run\s+test:file`,
      toolName: 'testing:run',
    });
    const hits = matchCommandToSubstitutions('npm run test:file -- a.test.ts 2>&1 | tail -60', [testsRow]);
    expect(hits).toHaveLength(1);
  });

  it('keeps COUNTING unaffected — a suppressed advisory is still a fire', () => {
    // Telemetry answers "how much of this intent happened", which is exactly the
    // denominator for judging whether the guidance is working. Letting the
    // suppression leak into counting would make the metric measure the rule
    // instead of the behaviour.
    const atoms = atomsOf('cat package.json | grep name');
    expect(matchAtomsToSubstitutions(atoms, [catRow()])).toHaveLength(1);
  });
});

describe('matchCommandToSubstitutions — safety', () => {
  it('never throws on a malformed pattern; that row simply does not match', () => {
    const bad = row({ bashPattern: '([unclosed' });
    expect(() => matchCommandToSubstitutions("sed -n '1,2p' a.ts", [bad])).not.toThrow();
    expect(matchCommandToSubstitutions("sed -n '1,2p' a.ts", [bad])).toEqual([]);
  });

  it('skips `not-a-substitute` rows entirely (D-007)', () => {
    // These record a tool that answers a DIFFERENT question. Surfacing one as
    // an advisory would tell an agent to stop doing the correct thing.
    const hits = matchCommandToSubstitutions("sed -n '1,40p' a.ts", [
      row({ equivalenceVerdict: 'not-a-substitute' }),
    ]);
    expect(hits).toEqual([]);
  });

  /**
   * WI-2145718 / D-069(b). `equivalenceVerdict` was doing two jobs — a VERDICT
   * about tool equivalence AND the show/suppress switch for the row's prose —
   * so a row saying "no tool replaces this" could never carry advice. These pin
   * the narrow opt-in that separates them, and (just as importantly) that the
   * separation did not leak into the counting path or re-open D-007.
   */
  describe('launch-site advisory opt-in', () => {
    const launchSiteRow = () =>
      row({
        intentLabel: 'host-job-liveness-query',
        bashPattern: String.raw`^(?:ps|pgrep)(?=\s|$)`,
        toolName: 'dev:processes',
        tier: 'observe',
        advisoryText: 'the fix is at the LAUNCH site: capability:bash { run_in_background: true }',
        equivalenceVerdict: 'not-a-substitute',
      });

    it('delivers an opted-in row’s prose that the D-007 skip used to swallow', () => {
      const hits = matchCommandToSubstitutions('ps -p 4242', [launchSiteRow()]);
      expect(hits).toHaveLength(1);
      expect(hits[0].advisoryText).toContain('LAUNCH site');
    });

    it('ranks it `advise` so the gate renders it — its STORED tier stays observe', () => {
      // The hook prints only at tier advise/deny, and migration 665's
      // tier_requires_equivalence CHECK pins this row's stored tier at observe.
      // The rank is derived at match time; enforcement still needs equivalence.
      const stored = launchSiteRow();
      expect(stored.tier).toBe('observe');
      const hits = matchCommandToSubstitutions('ps -p 4242', [stored]);
      expect(strongestTier(hits)).toBe('advise');
    });

    it('stays OUT of the counting path, so documented negatives never re-enter the demand metric', () => {
      // usage-rollup / census / report call this with no options — the default
      // is what protects the metric, so assert the default, not the option.
      expect(matchAtomsToSubstitutions(['ps -p 4242'], [launchSiteRow()])).toEqual([]);
      expect(
        matchAtomsToSubstitutions(['ps -p 4242'], [launchSiteRow()], { includeLaunchSiteAdvisories: true }),
      ).toHaveLength(1);
    });

    it('does NOT lift the skip for other not-a-substitute rows (D-007 intact)', () => {
      // The whole point of a per-row opt-in: a documented negative that is not a
      // member stays silent even on the advisory path.
      const documentedNegative = row({
        intentLabel: 'recursive-text-search',
        equivalenceVerdict: 'not-a-substitute',
      });
      expect(LAUNCH_SITE_ADVISORY_INTENTS.has('recursive-text-search')).toBe(false);
      expect(matchCommandToSubstitutions("sed -n '1,40p' a.ts", [documentedNegative])).toEqual([]);
    });

    it('names only intents that a real pair still declares not-a-substitute, with prose to deliver', () => {
      // Anti-rot: if a pair is renamed, deleted, or re-verdicted to `equivalent`,
      // the opt-in silently becomes either dead or redundant. Fail instead.
      expect(LAUNCH_SITE_ADVISORY_INTENTS.size).toBeGreaterThan(0);
      for (const intent of LAUNCH_SITE_ADVISORY_INTENTS) {
        const pair = BASH_GATE_PAIRS.find((p) => p.intentLabel === intent);
        expect(pair, `no registry pair declares intentLabel ${intent}`).toBeDefined();
        expect(pair!.expectedVerdict).toBe('not-a-substitute');
        expect(pair!.advisoryText.trim().length).toBeGreaterThan(0);
      }
    });
  });

  it('does not run patterns against atoms past the length cap', () => {
    const huge = `sed -n '1,2p' ${'a'.repeat(MAX_MATCHABLE_ATOM_LENGTH + 10)}`;
    expect(matchCommandToSubstitutions(huge, [row()])).toEqual([]);
  });

  it('is stable across repeated calls even if a row carries a stateful flag', () => {
    // A `g`/`y` regex advances lastIndex between .test() calls, so the same
    // command would match, then miss, then match — an advisory firing every
    // other time with no reproducible pattern. Migration 667 forbids storing
    // one; the matcher strips it anyway.
    const stateful = row({ bashPatternFlags: 'g' });
    const results = [1, 2, 3, 4].map(
      () => matchCommandToSubstitutions("sed -n '1,40p' a.ts", [stateful]).length,
    );
    expect(results).toEqual([1, 1, 1, 1]);
  });
});

describe('registry pattern compilation', () => {
  it('honours the stored flags — the WI-5998 regression', () => {
    // The registry used to store `bashPattern.source` alone, so a consumer
    // recompiled a CASE-SENSITIVE regex while the verdict behind the row had
    // been earned with `i`. That made `operator-db-select` — the best-adopted
    // pair in the audit, and the row Phase 5 measures — a silent no-op against
    // the overwhelmingly common uppercase form.
    const src = String.raw`^psql\s+[^\n]*-c\s+["']?\s*select\b`;
    const upper = `psql postgresql://localhost/papercusp -c "SELECT count(*) FROM t"`;

    expect(compileRegistryPattern(src, '')!.test(upper)).toBe(false);
    expect(compileRegistryPattern(src, 'i')!.test(upper)).toBe(true);

    const hits = matchCommandToSubstitutions(upper, [
      row({ intentLabel: 'operator-db-select', bashPattern: src, bashPatternFlags: 'i' }),
    ]);
    expect(hits).toHaveLength(1);
  });

  it('returns null rather than throwing for a malformed pattern', () => {
    expect(compileRegistryPattern('([unclosed')).toBeNull();
  });

  it('strips stateful flags but keeps semantic ones', () => {
    expect(normalizeRegistryFlags('gi')).toBe('i');
    expect(normalizeRegistryFlags('imsu')).toBe('imsu');
    expect(normalizeRegistryFlags('gy')).toBe('');
    expect(normalizeRegistryFlags()).toBe('');
  });

  it('normalised flags always satisfy migration 667\'s CHECK', () => {
    // The DB accepts `^i?m?s?u?$` — alphabet, no repeats, canonical order.
    // `RegExp.prototype.flags` is spec'd to emit in that order, so anything
    // read off a real regex passes; this asserts the normaliser preserves it.
    for (const pair of BASH_GATE_PAIRS) {
      const stored = normalizeRegistryFlags(pair.bashPattern.flags);
      expect(stored, `${pair.id} flags "${stored}"`).toMatch(/^i?m?s?u?$/);
    }
  });
});

describe('every seeded pair survives the registry round-trip', () => {
  // The anti-rot latch for enforcement, mirroring equivalence.test.ts's latch
  // for verdicts: a pair is audited as a RegExp object but enforced as two
  // database columns, and this asserts those are the same regex. Without it,
  // widening a pair's flags silently changes what enforcement matches while
  // every existing test stays green.
  const fixtures = loadPairFixtures(BASH_GATE_PAIRS);

  for (const { pair, fixture } of fixtures) {
    it(`${pair.id} matches identically before and after storage`, () => {
      // Projected straight off the pair rather than through `auditPair`: these
      // two fields ARE what the seeder stores, the audit only echoes them, and
      // routing the round-trip check through a verdict made this property
      // untestable for a pair that is enforced without one (see below).
      const stored = compileRegistryPattern(
        pair.bashPattern.source,
        normalizeRegistryFlags(pair.bashPattern.flags),
      );
      expect(stored, `${pair.id} stored pattern failed to compile`).not.toBeNull();

      const asAudited = compileRegistryPattern(pair.bashPattern.source, pair.bashPattern.flags)!;
      for (const entry of fixture.sample) {
        expect(stored!.test(entry.atom), `${pair.id} diverged on: ${entry.atom}`).toBe(
          asAudited.test(entry.atom),
        );
      }
    });

    it(`${pair.id} claims exactly what its verdict entitles it to through the matcher`, () => {
      // The verdict's sample size is the evidence the registry cites. If the
      // matcher claims fewer atoms than the audit did, the row's `sample_size`
      // overstates what enforcement actually covers.
      //
      // A `not-a-substitute` row inverts the invariant: the matcher drops those
      // unconditionally (D-007), because the tool answers a different question
      // and an advisory would tell the agent to stop doing the right thing. So
      // for those the sample must claim ZERO — that is the assertion proving the
      // negative row is inert, not merely unpromoted.
      // A pair below the audit floor has no verdict to be entitled BY, but it can
      // still be enforced on D-003's authority — so the invariant becomes the
      // simpler one: the stored row claims exactly what its pattern matches.
      // Asserting nothing here would leave the hardest-gated row unchecked.
      const verdict = meetsAuditFloor(fixture.sample.length, fixture)
        ? auditPair(pair, fixture.sample, fixture).verdict
        : pair.expectedVerdict;
      const registryRow = row({
        intentLabel: pair.intentLabel,
        bashPattern: pair.bashPattern.source,
        bashPatternFlags: normalizeRegistryFlags(pair.bashPattern.flags),
        toolName: pair.toolName,
        equivalenceVerdict: verdict,
      });
      const claimed = fixture.sample.filter(
        (entry) => matchCommandToSubstitutions(entry.atom, [registryRow]).length === 1,
      );
      // WI-2145718 / D-069(b): ONE class of negative row is no longer inert —
      // a member of LAUNCH_SITE_ADVISORY_INTENTS keeps the `not-a-substitute`
      // verdict (no tool replaces the command) but deliberately delivers its
      // PROSE, so it claims its whole audited sample exactly like an equivalent
      // row. The zero-claim inversion above still holds for every other negative
      // row, which is what makes the opt-in per-row rather than a blanket lift.
      const optedIn = LAUNCH_SITE_ADVISORY_INTENTS.has(pair.intentLabel);
      const expected = verdict === 'not-a-substitute' && !optedIn ? 0 : fixture.sample.length;
      expect(claimed).toHaveLength(expected);
    });
  }
});

describe('matchAtomsToSubstitutions — the COUNTING grain (P-002)', () => {
  it('returns EVERY matching atom, where the advisory path returns one', () => {
    // The distinction the whole metric rests on: three reads are three reads to
    // a counter, but one sentence to an agent.
    const command = "sed -n '1,5p' a.ts && sed -n '6,9p' b.ts && sed -n '1,2p' c.ts";
    expect(matchAtomsToSubstitutions(atomsOf(command), [row()])).toHaveLength(3);
    expect(matchCommandToSubstitutions(command, [row()])).toHaveLength(1);
  });

  it('skips not-a-substitute rows, like the advisory path (D-007)', () => {
    const atoms = atomsOf("sed -n '1,5p' a.ts");
    expect(matchAtomsToSubstitutions(atoms, [row({ equivalenceVerdict: 'not-a-substitute' })])).toEqual([]);
  });

  it('never throws on a malformed pattern — a bad row costs a count, not the ingest', () => {
    const atoms = atomsOf("sed -n '1,5p' a.ts");
    expect(matchAtomsToSubstitutions(atoms, [row({ bashPattern: '([unclosed' })])).toEqual([]);
  });

  it('is empty for no atoms or no rows', () => {
    expect(matchAtomsToSubstitutions([], [row()])).toEqual([]);
    expect(matchAtomsToSubstitutions(atomsOf('ls'), [])).toEqual([]);
  });

  it('counts the same atom once per DISTINCT intent it matches, not once overall', () => {
    const atoms = atomsOf("psql -d papercusp -c 'select 1'");
    const hits = matchAtomsToSubstitutions(atoms, [
      row({ intentLabel: 'operator-db-select', bashPattern: String.raw`^psql\b` }),
      row({ intentLabel: 'operator-db-any', bashPattern: String.raw`^psql\s+-d` }),
    ]);
    expect(hits.map((h) => h.intentLabel).sort()).toEqual(['operator-db-any', 'operator-db-select']);
  });
});

describe('atomsOf', () => {
  it('applies the same length cap the advisory path uses', () => {
    const long = `sed -n '1,2p' ${'x'.repeat(MAX_MATCHABLE_ATOM_LENGTH)}`;
    expect(atomsOf(long)).toEqual([]);
  });

  it('is empty for a blank command', () => {
    expect(atomsOf('   ')).toEqual([]);
  });
});

describe('strongestTier', () => {
  it('returns null when nothing matched', () => {
    expect(strongestTier([])).toBeNull();
  });

  it('lets the strongest tier among matches decide', () => {
    const hits = matchCommandToSubstitutions("sed -n '1,2p' a.ts && psql -c 'select 1'", [
      row({ intentLabel: 'file-range-read', tier: 'observe' }),
      row({
        intentLabel: 'operator-db-select',
        bashPattern: String.raw`^psql\b`,
        tier: 'advise',
      }),
    ]);
    expect(hits).toHaveLength(2);
    expect(strongestTier(hits)).toBe('advise');
  });
});
