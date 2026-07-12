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
    expect(mismatches).toEqual([{ key: 'RISKY', value: 'papercusp-risky', kind: 'claims-dark-but-not-listed' }]);
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
    expect(findMismatches(entries, dark)).toEqual([
      { key: 'GRADUATED', value: 'papercusp-graduated', kind: 'claims-light-but-listed-dark' },
    ]);
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
  const PENDING_MISMATCHES: ReadonlyArray<{ key: string; reason: string }> = [
    // The auth/security/partition "SPECIAL CARE" subset from WI-3855 (leader ruling
    // 2026-07-11: "Do NOT change behavior on these. Document only.") — each flag's
    // comment says DEFAULT OFF, none are in DARK_FLAGS, and WI-3855 deliberately left
    // their runtime behavior untouched pending owner ratification rather than
    // guessing on an auth-enforcement/data-partition surface.
    { key: 'SCOPED_SUPERUSER_CLAMP', reason: 'WI-3855 SPECIAL CARE — changes auth enforcement for every superuser session; owner-ratification pending.' },
    { key: 'UI_WORKSPACE_GUARD', reason: 'WI-3855 SPECIAL CARE — workspace-partition guard rail; owner-ratification pending.' },
    { key: 'AUTHORITY_RPC_PROTOMUX', reason: 'WI-3855 SPECIAL CARE — cross-machine lock-authority RPC transport; real-hardware-unverified (P-003), owner-ratification pending.' },
    { key: 'AUTHORITY_EVICTION_PROBE', reason: 'WI-3855 SPECIAL CARE — cross-machine failure-detector eviction; rides the same unverified cross-machine proof as AUTHORITY_RPC_PROTOMUX.' },
    { key: 'COORD_PER_WORKSPACE', reason: 'WI-3855 SPECIAL CARE — already tracked on EI-9769 (unratified coordination-bus partition cutover).' },
    { key: 'ISSUES_PER_WORKSPACE', reason: 'WI-3855 SPECIAL CARE — already tracked on EI-9769 (unratified issues-bus partition cutover).' },
    { key: 'ROUTINES_PER_WORKSPACE', reason: 'WI-3855 SPECIAL CARE — workspace-partition guard rail on the routines table; owner-ratification pending.' },
    { key: 'WORKSPACE_COORDINATION', reason: 'WI-3855 SPECIAL CARE — the shared master gate for workspace-scoped Queen/Scout/Overwatch; currently forced OFF in production via a live harness_shared.operator_flag_overrides row (workspace papercusp-workspace), so the code-level default is safe-but-fragile pending an owner decision to either graduate the comment or add this to DARK_FLAGS outright.' },
    // Found DURING this lint's own build (EI-9826, 2026-07-11/12) — escalated to the
    // fleet leader + owner via coord:send (wake:required) rather than unilaterally
    // resolved, given its severity (removes the last human check on the system
    // widening its own safety ceiling) and that DARK_FLAGS is already AT its
    // watermark (25/25), so fixing it needs either a graduation elsewhere or an
    // explicit watermark raise — an owner-authority call, not this lint's to make.
    { key: 'MUG_FULL_AUTONOMY', reason: 'NEW finding (EI-9826): "OFF by default — DELIBERATE... removes the last human check on the system widening its own ceilings" but absent from DARK_FLAGS, confirmed live-ON via psql (no override in workspace papercusp-workspace). Escalated urgently to su-28637 + owner 2026-07-12; awaiting ruling.' },
    // Lower-severity, not auth/partition/autonomy-scoped, but also not yet confirmed
    // safe-to-graduate the way the 5 comment-only fixes in this same EI-9826 pass
    // were (TEST_COMPLETION_GATE / PER_POT_RELEASE_GATE / MUG_WARM_SESSION /
    // INFERENCE_GATEWAY / OVERWATCH all had an in-file or first-hand-verified
    // graduation condition; this one has neither).
    { key: 'INBOX_DURABLE_ESCALATIONS', reason: 'No in-file graduation evidence found (unlike the 5 flags this same pass fixed) — additive/low-risk (writes an extra durable escalation record alongside an unchanged existing path) but left for owner confirmation rather than assumed safe.' },
  ];

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
