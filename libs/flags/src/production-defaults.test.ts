/**
 * production-defaults.test.ts — the "flags default ON" acceptance guard.
 *
 * Repo rule (CLAUDE.md "Feature flags + PostHog"): **new flags DEFAULT TO
 * ENABLED — finished work never ships dark.** Default-OFF is reserved for
 * genuinely incomplete/unsafe work or an explicit owner ask.
 *
 * FLAG-DEFAULT INVERSION (enforce-system-on-generic-work-2026-06-29 P-011):
 * the dark set is no longer held here. It lives in the RUNTIME registry
 * `DARK_FLAGS` (libs/flags/src/types.ts), and `FLAG_DEFAULTS` is DERIVED from
 * it (`!DARK_FLAGS.has(key)`). A newly-registered flag that is NOT in DARK_FLAGS
 * now defaults ON (previously a missing FLAG_DEFAULTS entry was a compile error).
 * This test SOURCES its allowlist from DARK_FLAGS rather than re-declaring it, so
 * "every default-OFF flag has a vetted reason" is true BY CONSTRUCTION; the guards
 * below assert the registry stays a small, reasoned, non-stale, in-bounds set.
 *
 * Pure unit, no env/network (same as types.test.ts).
 */
import { describe, expect, it } from 'vitest';
import {
  ALL_FLAG_KEYS,
  DARK_FLAGS,
  DARK_FLAGS_HIGH_WATERMARK,
  DARK_FLAGS_REVIEW_BY,
  FLAGS,
  FLAG_DEFAULTS,
  type DarkCase,
} from './types';

const VALID_DARK_CASES: ReadonlySet<DarkCase> = new Set<DarkCase>([
  'incomplete',
  'owner-authority',
  'cutover',
  'parked',
]);

/**
 * VALUE-PRESERVATION SNAPSHOT — the safety net for the P-011 inversion.
 *
 * Captured from the PRE-INVERSION hand-written FLAG_DEFAULTS literal on
 * 2026-06-29 (the exact set of keys that resolved to `false` then). The change
 * MUST be strictly value-preserving: the set of flags that resolve default-OFF
 * after the inversion has to be IDENTICAL to this snapshot. These are raw string
 * literals on purpose — an independent pin that does NOT read DARK_FLAGS, so it
 * fails loudly if the derivation ever silently flips a flag.
 */
const PRE_INVERSION_DEFAULT_OFF: ReadonlySet<string> = new Set<string>([
  'papercusp-cloudflare-publish',
  'papercusp-harness-phases',
  'papercusp-design',
  'papercusp-testing',
  'papercusp-open-signup',
  // papercusp-per-hive-release-gate GRADUATED to default-ON 2026-07-03 (D-008 canary
  // met: oddsmith checkpoint green + main FF'd) — removed from this snapshot; the
  // count assertion below dropped from 10 to 9 to match.
  'papercusp-auth-config-overrides',
  'papercusp-external-bench',
  'papercusp-test-completion-gate',
  // Added AFTER the snapshot (deliberate new dark flags, not inversion drift):
  // 2026-07-01 — presence-off-log gossip cutover (cross-machine-coord-parity
  // P-004 D-008): every hive peer must carry the gossip READER before a writer
  // flips, so it ships dark until the 2-machine verify.
  'papercusp-presence-gossip',
  // papercusp-queen-warm-session GRADUATED to default-ON 2026-07-02 (owner flip
  // directive — see libs/flags/src/types.ts DARK_FLAGS) — removed from this
  // snapshot; the count assertion below dropped from 11 to 10 to match.
]);

// DARK_FLAGS_REVIEW_BY (the re-review deadline) and DARK_FLAGS_HIGH_WATERMARK (the
// size ceiling) are now PROMOTED into shippable code (libs/flags/src/types.ts) so the
// operator dark-flag-age watchdog (P-013) reasons over the same numbers this guard
// asserts against. Imported above; the assertions below are unchanged. The review-by is
// still the "expiry" that stops a dark flag lingering silently — past it the test below
// goes red; treat that as "do the review," not "bump the date" (the bump is the LAST step).

