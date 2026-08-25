/**
 * OKF v0.2 read-time trust/staleness (okf-frontmatter-adoption-2026-08-08 P-005).
 *
 * Every staleness proof here uses a SYNTHETIC date passed as `now` or written into
 * a fixture string — never a value read from (or written to) the real corpus. Plan
 * D-002 forbids fabricating `verified` / `stale_after` on real docs, and the whole
 * live corpus is deliberately 0/659 + 0/70 on both fields, so a test that "proved"
 * staleness by populating one would be proving the thing the plan exists to prevent.
 */

import { describe, it, expect } from 'vitest';
import {
  CANONICAL_DOC_STATUSES,
  evaluateOkfTrust,
  isCanonicalDocStatus,
  isMachineVerifier,
  isRetiredDocStatus,
  normalizeOkfDate,
  normalizeDocStatus,
  okfFromObject,
  okfTrustBanner,
  okfTrustIsNotable,
  parseOkfFrontmatter,
} from './okf';

const NOW = new Date('2026-08-08T12:00:00Z');

function fm(block: string): string {
  return `---\n${block}\n---\n\n# Body\n\ntext\n`;
}

describe('parseOkfFrontmatter', () => {
  it('returns undefined for a doc with no frontmatter at all', () => {
    expect(parseOkfFrontmatter('# Just a body\n')).toBeUndefined();
  });

  it('returns undefined for frontmatter carrying NONE of the four OKF fields', () => {
    // The live corpus's pre-P-003 shape. "No OKF metadata" must not be
    // distinguishable from "unreadable" at the trust layer — both are "we know nothing".
    expect(parseOkfFrontmatter(fm('title: Something\ndescription: else'))).toBeUndefined();
  });

  it('returns undefined (never a partial verdict) when the YAML does not parse', () => {
    expect(parseOkfFrontmatter(fm('type: Insight\n  bad: [unclosed'))).toBeUndefined();
  });

  it('reads the flat fields the corpus actually carries today', () => {
    const okf = parseOkfFrontmatter(fm('title: T\ntype: Insight\ngenerated:\n  by: agent\n  at: 2026-07-01'));
    expect(okf).toEqual({ type: 'Insight', generated: { by: 'agent', at: '2026-07-01' } });
  });

  it('reads NESTED blocks the adapter\'s flat scalar parser cannot see', () => {
    // The regression this guards: starlight.ts's parseFrontmatter is a top-level
    // scalar reader, so `generated:`/`verified:` were invisible to it. If OKF parsing
    // ever gets routed back through that reader, this fails.
    const okf = parseOkfFrontmatter(fm('verified:\n  - by: avi\n    at: 2026-08-01\n  - by: agent\n    at: 2026-08-02'));
    expect(okf?.verified).toEqual([
      { by: 'avi', at: '2026-08-01' },
      { by: 'agent', at: '2026-08-02' },
    ]);
  });

  it('collapses a BARE verified mapping to a single-element list (spec requirement)', () => {
    const okf = parseOkfFrontmatter(fm('verified:\n  by: avi\n  at: 2026-08-01'));
    expect(okf?.verified).toEqual([{ by: 'avi', at: '2026-08-01' }]);
  });

  it('drops a verified entry with no `by` rather than inventing one', () => {
    const okf = parseOkfFrontmatter(fm('type: Insight\nverified:\n  - at: 2026-08-01'));
    expect(okf?.verified).toBeUndefined();
    expect(okf?.type).toBe('Insight');
  });

  it('accepts BOTH date shapes — js-yaml resolves an unquoted date to a Date instance', () => {
    // D-002: this both-shapes reality is why the Astro schema is z.union([string, date]).
    expect(parseOkfFrontmatter(fm('stale_after: 2026-12-01'))?.staleAfter).toBe('2026-12-01');
    expect(parseOkfFrontmatter(fm("stale_after: '2026-12-01'"))?.staleAfter).toBe('2026-12-01');
  });
});

describe('normalizeOkfDate', () => {
  it('renders a Date to YYYY-MM-DD and passes a string through', () => {
    expect(normalizeOkfDate(new Date('2026-12-01T00:00:00Z'))).toBe('2026-12-01');
    expect(normalizeOkfDate(' 2026-12-01 ')).toBe('2026-12-01');
    expect(normalizeOkfDate(new Date('nonsense'))).toBeUndefined();
    expect(normalizeOkfDate(null)).toBeUndefined();
    expect(normalizeOkfDate('')).toBeUndefined();
  });
});

