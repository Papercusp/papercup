/**
 * WI-38353 — the `db:next-migration` chokepoint must refuse duplicate WORK, not
 * just duplicate numbers.
 *
 * Subject: scripts/lib/migration-slug-dedup.mjs, shared by both reservation
 * doors (the CLI and the MCP tool).
 *
 * FALSIFIABILITY. This is a MODULE-level subject, so per the repo's
 * mutation-probe discipline the controls live permanently in this file rather
 * than being proven by mutating the shared tree (a tree mutation can be
 * committed by the git-sync sweep even when nothing goes wrong). The two
 * degenerate similarity functions below are the controls, and they are
 * load-bearing in OPPOSITE directions: `alwaysIdentical` satisfies the incident
 * property but fails calibration, `neverSimilar` satisfies calibration but
 * fails the incident property. Neither can pass both, so a detector that passes
 * both is doing real discrimination — not just answering "yes" or "no".
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SIMILARITY_THRESHOLD,
  fetchRedundancyCandidates,
  formatRedundancyMessage,
  judgeRedundantReservation,
  slugOfMigrationFilename,
  slugSimilarity,
} from '../../../scripts/lib/migration-slug-dedup.mjs';

describe('fetchRedundancyCandidates filename identity', () => {
  it('never marks a reservation applied merely because another filename shares its number', async () => {
    let query = '';
    const tx = async (strings: TemplateStringsArray) => {
      query = strings.join('?');
      return [];
    };
    await fetchRedundancyCandidates(tx as never);
    expect(query).toContain('WHERE m.filename = r.filename');
    expect(query).toContain('WHERE r2.filename = m.filename');
    expect(query).not.toContain("m.filename LIKE r.num || '-%'");
  });
});

const ms = (iso: string) => Date.parse(iso);

/**
 * Stand-in for the ledger's `reserved_by` on the two CLI-door reservations.
 * The real value was the build box's `$USER`, which is exactly the class of
 * bare identity literal the identity-lint gate reds `main` over — and the point
 * of the fixture is the SHAPE of the label (a CLI `$USER` fallback, not an
 * agent id), which is what made attribution useless during the incident.
 */
const PEER_CLI_LABEL = 'cli-user-fallback';

/**
 * The real 2026-08-13 stampede, from `harness_shared.migration_reservations`
 * joined to `harness_shared.schema_migrations`. Four numbers in 48 seconds for
 * one repair; all four were applied.
 */
const LEDGER = {
  m815: {
    num: 815,
    filename: '815-expose-claim-spec-fields-on-engineer-issues-view.sql',
    appliedAtMs: ms('2026-08-12T23:05:13.389Z'),
    reservedAtMs: null,
  },
  m816: {
    num: 816,
    filename: '816-backfill-migration-reservation-815-wi38348.sql',
    reservedBy: 'su · su-03f94',
    reservedAtMs: ms('2026-08-13T01:49:06.262Z'),
    appliedAtMs: ms('2026-08-13T01:49:44.777Z'),
  },
  m817: {
    num: 817,
    filename: '817-backfill-migration-reservation-815.sql',
    reservedBy: PEER_CLI_LABEL,
    reservedAtMs: ms('2026-08-13T01:49:10.160Z'),
    appliedAtMs: ms('2026-08-13T01:49:43.548Z'),
  },
  m818: {
    num: 818,
    filename: '818-backfill-migration-reservation-815.sql',
    reservedBy: PEER_CLI_LABEL,
    reservedAtMs: ms('2026-08-13T01:49:15.222Z'),
    appliedAtMs: ms('2026-08-13T01:49:57.441Z'),
  },
};

/** The slug every racer after the first was about to reserve. */
const RACED_SLUG = 'backfill-migration-reservation-815';

/** Pairs that ARE the same work — the detector must score these at/above threshold. */
const SAME_WORK_PAIRS: Array<[string, string]> = [
  ['backfill-migration-reservation-815', 'backfill-migration-reservation-815'],
  ['backfill-migration-reservation-815', 'backfill-migration-reservation-815-wi38348'],
];

/**
 * Pairs that merely READ alike but are legitimately distinct migrations — the
 * detector must score these BELOW threshold. This is the calibration half: a
 * guard that blocks these is worse than no guard, because it wedges the one
 * chokepoint every migration passes through.
 */
const DISTINCT_WORK_PAIRS: Array<[string, string]> = [
  // A different target number is different work.
  ['backfill-migration-reservation-815', 'backfill-migration-reservation-816'],
  ['add-foo-index', 'add-bar-index'],
  ['add-users-table', 'add-users-index'],
  ['backfill-migration-reservation-815', 'expose-claim-spec-fields-on-engineer-issues-view'],
];