describe('production flag defaults (CLAUDE.md: new flags DEFAULT TO ENABLED)', () => {
  it('every flag defaults ON unless consciously registered in DARK_FLAGS', () => {
    // With the P-011 inversion FLAG_DEFAULTS is DERIVED (`!DARK_FLAGS.has(key)`),
    // so this holds by construction — but the assert documents the contract and
    // catches any future hand-edit that re-introduces a default-OFF literal.
    const offenders = ALL_FLAG_KEYS.filter(
      (key) => FLAG_DEFAULTS[key] === false && !DARK_FLAGS.has(key),
    );
    expect(
      offenders,
      `New flags DEFAULT TO ENABLED — finished work never ships dark (CLAUDE.md "Feature flags + PostHog"). ` +
        `These flags resolve to false without being in DARK_FLAGS: [${offenders.join(', ')}]. ` +
        `Either ship the flag enabled (the default — add nothing) or — only for genuinely ` +
        `incomplete/unsafe work — consciously add it to DARK_FLAGS in libs/flags/src/types.ts ` +
        `with a case + reason, and surface the pending flip in the plan's "## Now" + your report.`,
    ).toEqual([]);
  });

  it('DARK_FLAGS covers EXACTLY the default-OFF set (reason guaranteed by construction)', () => {
    // Both directions: every default-OFF flag is registered (has a reason), and
    // every registered dark flag actually defaults false (no stale entry that has
    // since flipped ON). Replaces the old separate "allowlist not stale" guard.
    const defaultOff = ALL_FLAG_KEYS.filter((key) => FLAG_DEFAULTS[key] === false).sort();
    const registered = [...DARK_FLAGS.keys()].sort();
    expect(defaultOff, 'the derived default-OFF set must equal DARK_FLAGS exactly').toEqual(registered);
  });

  it('every DARK_FLAGS entry is a real registered flag key with a valid case + reason', () => {
    const known = new Set<string>(ALL_FLAG_KEYS);
    for (const [key, info] of DARK_FLAGS) {
      expect(known.has(key), `DARK_FLAGS contains unregistered key "${key}"`).toBe(true);
      // The DarkCase TYPE already rejects an invalid reason at compile time; this is
      // belt-and-suspenders for the runtime shape. There is deliberately NO "finished,
      // owner flips after verifying" case — finished + tested ⇒ ship ON (flip in-task).
      expect(VALID_DARK_CASES.has(info.case), `DARK_FLAGS["${key}"] has invalid case "${info.case}"`).toBe(true);
      expect(info.reason.trim().length, `DARK_FLAGS["${key}"] needs a non-empty reason`).toBeGreaterThan(0);
    }
  });

  it('the dark allowlist is not past its review-by date (no silent lingering)', () => {
    // The default-on policy only "sticks" if a dark flag can't sit forever. Past
    // DARK_FLAGS_REVIEW_BY this fails — the team re-reviews EVERY dark flag, flips
    // the ones now ready, and ONLY THEN pushes the date out for what must stay dark.
    const reviewBy = Date.parse(DARK_FLAGS_REVIEW_BY);
    expect(Number.isNaN(reviewBy), 'DARK_FLAGS_REVIEW_BY must be a valid ISO date').toBe(false);
    expect(
      Date.now() <= reviewBy,
      `The DARK_FLAGS allowlist is past its review-by (${DARK_FLAGS_REVIEW_BY}). ` +
        `Walk every dark flag in libs/flags/src/types.ts: flip the ones now ready to default-ON ` +
        `(remove them from DARK_FLAGS), then push DARK_FLAGS_REVIEW_BY out with a fresh look. ` +
        `Don't just bump the date — the review is the point.`,
    ).toBe(true);
  });

  it('the dark allowlist only ever SHRINKS — agents may not reconstruct it (owner mandate 2026-06-23)', () => {
    // ANTI-RECONSTRUCTION GUARD (owner-directed, plan flip-dark-flags-default-on-2026-06-23): the
    // allowlist was being abused as a PARKING LOT — finished work left default-OFF "to be safe"
    // because flipping it on made agents uncomfortable. After the owner's flags-default-ON sweep the
    // dark set stands at the high-watermark below and may ONLY SHRINK. Adding a new dark flag FAILS
    // here: ship finished work default-ON, or — for genuinely incomplete/unsafe NEW work — graduate
    // an existing dark flag first (net-zero), or get EXPLICIT owner sign-off to raise the watermark.
    // Growth must be a deliberate, owner-visible act, never a quiet append.
    // (DARK_FLAGS_HIGH_WATERMARK now lives in libs/flags/src/types.ts — imported above.)
    expect(
      DARK_FLAGS.size <= DARK_FLAGS_HIGH_WATERMARK,
      `The dark allowlist GREW to ${DARK_FLAGS.size} (high-watermark ${DARK_FLAGS_HIGH_WATERMARK}). ` +
        `Do NOT reconstruct the parking lot: ship finished work default-ON, or graduate an existing ` +
        `dark flag to make room. Raising DARK_FLAGS_HIGH_WATERMARK needs explicit owner sign-off.`,
    ).toBe(true);
  });

  it('VALUE-PRESERVING: the derived FLAG_DEFAULTS matches the pre-inversion snapshot for EVERY flag', () => {
    // The P-011 inversion MUST NOT silently flip any flag. For every registered FlagKey, the
    // derived default must equal the pre-inversion value (false iff in the captured snapshot).
    const mismatches: string[] = [];
    for (const key of ALL_FLAG_KEYS) {
      const expected = !PRE_INVERSION_DEFAULT_OFF.has(key);
      if (FLAG_DEFAULTS[key] !== expected) {
        mismatches.push(`${key}: was ${expected} now ${FLAG_DEFAULTS[key]}`);
      }
    }
    expect(
      mismatches,
      `FLAG-DEFAULT INVERSION changed an effective default — it must be strictly value-preserving: ` +
        `[${mismatches.join('; ')}]`,
    ).toEqual([]);

    // And the snapshot itself must reference only real flags (no stale literal that drifted out of FLAGS).
    const known = new Set<string>(ALL_FLAG_KEYS);
    const orphanSnapshot = [...PRE_INVERSION_DEFAULT_OFF].filter((k) => !known.has(k));
    expect(orphanSnapshot, `PRE_INVERSION_DEFAULT_OFF references unregistered flag(s)`).toEqual([]);
  });

  it('the default-OFF COUNT matches the snapshot (9 pre-inversion + deliberate additions)', () => {
    const offCount = ALL_FLAG_KEYS.filter((k) => FLAG_DEFAULTS[k] === false).length;
    expect(offCount).toBe(PRE_INVERSION_DEFAULT_OFF.size);
    // 9 pre-inversion + papercusp-presence-gossip (2026-07-01 cutover). Graduated to
    // default-ON and removed from the snapshot: papercusp-queen-warm-session (2026-07-02,
    // owner flip directive), papercusp-per-hive-release-gate (2026-07-03, D-008 canary met).
    expect(offCount).toBe(9);
  });

  it('sanity: the four cut-for-V1 flags + the two owner-authority security flags are still dark', () => {
    // A coarse human-readable cross-check on top of the snapshot equality above.
    for (const key of [FLAGS.CLOUDFLARE_PUBLISH, FLAGS.HARNESS_PHASES, FLAGS.DESIGN, FLAGS.TESTING]) {
      expect(DARK_FLAGS.get(key)?.case).toBe('parked');
      expect(FLAG_DEFAULTS[key]).toBe(false);
    }
    expect(DARK_FLAGS.get(FLAGS.OPEN_SIGNUP)?.case).toBe('owner-authority');
    expect(DARK_FLAGS.get(FLAGS.AUTH_CONFIG_OVERRIDES)?.case).toBe('owner-authority');
  });

  it('P2P + GITHUB_BRIDGE ship default-ON with STRUCTURAL inertness (FS-D5) — never dark', () => {
    // p2p-work-distribution-2026-07-02 P-005 / FS-D5 (plan decision D-019): the P2P
    // work-sharing surface follows the landed GITHUB_BRIDGE pattern — the flag is the
    // FLEET-WIDE kill-switch (default-ON), and activation is the REAL surface (explicit
    // P-001 grants + host opt-in, zero/empty by default per M11). Inertness is STRUCTURAL,
    // so NEITHER flag may carry a DARK_FLAGS entry. This pins the rollout decision against
    // a future "let me dark-ship P2P to be safe" edit — which FS-D5 explicitly forbids
    // (a dark entry would also trip the shrink-only high-watermark guard above).
    for (const key of [FLAGS.P2P, FLAGS.GITHUB_BRIDGE]) {
      expect(FLAG_DEFAULTS[key], `${key} must default ON (fleet kill-switch, not dark)`).toBe(true);
      expect(DARK_FLAGS.has(key), `${key} must NOT be in DARK_FLAGS — inertness is structural (FS-D5)`).toBe(false);
    }
  });
});
