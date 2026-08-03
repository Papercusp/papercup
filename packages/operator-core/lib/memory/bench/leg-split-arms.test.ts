/**
 * P-045 arm construction (context-injection-audit-2026-07-28 P-045 / D-049).
 *
 * The arms decide what the acceptance number MEANS, so the properties tested
 * here are the ones a wrong report would violate silently: the dose-0 null
 * control really is a null, the candidate arm really does carry a per-leg
 * split, and the injected identifiers really are bounded by the caps that
 * D-049's constraint 1 says are load-bearing.
 */
import { describe, expect, it } from 'vitest';

import type { CorpusEntry, GoldQuery } from '@papercusp/memory/bench';

import { LEXICAL_MAX_IDS, LEXICAL_MAX_PATHS, LEXICAL_MAX_SYMBOLS } from '../recall-query';
import {
  buildDilutionArm,
  buildInjectionArm,
  cleanArm,
  injectionCoverage,
  signalsFromEntry,
  DEFAULT_NOISE_PATHS,
} from './leg-split-arms';

const GOLD: GoldQuery[] = [
  { id: 'ei-1', class: 'exact-identifier', query: 'getHarnessAdminUrl resolve admin DSN', expected: ['ref_admin_url'] },
  { id: 'lg-1', class: 'lexical-gap', query: 'the copies keep ballooning because each run folds the last one in', expected: ['fb_backup'] },
  { id: 'hn-1', class: 'hard-negative', query: 'kubernetes ingress controller for the operator api', expected: [] },
];

const CORPUS: CorpusEntry[] = [
  {
    key: 'ref_admin_url',
    text: 'Never hardcode localhost:5432 — resolve via getHarnessAdminUrl() in packages/operator-core/lib/db/admin-url.ts. See WI-1234.',
  },
  {
    key: 'fb_backup',
    text: 'The kopia repo lives inside its own source; add backups to IGNORE_PATTERNS in apps/operator/lib/backup/policy.ts (assertSelfExclusionPolicy).',
  },
  { key: 'other_1', text: 'The staging operator on port 3170 runs from libs/papercusp/packages/harness/src/spawn.ts.' },
];

const byKey = new Map(CORPUS.map((e) => [e.key, e]));
const keys = CORPUS.map((e) => e.key);

describe('ARM A — cosine de-dilution', () => {
  it('dose 0 produces a byte-identical null control', () => {
    const { baseline, candidate } = buildDilutionArm(GOLD, { dose: 0 });
    baseline.queries.forEach((b, i) => {
      const c = candidate.queries[i];
      // Dose 0 injects no paths, so the ONLY difference left is the
      // dose-INDEPENDENT residue sweep WI-6857 added to the cosine leg: the
      // fixture's Grep returns '' so every derived text carries a `(no result)`
      // marker, and that marker no longer reaches the embedded query. Any
      // delta BEYOND that means the harness is wrong.
      expect(c.query).toBe(b.query.replace(/\(no result\)/g, '').replace(/\s+/g, ' ').trim());
      // No paths to strip ⇒ nothing for the lexical leg to keep that the
      // cosine leg lost, so the split degenerates to one query.
      expect(c.lexicalQuery === undefined || c.lexicalQuery === b.query).toBe(true);
    });
  });

  it('dilutes the baseline with real path tokens and strips them from the candidate cosine query', () => {
    const { baseline, candidate } = buildDilutionArm(GOLD, { dose: 2 });
    const b = baseline.queries[0];
    const c = candidate.queries[0];

    // The baseline is what mid-turn sends TODAY: prose plus path tokens.
    expect(b.query).toContain('getHarnessAdminUrl');
    expect(b.query).toContain(DEFAULT_NOISE_PATHS[0]);
    // The candidate's cosine query keeps the prose and loses the paths…
    expect(c.query).toContain('getHarnessAdminUrl');
    expect(c.query).not.toContain(DEFAULT_NOISE_PATHS[0]);
    // …while the lexical leg still sees the full derived text.
    expect(c.lexicalQuery).toBe(b.query);
    // Ids are preserved across the pair — a paired comparison joins on them.
    expect(candidate.queries.map((q) => q.id)).toEqual(baseline.queries.map((q) => q.id));
    expect(c.expected).toEqual(b.expected);
  });

  it('rotates the noise so dilution is not one fixed pair repeated', () => {
    const { baseline } = buildDilutionArm(GOLD, { dose: 1 });
    const first = baseline.queries.map((q) => q.query);
    expect(new Set(first.map((q) => DEFAULT_NOISE_PATHS.findIndex((p) => q.includes(p)))).size).toBeGreaterThan(1);
  });

  it('cleanArm is the untouched gold query', () => {
    const clean = cleanArm(GOLD);
    expect(clean.queries.map((q) => q.query)).toEqual(GOLD.map((q) => q.query));
    expect(clean.queries.every((q) => q.lexicalQuery === undefined)).toBe(true);
  });
});

