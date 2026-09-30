import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GENERIC_ACCOUNTS } from '../../../../scripts/lib/identity-leak-patterns.mjs';
import {
  PUBLISHED_CONTACT_EMAIL,
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
    expect(scrubIdentity(decision, LITS)).toBe('D-001 [owner:[owner] 2026-07-11] Adopt all layers now.');
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
    expect(scrubIdentity('asked Jane about it', LITS)).toBe('asked [owner] about it');
  });

  it('catches the name in ANY case — both real misses from the first generated page', () => {
    // Case-sensitive matching (what the bundle gate does) let both of these through
    // onto a page meant for beta testers. Same name, different case, still him.
    expect(scrubIdentity('see assembly/JANE-NOTES-DRAFT-3.md', LITS)).toBe(
      'see assembly/[owner]-NOTES-DRAFT-3.md',
    );
    expect(scrubIdentity('host jane-dev pid 33417', LITS)).toBe('host [owner]-dev pid 33417');
  });
});

// ── The identity we did NOT enumerate. This is the one that got out.
describe('shape-based patterns catch the identity no literal knew about', () => {
  it("redacts an email that is NOT the box's git identity — the real second leak", () => {
    // The scrub knew `user.email` and redacted it perfectly. The plans' frontmatter
    // carried `owner: <a different personal address>` — same human, an address this
    // box has never heard of, so no literal matched and it went onto the page.
    const text = 'owner: someone-else@gmail.com';
    expect(scrubIdentity(text, LITS)).toBe('owner: [email]');
    // ...and the GATE must see it too, or it certifies the leak as clean.
    expect(findIdentityLeaks(text, LITS)).toEqual([{ kind: 'email', count: 1 }]);
  });

  it("redacts somebody else's home directory, on all three platforms", () => {
    expect(scrubIdentity('/home/otheruser/build.log', LITS)).toBe('~/build.log');
    expect(scrubIdentity('/Users/buildbot/Library', LITS)).toBe('~/Library');
    expect(scrubIdentity('C:\\Users\\tester\\AppData', LITS)).toBe('~\\AppData');
  });

  it('scrubs with the ENUMERATED literal first — the shapes are the backstop, not the winner', () => {
    // The SCRUB is ordered: this box's own home is a known literal, so it redacts as
    // `home` and the generic unix-home pattern never sees it. (The GATE is different
    // by design — it reports EVERY shape it finds in the raw text, overlapping or
    // not: its job is "is there any identity in these bytes", not "which rule owns
    // this byte". Both must end up clean.)
    expect(scrubIdentity('/home/jdoe/x', LITS)).toBe('~/x');
    expect(findIdentityLeaks('/home/jdoe/x', LITS).map((h) => h.kind)).toContain('home');
    expect(findIdentityLeaks(scrubIdentity('/home/jdoe/x', LITS), LITS)).toEqual([]);
  });

  it('does not fire on ordinary prose that merely contains an @', () => {
    const text = 'Import @papercusp/sync and ping the team in #releases.';
    expect(scrubIdentity(text, LITS)).toBe(text);
    expect(findIdentityLeaks(text, LITS)).toEqual([]);
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
      expect([...GENERIC_ACCOUNTS]).not.toContain(lit.value);
    }
  });

  // WI-10004233: the scrub, the seed guard and the doc projection each kept a local
  // generic-login list that drifted from the release gate's. They must all read the one
  // shared set, so a runner/VM account the gate treats as generic is never "leaked".
  it('reads its generic-account list from the shared module, not a local copy', () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const root = resolve(dir, '../../../..');
    for (const rel of [
      'apps/operator/lib/release/release-content-scrub.ts',
      'apps/operator/lib/release/seed-identity-guard.ts',
      'scripts/lib/doc-projection.ts',
    ]) {
      const src = readFileSync(resolve(root, rel), 'utf8');
      expect(src, rel).toMatch(/import \{[^}]*GENERIC_ACCOUNTS[^}]*\} from '[^']*identity-leak-patterns\.mjs'/);
      expect(src, rel).not.toMatch(/new Set\(\[\s*'root',\s*'runner'/);
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
    // The placeholder must be VISIBLE text, not a tag a browser would swallow.
    expect(html).toContain('[owner]');
    expect(html).not.toContain('<owner>');
  });
});

// WI-6580 — the opt-in allowance. The DEFAULT behaviour must be untouched.
describe('scrubIdentity / findIdentityLeaks — allowEmails is opt-in and exact', () => {
  const LITS2: IdentityLiteral[] = [{ kind: 'git-name', value: 'Jane' }];
  const text = `contact ${PUBLISHED_CONTACT_EMAIL} or other@example.com`;

  it('scrubs the published address by DEFAULT (no allowance passed)', () => {
    // Every existing caller — the real index, plan pages, history.json — keeps
    // the old behaviour. Otherwise this change would quietly publish the address
    // everywhere it happens to appear, which is the original leak.
    const out = scrubIdentity(text, LITS2);
    expect(out).not.toContain(PUBLISHED_CONTACT_EMAIL);
    expect(out).toContain('[email]');
  });

  it('leaves ONLY the allowed address when opted in, scrubbing the rest', () => {
    const out = scrubIdentity(text, LITS2, { allowEmails: [PUBLISHED_CONTACT_EMAIL] });
    expect(out).toContain(PUBLISHED_CONTACT_EMAIL);
    expect(out).not.toContain('other@example.com');
    expect(out).toContain('[email]');
  });

  it('reports a leak for the published address by default, none when allowed', () => {
    expect(findIdentityLeaks(text, LITS2).map((h) => h.kind)).toContain('email');
    expect(
      findIdentityLeaks(`mail ${PUBLISHED_CONTACT_EMAIL}`, LITS2, {
        allowEmails: [PUBLISHED_CONTACT_EMAIL],
      }),
    ).toEqual([]);
  });

  it('still flags a DIFFERENT address even when the allowance is active', () => {
    const hits = findIdentityLeaks(text, LITS2, { allowEmails: [PUBLISHED_CONTACT_EMAIL] });
    expect(hits.map((h) => h.kind)).toContain('email');
  });

  it('scrubs a home path on the same line as the allowed address', () => {
    // Masking must not accidentally shield neighbouring content from the other
    // patterns — only the address itself is exempt.
    const out = scrubIdentity(`${PUBLISHED_CONTACT_EMAIL} built in /home/jdoe/x`, LITS2, {
      allowEmails: [PUBLISHED_CONTACT_EMAIL],
    });
    expect(out).toContain(PUBLISHED_CONTACT_EMAIL);
    expect(out).not.toContain('/home/jdoe');
  });
});
