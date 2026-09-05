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
  annotateCandidatesWithDisk,
  DEFAULT_SIMILARITY_THRESHOLD,
  fetchRedundancyCandidates,
  formatRedundancyMessage,
  judgeRedundantReservation,
  PLACEHOLDER_SLUG,
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

/**
 * EI-20300821494280085 — the case both windowed rules miss by construction.
 *
 * Fixtures are the real 998/1000/1004 chain from
 * `harness_shared.migration_reservations`: ONE author reserved the identical
 * slug three times over 109 minutes, wrote nothing at the first two, and finally
 * wrote the file at 1004. No stampede (far outside the 30-minute race window)
 * and nothing applied, so the shipped guard could only warn.
 */
const UNWRITTEN_SLUG = 'acceptance-rubric-subject-uniqueness';
const RE_RESERVER = 'su-9fe66521';

/** Reserved, never written, and its number is still free on disk. */
const m998 = {
  num: 998,
  filename: '998-acceptance-rubric-subject-uniqueness.sql',
  reservedBy: RE_RESERVER,
  reservedAtMs: ms('2026-09-02T10:00:00.000Z'),
  appliedAtMs: null,
  fileOnDisk: false,
  numberOnDisk: false,
};

/** 70 minutes later — the point at which the third reservation was requested. */
const RE_RESERVE_AT = ms('2026-09-02T11:10:00.000Z');

describe('unwritten-reservation rule', () => {
  it('BLOCKS re-reserving an exact slug whose file was never written, long after every window', () => {
    const j = judgeRedundantReservation({
      slug: UNWRITTEN_SLUG,
      candidates: [m998],
      nowMs: RE_RESERVE_AT,
    });
    expect(j.verdict).toBe('block');
    expect(j.matches[0]!.rule).toBe('unwritten-reservation');
    expect(j.matches[0]!.num).toBe(998);
    // Age-independent on purpose: the same judgement must hold a week later.
    expect(
      judgeRedundantReservation({
        slug: UNWRITTEN_SLUG,
        candidates: [m998],
        nowMs: RE_RESERVE_AT + 7 * 24 * 60 * 60 * 1000,
      }).verdict,
    ).toBe('block');
  });

  it('names the held number and its DRAFT path, so the remedy is executable not advisory', () => {
    const msg = formatRedundancyMessage(
      judgeRedundantReservation({
        slug: UNWRITTEN_SLUG,
        candidates: [m998],
        nowMs: RE_RESERVE_AT,
      }),
      { slug: UNWRITTEN_SLUG },
    )!;
    expect(msg).toContain('998-acceptance-rubric-subject-uniqueness.sql.DRAFT');
    expect(msg).toMatch(/ALREADY HOLD 998/);
  });

  it('does NOT block once the earlier reservation has actually been written', () => {
    // A `.DRAFT` counts as written — the author is mid-edit at the number they
    // hold, which is precisely the behaviour this rule exists to produce.
    const j = judgeRedundantReservation({
      slug: UNWRITTEN_SLUG,
      candidates: [{ ...m998, fileOnDisk: true }],
      nowMs: RE_RESERVE_AT,
    });
    expect(j.verdict).toBe('warn');
  });

  it('does NOT block when the reserved NUMBER is occupied by a different migration', () => {
    // The real 464/465 case: the reservation was for
    // `hlc-node-id-strong-entropy` but `464-gym-qd-archive-federation.sql`
    // occupies the number. "That number is still free, write there" would then
    // be wrong advice, so the rule must decline to give it.
    const j = judgeRedundantReservation({
      slug: 'hlc-node-id-strong-entropy',
      candidates: [
        {
          num: 464,
          filename: '464-hlc-node-id-strong-entropy.sql',
          reservedBy: 'su-27748',
          reservedAtMs: ms('2026-09-02T10:00:00.000Z'),
          appliedAtMs: null,
          fileOnDisk: false,
          numberOnDisk: true,
        },
      ],
      nowMs: RE_RESERVE_AT,
    });
    expect(j.verdict).toBe('warn');
  });

  it('FAILS OPEN: a caller supplying no filesystem facts keeps the pre-existing behaviour', () => {
    expect(
      judgeRedundantReservation({
        slug: UNWRITTEN_SLUG,
        candidates: [
          {
            num: m998.num,
            filename: m998.filename,
            reservedBy: m998.reservedBy,
            reservedAtMs: m998.reservedAtMs,
            appliedAtMs: m998.appliedAtMs,
          },
        ],
        nowMs: RE_RESERVE_AT,
      }).verdict,
    ).toBe('warn');
    // Explicit null (the ledger shape for "unknown") must read the same way.
    expect(
      judgeRedundantReservation({
        slug: UNWRITTEN_SLUG,
        candidates: [{ ...m998, fileOnDisk: null, numberOnDisk: null }],
        nowMs: RE_RESERVE_AT,
      }).verdict,
    ).toBe('warn');
  });

  it('never fires on the TODO-rename placeholder, which 40+ unrelated rows share', () => {
    const j = judgeRedundantReservation({
      slug: PLACEHOLDER_SLUG,
      candidates: [
        {
          num: 518,
          filename: `518-${PLACEHOLDER_SLUG}.sql`,
          reservedAtMs: ms('2026-09-02T10:00:00.000Z'),
          appliedAtMs: null,
          fileOnDisk: false,
          numberOnDisk: false,
        },
      ],
      nowMs: RE_RESERVE_AT,
    });
    expect(j.verdict).toBe('warn');
  });

  /**
   * CALIBRATION — why this rule is EXACT-match and not `similarity >= threshold`.
   *
   * The windowed rules can afford Dice ≥ 0.8 because a window bounds the damage:
   * a false positive only costs you inside 30 minutes, or inside 7 days of an
   * apply. An age-independent rule has no such bound, so it gets no fuzziness.
   *
   * These three pairs are REAL rows from `harness_shared.migration_reservations`
   * that score at or above the threshold and are unambiguously distinct work.
   * They are drawn from a full pass over the ledger (2026-09-05): of 32
   * non-exact pairs scoring ≥ 0.8, 28 are legitimately distinct — they read
   * alike because migration slugs share a subject, not because they share a
   * purpose. Only the applied/race windows keep those from being refused today.
   */
  const NEAR_BUT_DISTINCT: Array<[string, string]> = [
    // 960 → 975, Dice 0.80. OPPOSITE operations, one token apart.
    ['remove-owned-trigger-legacy-arbiter', '960-restore-owned-trigger-legacy-arbiter.sql'],
    // 914 → 918, Dice 0.86. A follow-up constraint on the column just added.
    ['goal-budget-window-validate', '914-goal-budget-window.sql'],
    // 554 → 557, Dice 0.80. Deliberately sequential phases of ONE planned rename.
    ['cup-lexicon-db-rename-phase3', '554-cup-lexicon-db-rename-phase1.sql'],
  ];

  it('requires EXACT slug equality — an above-threshold near-match still only warns', () => {
    for (const [slug, filename] of NEAR_BUT_DISTINCT) {
      const j = judgeRedundantReservation({
        slug,
        candidates: [
          {
            num: 900,
            filename,
            reservedAtMs: ms('2026-09-02T10:00:00.000Z'),
            appliedAtMs: null,
            fileOnDisk: false,
            numberOnDisk: false,
          },
        ],
        nowMs: RE_RESERVE_AT,
      });
      expect(j.verdict, `${slug} vs ${filename}`).toBe('warn');
    }
  });

  it('CONTROL: a threshold-based unwritten rule WOULD refuse every one of them', () => {
    // The deliberately-wrong variant, kept permanently. It satisfies the
    // incident property (an exact re-reserve scores 1.0, comfortably above
    // threshold) and fails calibration here, so it cannot pass both — which is
    // what makes the real rule's passing of both mean something.
    const wouldBlock = ([slug, filename]: [string, string]) =>
      slugSimilarity(slug, slugOfMigrationFilename(filename)) >= DEFAULT_SIMILARITY_THRESHOLD;
    expect(wouldBlock([UNWRITTEN_SLUG, m998.filename])).toBe(true);
    for (const pair of NEAR_BUT_DISTINCT) {
      expect(wouldBlock(pair), `${pair[0]} vs ${pair[1]} must score at/above threshold`).toBe(true);
    }
  });
});