describe('evaluateOkfTrust — the ladder', () => {
  it('is unverified + not stale for NO metadata (the entire live corpus today)', () => {
    const t = evaluateOkfTrust(undefined, NOW);
    expect(t).toEqual({ tier: 'unverified', stale: false });
    expect(okfTrustIsNotable(t)).toBe(false);
  });

  it('is STILL unverified for a machine-GENERATED doc — generated is not verified', () => {
    const t = evaluateOkfTrust({ type: 'Insight', generated: { by: 'agent', at: '2026-07-01' } }, NOW);
    expect(t.tier).toBe('unverified');
    expect(t.generatedBy).toBe('agent');
    expect(okfTrustIsNotable(t)).toBe(false);
  });

  it('is machine-verified when every verifier is a machine', () => {
    const t = evaluateOkfTrust({ verified: [{ by: 'agent', at: '2026-08-01' }] }, NOW);
    expect(t.tier).toBe('machine-verified');
    expect(t.verifiedBy).toBe('agent');
    expect(okfTrustIsNotable(t)).toBe(true);
  });

  it('is human-verified when ANY verifier is human, even if a machine checked it later', () => {
    const t = evaluateOkfTrust(
      { verified: [{ by: 'avi', at: '2026-08-01' }, { by: 'su-c7409', at: '2026-08-05' }] },
      NOW,
    );
    expect(t.tier).toBe('human-verified');
    // The quoted event is the most recent HUMAN one — not the newest overall — so the
    // tier and the evidence beside it can never describe different verifications.
    expect(t.verifiedBy).toBe('avi');
    expect(t.verifiedAt).toBe('2026-08-01');
  });

  it('always returns the raw verifier so the (provisional) machine/human rule is auditable', () => {
    expect(evaluateOkfTrust({ verified: [{ by: 'ci-runner' }] }, NOW).verifiedBy).toBe('ci-runner');
  });
});

describe('isMachineVerifier', () => {
  it('classifies this system\'s own actor shapes as machines', () => {
    for (const by of ['agent', 'agent:documenter', 'su-c7409', 'bot', 'ci', 'system:doc-freshness', 'claude', 'doc-agent']) {
      expect(isMachineVerifier(by), by).toBe(true);
    }
  });

  it('treats an unrecognised verifier as HUMAN — the stronger claim needs the weaker default', () => {
    // Getting this backwards would silently downgrade real human verifications to
    // machine ones, which is the direction that loses information.
    for (const by of ['avi', 'marsh', 'j.doe@example.com']) {
      expect(isMachineVerifier(by), by).toBe(false);
    }
  });
});

describe('evaluateOkfTrust — staleness', () => {
  it('is stale when today is PAST stale_after', () => {
    const t = evaluateOkfTrust({ staleAfter: '2026-01-01' }, NOW);
    expect(t.stale).toBe(true);
    expect(t.staleAfter).toBe('2026-01-01');
  });

  it('is stale ON the boundary day — the spec says today >= stale_after', () => {
    expect(evaluateOkfTrust({ staleAfter: '2026-08-08' }, NOW).stale).toBe(true);
  });

  it('is NOT stale the day before', () => {
    expect(evaluateOkfTrust({ staleAfter: '2026-08-09' }, NOW).stale).toBe(false);
  });

  it('floors to UTC midnight, so the verdict does not depend on time-of-day', () => {
    const earlyUtc = new Date('2026-08-08T00:00:01Z');
    const lateUtc = new Date('2026-08-08T23:59:59Z');
    expect(evaluateOkfTrust({ staleAfter: '2026-08-08' }, earlyUtc).stale).toBe(true);
    expect(evaluateOkfTrust({ staleAfter: '2026-08-08' }, lateUtc).stale).toBe(true);
  });

  it('reports an UNPARSEABLE stale_after WITHOUT declaring the doc stale', () => {
    // An unreadable field is a conformance defect for P-006's lint, never licence
    // to declare a doc rotten — a false "STALE" banner is its own kind of lie.
    const t = evaluateOkfTrust({ staleAfter: 'next tuesday' }, NOW);
    expect(t.stale).toBe(false);
    expect(t.staleAfterUnparseable).toBe(true);
    expect(okfTrustIsNotable(t)).toBe(true);
  });
});

describe('okfTrustBanner', () => {
  it('emits nothing for the corpus\'s current state (nothing to warn about)', () => {
    expect(okfTrustBanner(evaluateOkfTrust(undefined, NOW))).toBeNull();
  });

  it('names the date and says the claims are unverified when stale', () => {
    const banner = okfTrustBanner(evaluateOkfTrust({ staleAfter: '2026-01-01' }, NOW));
    expect(banner).toContain('STALE');
    expect(banner).toContain('2026-01-01');
    expect(banner).toContain('never been verified');
  });

  it('quotes the last verification when the stale doc HAS one', () => {
    const banner = okfTrustBanner(
      evaluateOkfTrust({ staleAfter: '2026-01-01', verified: [{ by: 'avi', at: '2025-12-01' }] }, NOW),
    );
    expect(banner).toContain('Last verified 2025-12-01 by avi');
  });

  it('says the expiry could NOT be evaluated for an unparseable date', () => {
    const banner = okfTrustBanner(evaluateOkfTrust({ staleAfter: 'next tuesday' }, NOW));
    expect(banner).toContain('not a parseable date');
  });
});