describe('ARM B — lexical signal injection', () => {
  it('harvests identifiers from an entry through the production extractor', () => {
    const s = signalsFromEntry(CORPUS[0]);
    expect(s?.trajectory?.paths).toContain('packages/operator-core/lib/db/admin-url.ts');
    expect(s?.trajectory?.ids).toContain('WI-1234');
    expect(s?.trajectory?.symbols).toContain('getHarnessAdminUrl');
  });

  it('leaves the COSINE query untouched and only adds a lexical one', () => {
    const { baseline, candidate } = buildInjectionArm(GOLD, { mode: 'ontask', corpus: byKey, corpusKeys: keys });
    baseline.queries.forEach((b, i) => {
      // P-044's design: signals never enter the cosine query.
      expect(candidate.queries[i].query).toBe(b.query);
      expect(b.lexicalQuery).toBeUndefined();
    });
    const lex = candidate.queries[0].lexicalQuery ?? '';
    expect(lex.startsWith(GOLD[0].query)).toBe(true);
    expect(lex).toContain('WI-1234');
    // Paths enter as BASENAME STEMS, never whole paths (D-049 constraint 1).
    expect(lex).toContain('admin-url');
    expect(lex).not.toContain('packages/operator-core');
  });

  it('respects the recall-query caps — the lexical query cannot grow unbounded', () => {
    const fat: CorpusEntry = {
      key: 'fat',
      text: Array.from({ length: 12 }, (_, i) => `pkg/dir${i}/file${i}.ts WI-${1000 + i} camelCase${i}Name`).join(' '),
    };
    const { candidate } = buildInjectionArm([{ ...GOLD[0], expected: ['fat'] }], {
      mode: 'ontask',
      corpus: new Map([['fat', fat]]),
      corpusKeys: ['fat'],
    });
    const added = (candidate.queries[0].lexicalQuery ?? '').slice(GOLD[0].query.length).trim().split(/\s+/).filter(Boolean);
    expect(added.length).toBeLessThanOrEqual(LEXICAL_MAX_IDS + LEXICAL_MAX_PATHS + LEXICAL_MAX_SYMBOLS);
  });

  it('offtask never sources signals from a key the query expects', () => {
    const { candidate } = buildInjectionArm(GOLD, { mode: 'offtask', corpus: byKey, corpusKeys: keys });
    // ei-1 expects ref_admin_url, so its off-task signals must not name it.
    expect(candidate.queries[0].lexicalQuery ?? '').not.toContain('admin-url');
  });

  it('hard negatives stay in the run (they carry the only FP signal)', () => {
    const pair = buildInjectionArm(GOLD, { mode: 'ontask', corpus: byKey, corpusKeys: keys });
    expect(pair.candidate.queries).toHaveLength(GOLD.length);
    const hn = pair.candidate.queries.find((q) => q.id === 'hn-1');
    // No target ⇒ off-task source, but signals all the same: a real agent
    // always has a trajectory, including on a question nothing answers.
    expect(hn?.lexicalQuery).toBeDefined();
  });

  it('reports coverage rather than silently dropping signal-less queries', () => {
    const pair = buildInjectionArm(GOLD, { mode: 'ontask', corpus: new Map(), corpusKeys: [] });
    expect(injectionCoverage(pair)).toEqual({ withSignals: 0, total: GOLD.length });
    // Signal-less queries stay as exact ties instead of vanishing.
    expect(pair.candidate.queries).toHaveLength(GOLD.length);
  });
});
