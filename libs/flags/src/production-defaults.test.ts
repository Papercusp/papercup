/**
 * production-defaults.test.ts — the "flags default ON" acceptance guard.
 *
 * Repo rule (CLAUDE.md "Feature flags + PostHog"): **new flags DEFAULT TO
 * ENABLED — finished work never ships dark.** Default-OFF is reserved for
 * genuinely incomplete/unsafe work or an explicit owner ask.
 *
 * This test enforces that rule mechanically: every key in FLAG_DEFAULTS must
 * default `true` UNLESS it is consciously listed in KNOWN_DARK_FLAGS below.
 * Adding a new flag with default `false` trips the test — the author must
 * either ship it enabled or add it to the allowlist here with a comment
 * saying why it must ship dark. Flipping an allowlisted flag ON later trips
 * the staleness check, so the allowlist can only shrink to match reality.
 *
 * Pure unit, no env/network (same as types.test.ts).
 */
import { describe, expect, it } from 'vitest';
import { ALL_FLAG_KEYS, FLAGS, FLAG_DEFAULTS, type FlagKey } from './types';

/**
 * The consciously-dark set, vetted against FLAG_DEFAULTS as of 2026-06-10.
 * Every entry needs a justification comment. Remove the entry when the flag
 * flips to default-ON.
 */
const KNOWN_DARK_FLAGS: ReadonlySet<FlagKey> = new Set<FlagKey>([
  // ── Cut-for-V1 surfaces (types.test.ts pins these off too) ─────────────
  FLAGS.CLOUDFLARE_PUBLISH, // cut for V1 — publish surface not shipping
  FLAGS.HARNESS_PHASES, // cut for V1
  FLAGS.DESIGN, // cut for V1
  FLAGS.TESTING, // cut for V1

  // ── Genuinely incomplete/unsafe work (per the FLAG_DEFAULTS comments) ──
  // inbox-cards-unification Phase D (P-031): durable-escalation mirror of
  // chat decision cards is still building; the live ctx.askUser path is
  // unchanged with this off.
  FLAGS.INBOX_DURABLE_ESCALATIONS,
  // papercusp-self-improvement-loop Phase 3 master switch: auto-IMPLEMENTING
  // captured improvements only begins once the owner flips it (capture +
  // triage run regardless).
  FLAGS.IMPROVEMENT_AUTO_IMPLEMENT,
  // hive-inference-gateway P-012: DELIBERATE dark ship — enabling reroutes
  // every bee's inference auth through a gateway service that must be
  // deployed first; flipping early would break the whole fleet's auth.
  FLAGS.INFERENCE_GATEWAY,
]);

describe('production flag defaults (CLAUDE.md: new flags DEFAULT TO ENABLED)', () => {
  it('every flag defaults ON unless consciously allowlisted as dark', () => {
    const offenders = ALL_FLAG_KEYS.filter(
      (key) => FLAG_DEFAULTS[key] === false && !KNOWN_DARK_FLAGS.has(key),
    );
    expect(
      offenders,
      `New flags DEFAULT TO ENABLED — finished work never ships dark (CLAUDE.md "Feature flags + PostHog"). ` +
        `These flags default to false without being allowlisted: [${offenders.join(', ')}]. ` +
        `Either ship the flag enabled (default true in FLAG_DEFAULTS) or — only for genuinely ` +
        `incomplete/unsafe work — consciously add it to KNOWN_DARK_FLAGS in ` +
        `libs/flags/src/production-defaults.test.ts with a comment justifying the dark ship, ` +
        `and surface the pending flip in the plan's "## Now" + your completion report.`,
    ).toEqual([]);
  });

  it('the dark allowlist is not stale (every entry still defaults false)', () => {
    // When a dark flag flips ON, its allowlist entry must be removed — the
    // allowlist documents the CURRENT dark set, not a historical one.
    const stale = [...KNOWN_DARK_FLAGS].filter((key) => FLAG_DEFAULTS[key] !== false);
    expect(
      stale,
      `These KNOWN_DARK_FLAGS entries no longer default to false — remove them from the ` +
        `allowlist in libs/flags/src/production-defaults.test.ts: [${stale.join(', ')}]`,
    ).toEqual([]);
  });

  it('every allowlisted dark flag is a real registered flag key', () => {
    const known = new Set<string>(ALL_FLAG_KEYS);
    for (const key of KNOWN_DARK_FLAGS) {
      expect(known.has(key), `KNOWN_DARK_FLAGS contains unregistered key "${key}"`).toBe(true);
    }
  });
});
