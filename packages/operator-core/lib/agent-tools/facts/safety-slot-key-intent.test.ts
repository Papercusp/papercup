/** WI-2142026 — a key that spells safety-slot intent (`wall-foo`) without the
 *  `slot:` argument gets none of the slot's protection. These cases are the REAL
 *  keys measured in workspace/papercusp-workspace on 2026-09-02, so the detector
 *  is graded against the incident that motivated it rather than against invented
 *  strings that happen to suit it. */
import { describe, expect, it } from 'vitest';
import { DEAD_END_KEY_PREFIX, GUARD_RAIL_KEY_PREFIX, WALL_KEY_PREFIX } from './assert';
import {
  CANONICAL_SLOT_PREFIXES,
  buildSafetySlotIntentWarning,
  detectSafetySlotKeyIntent,
} from './safety-slot-key-intent';

/**
 * The REAL near-miss keys from the measurement — both were cap-evicted while
 * carrying live owner-gated blockers. If the detector stops catching these it has
 * stopped doing the only job it was built for.
 */
const MEASURED_TRUE_POSITIVES = [
  'wall-unified-web-portal-blocked-on-byoc-gates',
  'wall-gmail-pubsub-403-is-sa-iam-grant-not-gcloud-reauth',
];

/**
 * REAL keys from the same scope that merely MENTION a wall. Two of them assert
 * the exact opposite ("is NOT an owner wall"); one is a conclusion about walls in
 * general; two carry the word only as a trailing noun. A detector that fires on
 * these is worse than none — it trains every reader to skip the warning.
 */
const MEASURED_TRUE_NEGATIVES = [
  'auth-401-is-not-an-owner-wall',
  'push-403-is-https-identity-not-owner-wall',
  'cold-loop-refires-into-date-qualified-weekly-wall',
  'claude-capacity-wall',
  'p2p-gate-attestation-two-account-owner-wall',
  'gmail-pubsub-service-account-wall',
  'stable-0017-cut-retry-wall',
];

/**
 * PERMANENT CONTROL — the obvious detector, kept here forever.
 *
 * "Does the key mention a slot word" is what this check would be if nobody had
 * measured it. It is deliberately wrong, and the assertions below prove it is
 * wrong ON THE REAL DATA: it fires on all seven true negatives. Without this
 * control, a future edit that loosened the real detector to a substring match
 * would still pass every positive case and look fine.
 */
function naiveSubstringDetector(key: string): boolean {
  return /wall|dead.?end|guard.?rail/i.test(key);
}