describe('slug similarity discriminates same-work from distinct-work', () => {
  it('scores the real stampede pairs at or above threshold', () => {
    for (const [a, b] of SAME_WORK_PAIRS) {
      expect(slugSimilarity(a, b), `${a} vs ${b}`).toBeGreaterThanOrEqual(DEFAULT_SIMILARITY_THRESHOLD);
    }
  });

  it('scores legitimately-distinct migrations below threshold', () => {
    for (const [a, b] of DISTINCT_WORK_PAIRS) {
      expect(slugSimilarity(a, b), `${a} vs ${b}`).toBeLessThan(DEFAULT_SIMILARITY_THRESHOLD);
    }
  });

  // ---- CONTROLS: deliberately-wrong implementations, kept permanently. ----
  const alwaysIdentical = () => 1;
  const neverSimilar = () => 0;

  it('CONTROL: an always-identical scorer passes the incident test but FAILS calibration', () => {
    for (const [a, b] of SAME_WORK_PAIRS) {
      expect(alwaysIdentical()).toBeGreaterThanOrEqual(DEFAULT_SIMILARITY_THRESHOLD);
    }
    const calibrationHolds = DISTINCT_WORK_PAIRS.every(() => alwaysIdentical() < DEFAULT_SIMILARITY_THRESHOLD);
    expect(calibrationHolds, 'a degenerate always-block scorer must not satisfy calibration').toBe(false);
  });

  it('CONTROL: a never-similar scorer passes calibration but FAILS the incident test', () => {
    for (const [a, b] of DISTINCT_WORK_PAIRS) {
      expect(neverSimilar()).toBeLessThan(DEFAULT_SIMILARITY_THRESHOLD);
    }
    const incidentHolds = SAME_WORK_PAIRS.every(() => neverSimilar() >= DEFAULT_SIMILARITY_THRESHOLD);
    expect(incidentHolds, 'a degenerate never-block scorer must not satisfy the incident property').toBe(false);
  });
});

describe('judgeRedundantReservation blocks the real stampede', () => {
  it('BLOCKS racer #2 (817): a peer reserved a near-identical slug 4s earlier', () => {
    const j = judgeRedundantReservation({
      slug: RACED_SLUG,
      candidates: [LEDGER.m815, { ...LEDGER.m816, appliedAtMs: null }],
      nowMs: ms('2026-08-13T01:49:10.160Z'),
    });
    expect(j.verdict).toBe('block');
    expect(j.matches[0]!.num).toBe(816);
    expect(j.matches[0]!.reason).toMatch(/racing/i);
  });

  it('BLOCKS racer #4 (819): a near-identical migration had already APPLIED 10s earlier', () => {
    const j = judgeRedundantReservation({
      slug: RACED_SLUG,
      candidates: [LEDGER.m815, LEDGER.m816, LEDGER.m817, LEDGER.m818],
      nowMs: ms('2026-08-13T01:49:54.967Z'),
    });
    expect(j.verdict).toBe('block');
    expect(j.matches.some((m) => m.applied && m.reason.match(/ALREADY APPLIED/))).toBe(true);
  });

  it('CLEARS the first racer (816): nothing similar existed yet', () => {
    const j = judgeRedundantReservation({
      slug: 'backfill-migration-reservation-815-wi38348',
      candidates: [LEDGER.m815],
      nowMs: ms('2026-08-13T01:49:06.262Z'),
    });
    expect(j.verdict).toBe('clear');
    expect(j.matches).toEqual([]);
  });

  it('CLEARS genuinely distinct work even while the stampede is in flight', () => {
    const j = judgeRedundantReservation({
      slug: 'add-workspace-id-index-on-tool-invocations',
      candidates: [LEDGER.m815, LEDGER.m816, LEDGER.m817, LEDGER.m818],
      nowMs: ms('2026-08-13T01:49:54.967Z'),
    });
    expect(j.verdict).toBe('clear');
  });

  it('degrades to a WARN, never a block, once the windows have passed', () => {
    const j = judgeRedundantReservation({
      slug: RACED_SLUG,
      candidates: [LEDGER.m816],
      nowMs: ms('2026-08-13T01:49:44.777Z') + 20 * 24 * 60 * 60 * 1000,
    });
    expect(j.verdict).toBe('warn');
  });

  it('FAILS OPEN: a candidate carrying no timestamps can warn but never block', () => {
    const j = judgeRedundantReservation({
      slug: RACED_SLUG,
      candidates: [{ num: 900, filename: '900-backfill-migration-reservation-815.sql' }],
      nowMs: Date.now(),
    });
    expect(j.verdict).toBe('warn');
  });
});

describe('slugOfMigrationFilename', () => {
  it('strips the number and every runner-hiding suffix', () => {
    expect(slugOfMigrationFilename('816-backfill-foo.sql')).toBe('backfill-foo');
    expect(slugOfMigrationFilename('816-backfill-foo.sql.DRAFT')).toBe('backfill-foo');
    expect(slugOfMigrationFilename('816-backfill-foo.sql.PENDING-CODE-DEPLOY')).toBe('backfill-foo');
  });
});

describe('formatRedundancyMessage', () => {
  it('leads with the imperative so a truncated/skimmed read still changes behaviour', () => {
    const j = judgeRedundantReservation({
      slug: RACED_SLUG,
      candidates: [LEDGER.m816],
      nowMs: ms('2026-08-13T01:49:54.967Z'),
    });
    const msg = formatRedundancyMessage(j, { slug: RACED_SLUG })!;
    expect(msg.split('\n')[0]).toMatch(/^STOP —/);
    expect(msg).toContain('816');
    expect(msg).toMatch(/--force/);
  });

  it('returns null when there is nothing to say', () => {
    expect(formatRedundancyMessage({ verdict: 'clear', matches: [] }, { slug: 'x' })).toBeNull();
  });
});

describe('both reservation doors share one implementation', () => {
  it('exports the ledger query so the CLI and the MCP tool cannot diverge', () => {
    // The two doors historically duplicated their allocation SQL and were kept
    // in step only by a comment ("the shared contract is the LEDGER"). The
    // dedup read is shared as CODE instead — if this export disappears, one
    // door has grown its own copy.
    expect(typeof fetchRedundancyCandidates).toBe('function');
  });
});
