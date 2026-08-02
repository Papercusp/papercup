/**
 * P-047 arm construction (context-injection-audit-2026-07-28 P-047 / D-052).
 *
 * The arms decide what the acceptance number MEANS, so what is tested here is
 * what a wrong report would violate SILENTLY: that the null control really is a
 * null, that "cosine leg" and "lexical leg" arms genuinely isolate one leg
 * rather than quietly feeding both, that off-task prose never leaks the target
 * entry, and that the dose sweep stays under the production clamp so it is
 * measuring prose length rather than truncation.
 */
import { describe, expect, it } from 'vitest';

import type { CorpusEntry, GoldQuery } from '@papercusp/memory/bench';

import {
  buildAgentProseArm,
  buildProseNullControl,
  composeProseQuery,
  offTaskProse,
  onTaskProse,
  proseCoverage,
  PRODUCTION_QUERY_CLAMP,
} from './agent-prose-arms';

const GOLD: GoldQuery[] = [
  {
    id: 'ei-1',
    class: 'exact-identifier',
    query: 'getHarnessAdminUrl resolve admin DSN',
    expected: ['ref_admin_url'],
  },
  {
    id: 'lg-1',
    class: 'lexical-gap',
    query: 'the copies keep ballooning because each run folds the last one in',
    expected: ['fb_backup'],
  },
  { id: 'hn-1', class: 'hard-negative', query: 'kubernetes ingress controller for the operator api', expected: [] },
];

const CORPUS: CorpusEntry[] = [
  {
    key: 'ref_admin_url',
    text: 'Never hardcode localhost:5432 — resolve via getHarnessAdminUrl() in packages/operator-core/lib/db/admin-url.ts.',
    description: 'Resolve the admin DSN through getHarnessAdminUrl(), never a hardcoded port',
  },
  {
    key: 'fb_backup',
    text: 'The kopia repo lives inside its own source; add backups to IGNORE_PATTERNS in apps/operator/lib/backup/policy.ts.',
    description: 'Kopia repo is inside its own snapshot source, so backups must be ignored',
  },
  {
    key: 'other_1',
    text: 'The staging operator on port 3170 runs from libs/papercusp/packages/harness/src/spawn.ts and must be restarted through dev:restart rather than systemctl, because a raw restart reaps every headless child in the service cgroup.',
    description: 'Restart :3170 via dev:restart, never systemctl',
  },
];

const byKey = new Map(CORPUS.map((e) => [e.key, e]));
const keys = CORPUS.map((e) => e.key);
const base = { corpus: byKey, corpusKeys: keys };

describe('the null control', () => {
  it('changes no query text while still setting both legs explicitly', () => {
    const { baseline, candidate } = buildProseNullControl(GOLD);
    baseline.queries.forEach((b, i) => {
      const c = candidate.queries[i];
      expect(c.query).toBe(b.query);
      // The point of the control: `lexicalQuery` IS set, so it exercises the
      // leg-isolation mechanism instead of merely re-running the baseline.
      expect(c.lexicalQuery).toBe(b.query);
    });
  });

  it('carries a label distinct from the baseline so it is genuinely re-run', () => {
    // A shared label would be served from the CLI's run cache, and a cached
    // null control returns exactly zero by construction — proving nothing.
    const { baseline, candidate } = buildProseNullControl(GOLD);
    expect(candidate.label).not.toBe(baseline.label);
  });
});

describe('leg isolation', () => {
  it('cosine arms put prose in the embedded query and hold the lexical leg at the user text', () => {
    const { baseline, candidate } = buildAgentProseArm(GOLD, { ...base, mode: 'ontask', leg: 'cosine' });
    candidate.queries.forEach((c, i) => {
      const b = baseline.queries[i];
      expect(c.query.startsWith(b.query)).toBe(true);
      expect(c.query.length).toBeGreaterThan(b.query.length);
      expect(c.lexicalQuery).toBe(b.query);
    });
  });

  it('lexical arms do the exact opposite', () => {
    const { baseline, candidate } = buildAgentProseArm(GOLD, { ...base, mode: 'ontask', leg: 'lexical' });
    candidate.queries.forEach((c, i) => {
      const b = baseline.queries[i];
      expect(c.query).toBe(b.query);
      expect(c.lexicalQuery?.startsWith(b.query)).toBe(true);
      expect(c.lexicalQuery!.length).toBeGreaterThan(b.query.length);
    });
  });

  it('never leaves a leg unset — an unset lexicalQuery silently feeds prose to BOTH legs', () => {
    for (const leg of ['cosine', 'lexical', 'both'] as const) {
      const { candidate } = buildAgentProseArm(GOLD, { ...base, mode: 'ontask', leg });
      candidate.queries.forEach((c) => expect(c.lexicalQuery).toBeDefined());
    }
  });

  it('the both-legs arm sends one identical composed string to each leg', () => {
    const { candidate } = buildAgentProseArm(GOLD, { ...base, mode: 'offtask', leg: 'both', chars: 200 });
    candidate.queries.forEach((c) => expect(c.lexicalQuery).toBe(c.query));
  });
});

