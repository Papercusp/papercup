/**
 * flag-comment-lint.test.ts — the guard EI-9826 asked for: FAILS THE BUILD when a
 * FLAGS entry's own doc comment claims a default ("DEFAULT ON" / "DEFAULT OFF") that
 * disagrees with its actual DARK_FLAGS membership. See flag-comment-lint.ts's module
 * doc for the bug class this closes and the parsing approach's precision tradeoffs.
 *
 * Two halves:
 *  - FIXTURE tests: small synthetic `FLAGS`/`DARK_FLAGS`-shaped source snippets that
 *    exercise the parser + checker in isolation — prove the guard actually fires on a
 *    deliberate mismatch, and does NOT false-positive on the known-tricky prose shapes
 *    (quoted historical narratives, the "alpha default-on policy" boilerplate, a
 *    both-directions-ambiguous block).
 *  - REAL-TREE test: parses the actual libs/flags/src/types.ts source and asserts
 *    every mismatch found is one of the small, explicitly documented, already-
 *    escalated PENDING_MISMATCHES below — never a silent allowlist: each entry names
 *    its tracking reference and why it isn't auto-resolved. A real-tree mismatch NOT
 *    on this list fails the build (exactly the WI-3855 bug class, caught at commit
 *    time going forward).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  claimedDefault,
  extractDarkFlagKeys,
  findMismatches,
  parseFlagEntries,
  type FlagCommentEntry,
} from './flag-comment-lint';

describe('flag-comment-lint: parser + checker (fixtures)', () => {
  it('parses FLAGS entries with their own preceding comment block', () => {
    const src = `
export const FLAGS = {
  // some rationale spanning
  // two lines. DEFAULT ON.
  ALPHA: "papercusp-alpha",
  // a second entry.
  BETA: "papercusp-beta",
} as const;
`;
    const entries = parseFlagEntries(src);
    expect(entries.map((e) => e.key)).toEqual(['ALPHA', 'BETA']);
    expect(entries[0].value).toBe('papercusp-alpha');
    expect(entries[0].comment).toContain('DEFAULT ON');
    expect(entries[0].comment).toContain('rationale spanning two lines');
  });

  it('extracts DARK_FLAGS keys from the map literal source', () => {
    const src = `
export const DARK_FLAGS: ReadonlyMap<FlagKey, { case: DarkCase; reason: string }> =
  new Map<FlagKey, { case: DarkCase; reason: string }>([
    [FLAGS.ALPHA, { case: 'incomplete', reason: 'not ready' }],
    [FLAGS.GAMMA, { case: 'owner-authority', reason: 'security' }],
  ]);
`;
    expect(extractDarkFlagKeys(src)).toEqual(new Set(['ALPHA', 'GAMMA']));
  });

  it('extracts DARK_FLAGS keys when the tuple key and opening bracket span lines', () => {
    const src = `
export const DARK_FLAGS: ReadonlyMap<FlagKey, { case: DarkCase; reason: string }> =
  new Map<FlagKey, { case: DarkCase; reason: string }>([
    [
      FLAGS.MULTILINE,
      { case: 'owner-authority', reason: 'outward-facing action' },
    ],
  ]);
`;
    expect(extractDarkFlagKeys(src)).toEqual(new Set(['MULTILINE']));
  });

  it('a clean, self-consistent tree (claims agree with DARK_FLAGS) reports zero mismatches', () => {
    const src = `
export const FLAGS = {
  // some feature. DEFAULT ON (finished work never ships dark).
  ALPHA: "papercusp-alpha",
  // unsafe until reviewed. DEFAULT OFF — owner ratifies.
  BETA: "papercusp-beta",
} as const;
export const DARK_FLAGS = new Map([
  [FLAGS.BETA, { case: 'owner-authority', reason: 'unsafe' }],
]);
`;
    const entries = parseFlagEntries(src);
    const dark = extractDarkFlagKeys(src);
    expect(findMismatches(entries, dark)).toEqual([]);
  });

  it('THE CORE CASE: a comment claiming DEFAULT OFF for a flag absent from DARK_FLAGS fails (the exact WI-3855/EI-7230 bug shape)', () => {
    const src = `
export const FLAGS = {
  // this is unsafe until the owner reviews. DEFAULT OFF — auto-closing items is
  // dangerous. Listed in KNOWN_DARK_FLAGS.
  RISKY: "papercusp-risky",
} as const;
export const DARK_FLAGS = new Map([]);
`;
    const entries = parseFlagEntries(src);
    const dark = extractDarkFlagKeys(src);
    const mismatches = findMismatches(entries, dark);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toMatchObject({ key: 'RISKY', value: 'papercusp-risky', kind: 'claims-dark-but-not-listed' });
    expect(mismatches[0].evidence.onEffect).toBe('unknown');
  });

  it('the inverse: a comment claiming DEFAULT ON for a flag that IS in DARK_FLAGS also fails', () => {
    const src = `
export const FLAGS = {
  // graduated already. DEFAULT ON (not in DARK_FLAGS — safe, proven).
  GRADUATED: "papercusp-graduated",
} as const;
export const DARK_FLAGS = new Map([
  [FLAGS.GRADUATED, { case: 'incomplete', reason: 'stale entry, never removed' }],
]);
`;
    const entries = parseFlagEntries(src);
    const dark = extractDarkFlagKeys(src);
    const mismatches = findMismatches(entries, dark);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toMatchObject({ key: 'GRADUATED', value: 'papercusp-graduated', kind: 'claims-light-but-listed-dark' });
  });

  it('does NOT false-positive on a corrected comment that QUOTES its own old, wrong claim (the established WI-3855 correction convention)', () => {
    const src = `
export const FLAGS = {
  // fixed already. DEFAULT ON (WI-3855: this comment's own "DEFAULT OFF ... Listed
  // in KNOWN_DARK_FLAGS" was never actually added to the DARK_FLAGS map, so it
  // silently derived live default-ON).
  FIXED: "papercusp-fixed",
} as const;
export const DARK_FLAGS = new Map([]);
`;
    const entries = parseFlagEntries(src);
    expect(claimedDefault(entries[0])).toBe('on'); // the quoted "DEFAULT OFF" must NOT count
    const dark = extractDarkFlagKeys(src);
    expect(findMismatches(entries, dark)).toEqual([]); // ON, not in DARK_FLAGS — consistent
  });

  it('does NOT false-positive on the "alpha (flags-)default-on (policy)" boilerplate phrase', () => {
    const src = `
export const FLAGS = {
  // a brand-new autonomous role. DEFAULT OFF — DELIBERATE (NOT the alpha
  // flags-default-on policy): ships dark until proven on staging.
  NEWROLE: "papercusp-newrole",
} as const;
export const DARK_FLAGS = new Map([
  [FLAGS.NEWROLE, { case: 'incomplete', reason: 'not yet proven' }],
]);
`;
    const entries = parseFlagEntries(src);
    expect(claimedDefault(entries[0])).toBe('off'); // NOT ambiguous despite the "...default-on..." substring
    const dark = extractDarkFlagKeys(src);
    expect(findMismatches(entries, dark)).toEqual([]); // OFF + listed — consistent
  });

  it('skips (does not assert on) a block with BOTH an unquoted DEFAULT ON and DEFAULT OFF — genuinely ambiguous, precision over recall', () => {
    const src = `
export const FLAGS = {
  // this flag's producer leg is DEFAULT OFF (dark). Its sibling reader leg is a
  // separate flag that is DEFAULT ON (not dark) for a different reason entirely.
  AMBIGUOUS: "papercusp-ambiguous",
} as const;
export const DARK_FLAGS = new Map([]);
`;
    const entries = parseFlagEntries(src);
    expect(claimedDefault(entries[0])).toBeNull();
    const dark = extractDarkFlagKeys(src);
    expect(findMismatches(entries, dark)).toEqual([]); // unclassifiable ⇒ skipped, not failed
  });

  it('an entry with neither DEFAULT ON nor DEFAULT OFF wording is skipped, not asserted on', () => {
    const entry: FlagCommentEntry = { key: 'X', value: 'papercusp-x', comment: 'just a plain description, no claim.' };
    expect(claimedDefault(entry)).toBeNull();
  });

  it('carries branch direction and partition evidence with a mismatch', () => {
    const src = `
export const FLAGS = {
  // DEFAULT OFF — ON narrows reads to the active workspace and guards cross-workspace access.
  // OFF reads the legacy default partition. The workspace partition has 11,730 rows; default has 2,443 rows,
  // with the legacy partition's last write on 2026-06-22.
  PARTITION_GUARD: "papercusp-partition-guard",
} as const;
export const DARK_FLAGS = new Map([]);
`;
    const mismatch = findMismatches(parseFlagEntries(src), extractDarkFlagKeys(src))[0];
    expect(mismatch.evidence).toMatchObject({
      onEffect: 'narrows',
      offEffect: 'unknown',
      partitionSwing: true,
    });
    expect(mismatch.evidence.directionalExcerpts.join(' ')).toContain('ON narrows');
    expect(mismatch.evidence.partitionExcerpts.join(' ')).toContain('11,730 rows');
    expect(mismatch.evidence.partitionExcerpts.join(' ')).toContain('2026-06-22');
  });

  // ── WI-6045: the SECOND claim-of-darkness form ────────────────────────────────────
  // Until this, claimedDefault() keyed only on a literal "DEFAULT OFF". An entry that
  // asserted its darkness purely as membership ("Listed in KNOWN_DARK_FLAGS") classified
  // as null and was SKIPPED — so the guard never even asked the question about it.

  it('THE WI-6045 CASE: a comment claiming darkness ONLY as "Listed in KNOWN_DARK_FLAGS" (no literal DEFAULT OFF) is now classified, not skipped', () => {
    // Verbatim shape of the real PRESENCE_GOSSIP comment that slipped past the guard.
    const src = `
export const FLAGS = {
  // CUTOVER flag: every peer must carry the gossip READER before a
  // writer flips (a gossip-only announcer is invisible to a log-only reader), so it ships
  // dark until both dogfood machines updated; owner flips after a 2-machine verify.
  // Listed in KNOWN_DARK_FLAGS (cutover).
  PRESENCE_GOSSIP: "papercusp-presence-gossip",
} as const;
export const DARK_FLAGS = new Map([]);
`;
    const entries = parseFlagEntries(src);
    // Before WI-6045 this was null (skipped). It must now read as a dark claim.
    expect(claimedDefault(entries[0])).toBe('off');
    const mismatches = findMismatches(entries, extractDarkFlagKeys(src));
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toMatchObject({ key: 'PRESENCE_GOSSIP', kind: 'claims-dark-but-not-listed' });
  });

  it('a membership claim that AGREES with DARK_FLAGS stays consistent (the new rule does not fire on correct entries)', () => {
    const src = `
export const FLAGS = {
  // ships dark until the two-machine proof lands. Listed in KNOWN_DARK_FLAGS (cutover).
  GATED: "papercusp-gated",
} as const;
export const DARK_FLAGS = new Map([
  [FLAGS.GATED, { case: 'cutover', reason: 'awaiting the two-machine proof' }],
]);
`;
    const entries = parseFlagEntries(src);
    expect(claimedDefault(entries[0])).toBe('off');
    expect(findMismatches(entries, extractDarkFlagKeys(src))).toEqual([]);
  });

  // ── EI-18886519654229938 / EI-19360358881224651: the SIXTH claim-of-darkness form ──
  // A "ships dark" narrative claim with NEITHER a literal "DEFAULT OFF" NOR "Listed in
  // DARK_FLAGS" NOR any reversed/verb form — the exact phrasing LEARNING_SLO_SENSORS and
  // GRADUATION_TRACKER both used in the real tree, which slipped past all five prior
  // forms and stayed classified null (skipped) despite being a real mismatch.

  it('THE EI-18886519654229938 CASE: a bare "ships dark until … arming gate closes" claim (no other established form present) is now classified, not skipped', () => {
    // Verbatim shape of the real LEARNING_SLO_SENSORS / GRADUATION_TRACKER comments
    // that slipped past the guard (neither contains "DEFAULT OFF" or "Listed in
    // DARK_FLAGS" anywhere).
    const src = `
export const FLAGS = {
  // five collectors riding the existing watchdog tick. SQL-only, zero LLM spend,
  // no routine of its own — but a breach FILES into the improvements queue, so it
  // ships dark until the plan's P-001 arming gate closes (D-001).
  AUDIT_SENSORS: "papercusp-audit-sensors",
} as const;
export const DARK_FLAGS = new Map([]);
`;
    const entries = parseFlagEntries(src);
    // Before this fix: null (skipped) — none of forms 1-5 match this phrasing at all.
    expect(claimedDefault(entries[0])).toBe('off');
    const mismatches = findMismatches(entries, extractDarkFlagKeys(src));
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toMatchObject({ key: 'AUDIT_SENSORS', kind: 'claims-dark-but-not-listed' });
  });

  it('the bare "ship(s) dark" form also fires when the flag IS correctly in DARK_FLAGS (consistent, no mismatch)', () => {
    const src = `
export const FLAGS = {
  // unreviewed cutover surface, so it ships dark until the owner signs off.
  RISKY_CUTOVER: "papercusp-risky-cutover",
} as const;
export const DARK_FLAGS = new Map([
  [FLAGS.RISKY_CUTOVER, { case: 'owner-authority', reason: 'unreviewed cutover' }],
]);
`;
    const entries = parseFlagEntries(src);
    expect(claimedDefault(entries[0])).toBe('off');
    expect(findMismatches(entries, extractDarkFlagKeys(src))).toEqual([]);
  });

  it('does NOT false-positive on the repo-wide idiom "finished work never ships dark" (a negated principle, not a darkness claim)', () => {
    // Verbatim shape of real entries (INBOX_DURABLE_ESCALATIONS, EPHEMERAL_CADENCE)
    // that cite this idiom as the REASON they are correctly default-ON.
    const src = `
export const FLAGS = {
  // DEFAULT ON (not in DARK_FLAGS — finished work never ships dark): additive,
  // reviewed, and verified live for two weeks with zero incidents.
  GRADUATED_ADDITIVE: "papercusp-graduated-additive",
} as const;
export const DARK_FLAGS = new Map([]);
`;
    const entries = parseFlagEntries(src);
    expect(claimedDefault(entries[0])).toBe('on');
    expect(findMismatches(entries, extractDarkFlagKeys(src))).toEqual([]);
  });

  it('a "ship dark" (singular, third-person-plural subject) OFF-branch description does not wrongly assert when the SAME comment already declares DEFAULT ON (ambiguous both ⇒ skip, not a false mismatch)', () => {
    // Mirrors the real PLATFORM_IMPROVEMENT_LOOPS shape: "DEFAULT ON: … OFF = the
    // Class-C loops ship dark." — describes what happens to OTHER things when OFF,
    // not a claim about THIS flag's own default. Both an ON claim and a dark-ship
    // phrase appear unquoted in one comment, so per rule 3 this stays a SKIP (null),
    // never a false 'off' mismatch.
    const src = `
export const FLAGS = {
  // DEFAULT ON: dev workspaces run the full loop set. OFF = the Class-C loops
  // ship dark.
  LOOP_GATE: "papercusp-loop-gate",
} as const;
export const DARK_FLAGS = new Map([]);
`;
    const entries = parseFlagEntries(src);
    expect(claimedDefault(entries[0])).toBeNull();
    expect(findMismatches(entries, extractDarkFlagKeys(src))).toEqual([]);
  });

  it('does NOT false-positive on the UNQUOTED negative narration "was never actually added to the DARK_FLAGS map"', () => {
    // The precision guard specific to this rule. The repo's correction convention often
    // narrates the map in the NEGATIVE, and unlike the WI-3855 case at the top of this
    // file that narration is NOT always inside quotes — so normalize()'s quote-stripping
    // cannot save us here. Anchoring the pattern on "listed in" is what keeps this green:
    // a looser "mentions DARK_FLAGS" rule would flip this correct, default-ON entry to a
    // bogus 'off' claim and red the build.
    const src = `
export const FLAGS = {
  // DEFAULT ON (WI-3855, 2026-07-11: this comment's own claim was never actually added
  // to the DARK_FLAGS map, so the 2026-06-29 P-011 inversion silently made it live
  // default-ON — confirmed SAFE as-is, not a drive-by flip).
  CORRECTED: "papercusp-corrected",
} as const;
export const DARK_FLAGS = new Map([]);
`;
    const entries = parseFlagEntries(src);
    expect(claimedDefault(entries[0])).toBe('on');
    expect(findMismatches(entries, extractDarkFlagKeys(src))).toEqual([]);
  });
});

describe('flag-comment-lint: the real tree (libs/flags/src/types.ts)', () => {
  const typesSource = readFileSync(join(__dirname, 'types.ts'), 'utf8');
  const entries = parseFlagEntries(typesSource);
  const darkKeys = extractDarkFlagKeys(typesSource);
  const realMismatches = findMismatches(entries, darkKeys);
  const realMismatchKeys = new Set(realMismatches.map((m) => m.key));

  /**
   * KNOWN, ALREADY-ESCALATED pending mismatches — NOT a silent parking lot (mirrors
   * the DARK_FLAGS_REVIEW_BY / DARK_FLAGS_HIGH_WATERMARK hygiene-bounds discipline
   * already used in this file). Every entry here is a flag whose comment says
   * "DEFAULT OFF" but which is currently absent from DARK_FLAGS — i.e. this lint
   * DID catch it — and is being tracked for an OWNER/LEADER ruling rather than
   * unilaterally flipped, because doing so is a live BEHAVIOR change on an
   * auth/partition/autonomy-scoped surface, which is explicitly out of this lint's
   * remit (build the guard; don't unilaterally re-litigate every flag's disposition).
   *
   * Adding a NEW entry here requires a reason + tracking ref, same as DARK_FLAGS
   * itself. REMOVING an entry (because it graduated, or was added to DARK_FLAGS, or
   * its comment was fixed) is always welcome — this list should only shrink.
   */
  // ════════════════════════════════════════════════════════════════════════════════════
  // PENDING_MISMATCHES — EMPTY again as of 2026-09-04. The step-6 "ships dark"
  // detector surfaced two real mismatches on 2026-08-02: LEARNING_SLO_SENSORS
  // (EI-18886519654229938 — stale comment, code was right) and GRADUATION_TRACKER
  // (EI-19360358881224651 — code was wrong; restored to its documented dark default
  // as an owner-authority flag because it files owner-facing graduation reports and
  // has no lane-specific arming decision).
  //
  // The entire PRIOR flag-comment/DARK_FLAGS mismatch backlog was CLEARED: every flag
  // whose comment and DARK_FLAGS membership disagreed had been resolved in the RIGHT
  // direction (verified per flag against the code and the live data — not blanket-
  // "restored"). If this list is empty, the guard below asserts the real tree has ZERO
  // mismatches; a NEW one not on this list fails the build.
  //
  // HOW THE TEN WERE RESOLVED — and why the split matters (the whole finding):
  //  · COMMENT WAS STALE, code was right → comment corrected, NO DARK_FLAGS change (5):
  //      COORD_PER_WORKSPACE, ISSUES_PER_WORKSPACE (completed partition cutovers — 67,468
  //      coord + 11,730 issue rows live in the workspace partition; "restoring the dark
  //      baseline" would have stranded ~79k rows), SCOPED_SUPERUSER_CLAMP, UI_WORKSPACE_GUARD,
  //      ROUTINES_PER_WORKSPACE (guard rails where OFF is the WIDER/less-safe state).
  //  · CODE WAS WRONG, comment was right → added to DARK_FLAGS (4):
  //      MUG_FULL_AUTONOMY (recursive-self-improvement grant; watermark 25→26),
  //      WORKSPACE_COORDINATION (unverified brain re-key held OFF only by a fragile override
  //      row; 26→27), AUTHORITY_RPC_PROTOMUX + AUTHORITY_EVICTION_PROBE (real-hardware-
  //      unverified cross-machine cutovers, no-op on a single box; 27→29).
  //  · FINISHED ADDITIVE WORK → ratified DEFAULT ON, comment corrected (1):
  //      INBOX_DURABLE_ESCALATIONS (resolve wired on every card-exit path; 0 leaks in 2 weeks).
  //
  // 2026-08-02 (EI-18886519654229938, su-5622daef) — the ELEVENTH, resolved the same way as
  // the first five above:
  //  · COMMENT WAS STALE, code was right → comment corrected, NO DARK_FLAGS change (1):
  //      LEARNING_SLO_SENSORS (self-learning-frontier-2026-06-12 D-010 explicitly named this
  //      exact wave-1 zero-spend, SQL-only sensor bank safe-to-arm when the P-001 gate closed
  //      2026-06-13; the comment was simply never updated after that. Live-verified: zero
  //      `learning-slo:*` watchdog findings have ever fired, so it has run quietly and safely
  //      the whole time).
  //
  // ⚠ THE TRAP, recorded so the next reader does not repeat it: this lint reports that a
  // comment and DARK_FLAGS DISAGREE — it CANNOT say WHICH SIDE IS WRONG. The first eight
  // instances were all "comment right, code wrong" (the EI-7230 bug), so every later reader
  // generalised "the comment is always the truth, restore the dark baseline". For FIVE of the
  // ten that was backwards, and following it would have hidden ~79k live rows and relaxed auth
  // enforcement. A mismatch is a QUESTION, not a verdict: read what the flag's ON and OFF
  // branches actually DO, and check the data written under each, before you "restore" anything.
  // WI-4496 tracks teaching the lint to carry that evidence itself; WI-4495 tracks making the
  // watermark stop penalising genuine safety flags. Full write-up:
  // /internal/docs/agent-insights/a-flag-mismatch-is-a-question-not-a-verdict
  //
  // To re-open: add { key, reason: '<why it needs a ruling before it can be resolved> + <ref>' }.
  const PENDING_MISMATCHES: ReadonlyArray<{ key: string; reason: string }> = [];

  it('the pending-allowlist itself stays honest: every listed key is a REAL current mismatch (never a stale/unnecessary entry)', () => {
    const staleAllowlistEntries = PENDING_MISMATCHES.filter((p) => !realMismatchKeys.has(p.key));
    expect(
      staleAllowlistEntries,
      `These PENDING_MISMATCHES entries no longer correspond to an actual comment/DARK_FLAGS ` +
        `disagreement — remove them (the flag graduated, or its comment/DARK_FLAGS membership was ` +
        `already fixed): [${staleAllowlistEntries.map((e) => e.key).join(', ')}]`,
    ).toEqual([]);
  });

  it('every real mismatch is either fixed or on the documented, reasoned pending-allowlist — a NEW, unlisted mismatch fails the build', () => {
    const allowedKeys = new Set(PENDING_MISMATCHES.map((p) => p.key));
    const unlisted = realMismatches.filter((m) => !allowedKeys.has(m.key));
    expect(
      unlisted,
      `A FLAGS entry's own comment disagrees with its DARK_FLAGS membership — the exact WI-3855/` +
        `EI-7230 bug class (a "DEFAULT OFF" claim silently derives default-ON, or vice versa). Either ` +
        `fix the comment to match reality, add/remove the flag from DARK_FLAGS to match the comment, ` +
        `or — if this needs an owner/leader ruling before it can be resolved — add it to ` +
        `PENDING_MISMATCHES in this file with a reason + tracking ref: ` +
        `${JSON.stringify(unlisted, null, 2)}`,
    ).toEqual([]);
  });

  it('sanity: the real tree has at least one flag the parser can classify (the parser is actually running, not vacuously passing)', () => {
    const classified = entries.filter((e) => claimedDefault(e) !== null);
    expect(classified.length).toBeGreaterThan(50);
  });
});