describe('status: superseded — an AUTHORED retirement, not a fabricated verdict', () => {
  it('exposes one canonical vocabulary and normalizes legacy aliases', () => {
    expect(CANONICAL_DOC_STATUSES).toEqual(['active', 'draft', 'superseded']);
    expect(normalizeDocStatus('  CURRENT ')).toBe('active');
    expect(normalizeDocStatus(' retired ')).toBe('superseded');
    expect(normalizeDocStatus('DRAFT')).toBe('draft');
    expect(normalizeDocStatus('future-status')).toBe('future-status');
    expect(normalizeDocStatus('   ')).toBeUndefined();
    expect(isCanonicalDocStatus('active')).toBe(true);
    expect(isCanonicalDocStatus('current')).toBe(false);
  });

  it('normalises the authored value, case and padding included', () => {
    expect(okfFromObject({ status: '  SuperSeded ' })?.status).toBe('superseded');
    expect(okfFromObject({ status: ' current ' })?.status).toBe('active');
    expect(okfFromObject({ status: ' retired ' })?.status).toBe('superseded');
  });

  it('populates okf from `status:` ALONE, so a doc with no OKF fields is still readable', () => {
    // The 28 superseded docs are not guaranteed to carry any of the four OKF
    // fields; if `status` did not count as present, parseOkfFrontmatter would
    // return undefined and the retirement would stay invisible — the exact bug.
    const fm = okfFromObject({ status: 'superseded' });
    expect(fm).toBeDefined();
    expect(evaluateOkfTrust(fm, NOW).superseded).toBe(true);
  });

  it('flags the doc as superseded and makes the verdict notable', () => {
    const t = evaluateOkfTrust({ status: 'superseded' }, NOW);
    expect(t.superseded).toBe(true);
    expect(okfTrustIsNotable(t)).toBe(true);
  });

  it('does NOT retire the 587 docs that say active/current — they stay silent', () => {
    for (const status of ['active', 'current', 'draft']) {
      const t = evaluateOkfTrust({ status }, NOW);
      expect(t.superseded).toBeUndefined();
      expect(t.status).toBe(status);
      expect(okfTrustIsNotable(t)).toBe(false);
      expect(okfTrustBanner(t)).toBeNull();
    }
  });

  it('agrees with insights-index\'s LIVE/retired vocabulary, value for value', () => {
    // The whole point of the shared predicate: these two surfaces must not be
    // able to disagree about whether a given doc is retired. LIVE_STATUSES is
    // insights-index.test.ts's allowlist; the retired pair is its `isVisible`.
    for (const live of [...CANONICAL_DOC_STATUSES, 'current', 'review', 'wip']) {
      if (isRetiredDocStatus(live)) continue;
      expect(isRetiredDocStatus(live)).toBe(false);
    }
    for (const dead of ['retired', 'superseded']) {
      expect(isRetiredDocStatus(dead)).toBe(true);
      expect(evaluateOkfTrust({ status: dead }, NOW).superseded).toBe(true);
    }
    expect(isRetiredDocStatus(undefined)).toBe(false);
    expect(isRetiredDocStatus('  SUPERSEDED ')).toBe(true);
  });

  it('carries an UNRECOGNISED status verbatim without asserting anything about it', () => {
    const t = evaluateOkfTrust({ status: 'mothballed' }, NOW);
    expect(t.status).toBe('mothballed');
    expect(t.superseded).toBeUndefined();
    expect(okfTrustIsNotable(t)).toBe(false);
  });

  it('banners a superseded doc and tells the reader to go find its replacement', () => {
    const banner = okfTrustBanner(evaluateOkfTrust({ status: 'superseded' }, NOW));
    expect(banner).toContain('SUPERSEDED');
    expect(banner).toContain('status: superseded');
    expect(banner).toContain('do NOT follow it as current guidance');
  });

  it('leads with SUPERSEDED over STALE when a doc is both, but still reports the date', () => {
    // Retirement is the stronger claim: "replaced" beats "needs re-checking", and
    // leading with the weaker one would send a reader off to re-verify a doc that
    // should simply be abandoned.
    const banner = okfTrustBanner(
      evaluateOkfTrust({ status: 'superseded', staleAfter: '2026-01-01' }, NOW),
    );
    expect(banner).toContain('SUPERSEDED');
    expect(banner).not.toContain('**STALE');
    expect(banner).toContain('2026-01-01');
  });
});
