import { describe, expect, it } from 'vitest';
import {
  findIdentityLeaks,
  identityLiterals,
  needsWordBoundary,
  scrubIdentity,
  type IdentityLiteral,
} from './release-content-scrub';
import { renderIndexHtml, renderPlanPageHtml } from './release-history-page';
import type { ReleaseRow, ShippedPlan } from './release-registry';

// A stand-in owner. Never the real one — putting the real name in a source file
// to test for it would BE the leak, committed to git.
const LITS: IdentityLiteral[] = [
  { kind: 'home', value: '/home/jdoe' },
  { kind: 'user', value: 'jdoe' },
  { kind: 'git-name', value: 'Jane' },
  { kind: 'git-email', value: 'jane@example.com' },
  { kind: 'hostname', value: 'jane-devbox' },
];

describe('scrubIdentity', () => {
  it('redacts the home path out of a work-item title — the real leak that was found', () => {
    const title = 'Run `bash /home/jdoe/.papercusp/drill/fixture-step.sh` and report the output';
    expect(scrubIdentity(title, LITS)).toBe(
      'Run `bash ~/.papercusp/drill/fixture-step.sh` and report the output',
    );
  });

  it("redacts the owner's first name out of a plan's decision log — the other real leak", () => {
    const decision = 'D-001 [owner:Jane 2026-07-11] Adopt all layers now.';
    expect(scrubIdentity(decision, LITS)).toBe('D-001 [owner:<owner> 2026-07-11] Adopt all layers now.');
  });

  it('redacts the LONGEST literal first, so the home path never survives as /home/<user>', () => {
    // The ordering bug: redact the username first and `/home/jdoe` becomes
    // `/home/<user>` — still leaking the shape of the box, AND no longer matching
    // the home literal, so the gate downstream would call it CLEAN. Half-scrubbed
    // text that passes the gate is worse than text that fails it.
    const out = scrubIdentity('/home/jdoe/work', LITS);
    expect(out).toBe('~/work');
    expect(out).not.toContain('/home/');
    expect(findIdentityLeaks(out, LITS)).toEqual([]);
  });

  it('leaves innocent text alone — a gate that over-redacts gets switched off', () => {
    const text = 'The pipeline is done. Java and JavaScript are different.';
    expect(scrubIdentity(text, LITS)).toBe(text);
  });

  it('matches a short name on a word boundary, not as a substring', () => {
    expect(needsWordBoundary('Jane')).toBe(true);
    expect(needsWordBoundary('/home/jdoe')).toBe(false);
    // "Jane" must not fire inside "Janeway"...
    expect(scrubIdentity('Janeway plotted a course', LITS)).toBe('Janeway plotted a course');
    // ...but must fire when it stands alone.
    expect(scrubIdentity('asked Jane about it', LITS)).toBe('asked <owner> about it');
  });
});

describe('findIdentityLeaks — the gate, separate from the fix', () => {
  it('finds and counts what leaked', () => {
    const leaks = findIdentityLeaks('/home/jdoe and again /home/jdoe, signed Jane', LITS);
    expect(leaks).toEqual(
      expect.arrayContaining([
        { kind: 'home', count: 2 },
        { kind: 'git-name', count: 1 },
      ]),
    );
  });

  it('reports nothing on scrubbed text', () => {
    expect(findIdentityLeaks(scrubIdentity('/home/jdoe — Jane', LITS), LITS)).toEqual([]);
  });
});

describe('identityLiterals resolves from the machine, and hardcodes nothing', () => {
  it('never returns a generic account as an identity', () => {
    for (const lit of identityLiterals()) {
      expect(['root', 'runner', 'build', 'ubuntu']).not.toContain(lit.value);
    }
  });
});

// ── The invariant that actually matters: no page can be published un-scrubbed.
describe('every generated page is scrubbed on the way out', () => {
  const row: ReleaseRow = {
    version: '0.0.9',
    channel: 'alpha',
    cutAt: new Date('2026-07-12T00:00:00Z'),
    publishedAt: null,
    changelogMd: 'Fixed by Jane on /home/jdoe.',
    workItemIds: ['WI-1'],
    planSlugs: ['p'],
    artifacts: [],
    gitSha: null,
    cutBy: null,
    notes: null,
  };
  const plan: ShippedPlan = {
    slug: 'p',
    title: 'A plan',
    status: 'active',
    content: 'D-001 [owner:Jane] run /home/jdoe/script.sh',
    itemCount: 1,
  };
  const opts = { generatedAt: new Date('2026-07-13T00:00:00Z'), analytics: null, redact: LITS };

  it('scrubs the index — titles, changelog and all', () => {
    const html = renderIndexHtml(
      [
        {
          row,
          items: [{ id: 'WI-1', title: 'fix /home/jdoe/thing.sh for Jane', planSlug: 'p' }],
          plans: [plan],
          internalCount: 0,
        },
      ],
      opts,
    );
    expect(findIdentityLeaks(html, LITS)).toEqual([]);
    expect(html).not.toContain('/home/jdoe');
    expect(html).not.toContain('Jane');
  });

  it('scrubs a plan page — where the decision logs live', () => {
    const html = renderPlanPageHtml(plan, { ...opts, version: '0.0.9' });
    expect(findIdentityLeaks(html, LITS)).toEqual([]);
    expect(html).toContain('~/script.sh');
    expect(html).toContain('&lt;owner&gt;'); // escaped, then redacted — still redacted
  });
});