describe('annotateCandidatesWithDisk', () => {
  const scan = {
    filenames: new Set(['1004-acceptance-rubric-subject-uniqueness.sql']),
    numbers: new Set([464, 1004]),
  };

  it('marks written and occupied independently', () => {
    const [written, unwritten, numberTaken] = annotateCandidatesWithDisk(
      [
        { num: 1004, filename: '1004-acceptance-rubric-subject-uniqueness.sql' },
        { num: 998, filename: '998-acceptance-rubric-subject-uniqueness.sql' },
        { num: 464, filename: '464-hlc-node-id-strong-entropy.sql' },
      ],
      scan,
    );
    expect(written).toMatchObject({ fileOnDisk: true, numberOnDisk: true });
    expect(unwritten).toMatchObject({ fileOnDisk: false, numberOnDisk: false });
    // The distinction the rule turns on: nothing named 464-hlc-… exists, yet
    // the NUMBER is taken by another migration.
    expect(numberTaken).toMatchObject({ fileOnDisk: false, numberOnDisk: true });
  });

  it('leaves candidates UNANNOTATED when no scan is available, rather than claiming absence', () => {
    // Annotating false here would convert a caller that cannot read the disk
    // into one that blocks on every exact-slug match it sees.
    const candidates = [{ num: 998, filename: '998-x.sql' }];
    for (const noScan of [undefined, null, {}, { filenames: new Set(), numbers: undefined }]) {
      const out = annotateCandidatesWithDisk(candidates, noScan as never);
      expect(out[0]).not.toHaveProperty('fileOnDisk');
      expect(out[0]).not.toHaveProperty('numberOnDisk');
    }
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