describe('detectSafetySlotKeyIntent', () => {
  it('fires on every measured near-miss key, naming the slot and the repair', () => {
    for (const key of MEASURED_TRUE_POSITIVES) {
      const hit = detectSafetySlotKeyIntent(key);
      expect(hit, `expected a near-miss finding for ${key}`).not.toBeNull();
      expect(hit?.slot).toBe('wall');
      expect(hit?.matchedPrefix).toBe('wall-');
      expect(hit?.suggestedKey).toBe(`wall:${key.slice('wall-'.length)}`);
    }
  });

  it('does NOT fire on measured keys that merely mention a wall', () => {
    for (const key of MEASURED_TRUE_NEGATIVES) {
      expect(detectSafetySlotKeyIntent(key), `false positive on ${key}`).toBeNull();
    }
  });

  it('CONTROL: the naive substring detector fires on every true negative — which is why the leading-token restriction is load-bearing', () => {
    for (const key of MEASURED_TRUE_NEGATIVES) {
      expect(naiveSubstringDetector(key), `control should match ${key}`).toBe(true);
      expect(detectSafetySlotKeyIntent(key)).toBeNull();
    }
  });

  it('CALIBRATION: the naive control also fires on the true positives, so its failure above is specificity, not blindness', () => {
    for (const key of MEASURED_TRUE_POSITIVES) {
      expect(naiveSubstringDetector(key)).toBe(true);
      expect(detectSafetySlotKeyIntent(key)).not.toBeNull();
    }
  });

  it('stays silent when the caller passed an explicit slot — the normalizer owns that path', () => {
    for (const key of MEASURED_TRUE_POSITIVES) {
      expect(detectSafetySlotKeyIntent(key, 'wall')).toBeNull();
    }
    expect(detectSafetySlotKeyIntent('dead-end-approach-x', 'dead-end')).toBeNull();
    expect(detectSafetySlotKeyIntent('guard-rail-do-not-refire', 'guard-rail')).toBeNull();
  });

  it('stays silent on an already-canonical key — that is the case WI-2141838 fixed', () => {
    expect(detectSafetySlotKeyIntent('wall:byoc-gates')).toBeNull();
    expect(detectSafetySlotKeyIntent('dead-end:tried-and-failed')).toBeNull();
    expect(detectSafetySlotKeyIntent('guard-rail:do-not-refire')).toBeNull();
    // The store's prefix checks lowercase the key, so this one is protected too
    // and must not be reported as unprotected.
    expect(detectSafetySlotKeyIntent('WALL:byoc-gates')).toBeNull();
  });

  it('detects dead-end and guard-rail intent, including separator improvisations', () => {
    expect(detectSafetySlotKeyIntent('dead-end-consult-vetting')?.slot).toBe('dead-end');
    expect(detectSafetySlotKeyIntent('deadend_consult_vetting')?.slot).toBe('dead-end');
    expect(detectSafetySlotKeyIntent('dead_end.consult')?.slot).toBe('dead-end');
    expect(detectSafetySlotKeyIntent('guard-rail-no-force-deploy')?.slot).toBe('guard-rail');
    expect(detectSafetySlotKeyIntent('guardrail_no_force_deploy')?.slot).toBe('guard-rail');
  });

  it('suggests the key the normalizer would have produced', () => {
    expect(detectSafetySlotKeyIntent('guardrail_no_force_deploy')?.suggestedKey).toBe(
      'guard-rail:no_force_deploy',
    );
    expect(detectSafetySlotKeyIntent('dead_end.consult')?.suggestedKey).toBe('dead-end:consult');
  });

  it('does not fire on a word that merely STARTS with a slot token', () => {
    // "wall" is a prefix of "walls"/"wallet", but neither is followed by a
    // separator, so neither declares intent.
    expect(detectSafetySlotKeyIntent('walls-of-jericho')).toBeNull();
    expect(detectSafetySlotKeyIntent('wallet-balance-drift')).toBeNull();
    expect(detectSafetySlotKeyIntent('deadended-thread')).toBeNull();
  });

  it('does not fire when the token is the whole key — there is no subject to protect', () => {
    expect(detectSafetySlotKeyIntent('wall-')).toBeNull();
    expect(detectSafetySlotKeyIntent('wall-   ')).toBeNull();
    expect(detectSafetySlotKeyIntent('')).toBeNull();
    expect(detectSafetySlotKeyIntent('   ')).toBeNull();
  });

  it('PINS the canonical prefixes to the store constants the exemption actually tests', () => {
    // This module mirrors the prefixes by value to stay free of the store's db
    // imports. If the store renames one, the mirror goes stale and the
    // already-canonical check silently starts reporting protected keys as
    // unprotected — so the drift fails HERE instead.
    expect(CANONICAL_SLOT_PREFIXES.wall).toBe(WALL_KEY_PREFIX);
    expect(CANONICAL_SLOT_PREFIXES['dead-end']).toBe(DEAD_END_KEY_PREFIX);
    expect(CANONICAL_SLOT_PREFIXES['guard-rail']).toBe(GUARD_RAIL_KEY_PREFIX);
  });
});

describe('buildSafetySlotIntentWarning', () => {
  it('names the slot, the repair key, and why it was not auto-corrected', () => {
    const intent = detectSafetySlotKeyIntent('wall-unified-web-portal-blocked-on-byoc-gates');
    expect(intent).not.toBeNull();
    const warning = buildSafetySlotIntentWarning(intent!);

    expect(warning.slot).toBe('wall');
    expect(warning.suggestedKey).toBe('wall:unified-web-portal-blocked-on-byoc-gates');
    // The actionable half: the exact argument to pass and the key it produces.
    expect(warning.note).toContain("slot:'wall'");
    expect(warning.note).toContain('wall:unified-web-portal-blocked-on-byoc-gates');
    // The half that stops a reader "fixing" it by renaming blindly.
    expect(warning.note).toContain('upsert');
    // The failure mode is silence, and the note has to say so.
    expect(warning.note).toContain('SILENTLY');
  });
});