describe('the stimulus', () => {
  it('on-task prose is the target entry description, not its indexed body', () => {
    // `text` is what seeding indexes; injecting it would paste the stored bytes
    // into the query. The description is a separately authored gloss.
    const { candidate } = buildAgentProseArm(GOLD, { ...base, mode: 'ontask', leg: 'cosine' });
    const target = byKey.get('ref_admin_url')!;
    expect(candidate.queries[0].query).toContain(target.description!);
    expect(candidate.queries[0].query).not.toContain(target.text);
  });

  it('off-task prose never comes from a key the query expects', () => {
    const { candidate } = buildAgentProseArm(GOLD, { ...base, mode: 'offtask', leg: 'cosine', chars: 500 });
    GOLD.forEach((q, i) => {
      for (const key of q.expected) {
        const expectedEntry = byKey.get(key)!;
        expect(candidate.queries[i].query).not.toContain(expectedEntry.text);
        expect(candidate.queries[i].query).not.toContain(expectedEntry.description!);
      }
    });
  });

  it('hard negatives take the off-task source even in on-task mode', () => {
    // They have no target, so there is no on-task prose to give them. Dropping
    // them instead would remove the only class that can show prose ADMITTING
    // noise, which is half of what this arm is for.
    const on = buildAgentProseArm(GOLD, { ...base, mode: 'ontask', leg: 'cosine' });
    const hn = on.candidate.queries[2];
    expect(hn.query).not.toBe(GOLD[2].query);
    expect(hn.query.length).toBeGreaterThan(GOLD[2].query.length);
  });

  it('the off-task dose bounds the prose and truncates on a word boundary', () => {
    const long = byKey.get('other_1')!;
    for (const chars of [40, 120, 200]) {
      const prose = offTaskProse(long, chars);
      expect(prose.length).toBeLessThanOrEqual(chars);
      // A half-word tail is a token the embedder never sees in real text.
      expect(long.text.startsWith(prose)).toBe(true);
      expect(prose.endsWith(' ')).toBe(false);
    }
  });

  it('a zero dose yields no prose at all', () => {
    expect(offTaskProse(byKey.get('other_1')!, 0)).toBe('');
    expect(composeProseQuery('user text', '')).toBe('user text');
  });

  it('keeps the user text FIRST, as lexicalQueryText does', () => {
    // Ordering is load-bearing on the lexical leg: `lexicalTokens` keeps the
    // HEAD of the token list, so prose in front would evict the user's words.
    expect(composeProseQuery('user words', 'agent narration')).toBe('user words agent narration');
    expect(onTaskProse(byKey.get('fb_backup')!)).toBe(byKey.get('fb_backup')!.description);
  });
});

describe('coverage reporting', () => {
  it('counts the queries that actually received prose', () => {
    const pair = buildAgentProseArm(GOLD, { ...base, mode: 'offtask', leg: 'cosine', chars: 300 });
    const cov = proseCoverage(pair, 'cosine');
    expect(cov.total).toBe(GOLD.length);
    expect(cov.withProse).toBe(GOLD.length);
    expect(cov.medianQueryChars).toBeGreaterThan(0);
  });

  it('flags a dose that would be truncated by the production clamp', () => {
    const under = proseCoverage(
      buildAgentProseArm(GOLD, { ...base, mode: 'offtask', leg: 'cosine', chars: 200 }),
      'cosine',
    );
    expect(under.overProductionClamp).toBe(0);
    expect(under.maxQueryChars).toBeLessThan(PRODUCTION_QUERY_CLAMP);

    // A corpus entry long enough to push the composed query over the clamp
    // must be REPORTED, because such a row measures truncation, not prose.
    const bulky = new Map(byKey);
    bulky.set('other_1', { key: 'other_1', text: 'x '.repeat(PRODUCTION_QUERY_CLAMP) });
    const over = proseCoverage(
      buildAgentProseArm(GOLD, {
        corpus: bulky,
        corpusKeys: keys,
        mode: 'offtask',
        leg: 'cosine',
        chars: PRODUCTION_QUERY_CLAMP + 500,
      }),
      'cosine',
    );
    expect(over.overProductionClamp).toBeGreaterThan(0);
  });
});
