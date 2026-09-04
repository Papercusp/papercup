/**
 * hive-git-actor.test.ts — P-203 Leg A: a git-sync hive leg must act as the
 * device its harness's swarm announce/hello carries, never as a separately
 * resolved gh-login device. The two split on the tower (gh=papercupai,
 * announce=aviynw) and every VM→tower dial missed for the pair's whole life.
 *
 * Pure unit test over `pickHiveGitActor`.
 */
import { describe, expect, it } from 'vitest';
import { explainHiveGitActorAbsence, pickHiveGitActor } from './hive-git-actor';

const keychain = (id: number) => `${id}:test-box`;

describe('pickHiveGitActor (P-203 Leg A identity split)', () => {
  it('prefers the booted swarm identity over a DIFFERENT gh-login device', () => {
    // The tower shape: swarm greets as aviynw's device, gh is logged in as papercupai.
    const actor = pickHiveGitActor(
      { devicePubkeyBase64: 'XPAsvso1-aviynw', githubUserId: 1567022, keychainId: '1567022:tower' },
      { githubUserId: 279242982, devicePubkey: 'IXfGu216-papercupai' },
      keychain,
    );
    expect(actor).toEqual({
      githubUserId: 1567022,
      devicePubkey: 'XPAsvso1-aviynw',
      keychainId: '1567022:tower',
      source: 'booted-swarm',
    });
  });

  it('uses the swarm identity even when gh is unauthenticated (identity must not ride on gh reachability)', () => {
    const actor = pickHiveGitActor(
      { devicePubkeyBase64: 'dev', githubUserId: 7, keychainId: '7:box' },
      null,
      keychain,
    );
    expect(actor?.source).toBe('booted-swarm');
    expect(actor?.devicePubkey).toBe('dev');
  });

  it('falls back to the gh-login actor, deriving its keychain, when no swarm identity exists', () => {
    const actor = pickHiveGitActor(null, { githubUserId: 42, devicePubkey: 'gh-dev' }, keychain);
    expect(actor).toEqual({
      githubUserId: 42,
      devicePubkey: 'gh-dev',
      keychainId: '42:test-box',
      source: 'gh-login',
    });
  });

  it('treats a swarm identity with no device or keychain as absent (fallback, not a half-identity)', () => {
    const actor = pickHiveGitActor(
      { devicePubkeyBase64: '', githubUserId: 7, keychainId: '' },
      { githubUserId: 42, devicePubkey: 'gh-dev' },
      keychain,
    );
    expect(actor?.source).toBe('gh-login');
  });

  it('returns null when neither identity exists — nothing to sign or dial as', () => {
    expect(pickHiveGitActor(null, null, keychain)).toBeNull();
    expect(pickHiveGitActor(undefined, undefined, keychain)).toBeNull();
  });
});

/**
 * WI-2142873 — THE INVARIANT: a pot announcement is never signed under an
 * identity that does not serve that pot's topic.
 *
 * The first pass of the fix above satisfied itself with "prefer the booted
 * identity", which is only sound when a missing booted identity means nothing
 * is serving the pot. It does not. The substrate owner and the git-sync routine
 * are routinely separate OS processes and the boot-all registry is
 * process-local, so `booted` came back null in the git-sync process for a
 * reason that says nothing about which device serves the pot — and the code
 * signed as the gh-login device anyway.
 *
 * Measured on the live two-machine rig 2026-09-02: 216 papercusp ref-announces
 * signed as papercupai's `IXfGu216` while the tower served that pot's topic as
 * aviynw's `XPAsvso1`, alongside 387 correctly-signed ones. A peer dials
 * `announcement.device_pubkey`, finds no socket filed under it, and parks — the
 * VM retried one such announcement 48 times across 8.4h and the pot read NOT
 * CONVERGED for 630+ minutes against a bar unreachable by construction.
 *
 * These cases pin the DECISION. The identity's transport (this process's
 * registry, or the owner's advertisement) is covered in
 * substrate-booted-handles-pg.test.ts.
 */
describe('pickHiveGitActor — never signs as a device that does not serve the pot (WI-2142873)', () => {
  // The exact live shape, with the two real devices from the incident.
  const SERVING = {
    devicePubkeyBase64: 'XPAsvso1-aviynw-tower',
    githubUserId: 1567022,
    keychainId: '1567022:tower',
  };
  const NOT_SERVING = { githubUserId: 279242982, devicePubkey: 'IXfGu216-papercupai' };

  it('REFUSES rather than signing as the gh device when the owner holds a handle it could not identify', () => {
    // The regression itself: our registry missed (other process), the owner
    // confirms something IS serving this pot, but its advertisement carried no
    // identity. The gh device is therefore provably not the serving one.
    const actor = pickHiveGitActor(null, NOT_SERVING, keychain, { ownerReportsBooted: true });

    expect(actor).toBeNull();
    // Stated the other way round, because THIS is the property that matters:
    // whatever we return, it is never the non-serving device.
    expect(actor?.devicePubkey).not.toBe(NOT_SERVING.devicePubkey);
    expect(explainHiveGitActorAbsence(null, NOT_SERVING, { ownerReportsBooted: true })).toBe(
      'refused-owner-booted-identity-unavailable',
    );
  });

  it('signs as the SERVING device when the owner supplies its identity across the process split', () => {
    // Same process-local miss, but the owner answered. The identity is the
    // booted swarm identity however it reached us.
    const actor = pickHiveGitActor(SERVING, NOT_SERVING, keychain, { ownerReportsBooted: true });

    expect(actor?.devicePubkey).toBe(SERVING.devicePubkeyBase64);
    expect(actor?.source).toBe('booted-swarm');
  });

  it('keeps the gh fallback when the owner reports NOTHING is serving this pot', () => {
    // Not a regression case: no swarm identity exists anywhere, so the gh actor
    // is the honest best effort rather than a wrong device.
    const actor = pickHiveGitActor(null, NOT_SERVING, keychain, { ownerReportsBooted: false });

    expect(actor?.devicePubkey).toBe(NOT_SERVING.devicePubkey);
    expect(actor?.source).toBe('gh-login');
  });

  it('keeps the gh fallback when the owner could not be asked — UNKNOWN is not a refusal', () => {
    // A PG hiccup or a host with no advertisement must not silence a healthy
    // single-account box, where the two identities coincide anyway.
    expect(pickHiveGitActor(null, NOT_SERVING, keychain, {})?.source).toBe('gh-login');
    expect(
      pickHiveGitActor(null, NOT_SERVING, keychain, { ownerReportsBooted: undefined })?.source,
    ).toBe('gh-login');
    // And the pre-existing 3-arg call site is unchanged by the new parameter.
    expect(pickHiveGitActor(null, NOT_SERVING, keychain)?.source).toBe('gh-login');
  });

  it('treats a half-identity from the owner as no identity, and still refuses', () => {
    // A device with no keychain cannot sign; falling through to gh here would
    // reopen the defect through the half-identity door.
    const actor = pickHiveGitActor(
      { devicePubkeyBase64: 'XPAsvso1-aviynw-tower', githubUserId: 1567022, keychainId: '' },
      NOT_SERVING,
      keychain,
      { ownerReportsBooted: true },
    );

    expect(actor).toBeNull();
  });

  /**
   * FALSIFIABILITY CONTROL — a permanent, deliberately-wrong implementation of
   * the decision, kept in the test file (never a mutation of the shared tree,
   * which git-sync would commit mid-probe).
   *
   * This is the pre-WI-2142873 logic verbatim: prefer booted, else gh, with no
   * notion of what the owner knows. Asserting that it FAILS the invariant is
   * what proves the case above is not vacuously green — without it, a future
   * refactor that quietly drops the `ownerReportsBooted` branch would leave
   * every assertion here still passing for the wrong reason.
   */
  const preFixPick = (
    booted: { devicePubkeyBase64: string; githubUserId: number; keychainId: string } | null,
    ghActor: { githubUserId: number; devicePubkey: string } | null,
  ) => {
    if (booted && booted.devicePubkeyBase64 && booted.keychainId) {
      return { devicePubkey: booted.devicePubkeyBase64, source: 'booted-swarm' as const };
    }
    if (!ghActor?.devicePubkey) return null;
    return { devicePubkey: ghActor.devicePubkey, source: 'gh-login' as const };
  };

  it('CONTROL: the pre-fix decision signs as the non-serving device on the exact same inputs', () => {
    const inputs = { booted: null, gh: NOT_SERVING, evidence: { ownerReportsBooted: true } };

    // The defect, reproduced: it hands back IXfGu216 — a device that does not
    // serve this pot's topic — and the announcement it signs is undialable.
    expect(preFixPick(inputs.booted, inputs.gh)?.devicePubkey).toBe(NOT_SERVING.devicePubkey);

    // The shipped decision refuses on those same inputs. If this ever converges
    // with the control, the guard has been removed.
    expect(pickHiveGitActor(inputs.booted, inputs.gh, keychain, inputs.evidence)).toBeNull();
  });

  it('CONTROL: the pre-fix decision and the shipped one still AGREE where they should', () => {
    // Calibration: the control is only meaningful if it is right about the
    // cases the fix deliberately left alone. A control that fails everything
    // proves nothing.
    expect(preFixPick(SERVING, NOT_SERVING)?.devicePubkey).toBe(SERVING.devicePubkeyBase64);
    expect(pickHiveGitActor(SERVING, NOT_SERVING, keychain, { ownerReportsBooted: true })?.devicePubkey).toBe(
      SERVING.devicePubkeyBase64,
    );

    expect(preFixPick(null, NOT_SERVING)?.devicePubkey).toBe(NOT_SERVING.devicePubkey);
    expect(
      pickHiveGitActor(null, NOT_SERVING, keychain, { ownerReportsBooted: false })?.devicePubkey,
    ).toBe(NOT_SERVING.devicePubkey);
  });

  it('distinguishes a deliberate refusal from a plain absence — they need different repairs', () => {
    // gh unauthenticated AND nothing serving: an absence, not a refusal.
    expect(explainHiveGitActorAbsence(null, null, { ownerReportsBooted: false })).toBe(
      'no-identity',
    );
    expect(explainHiveGitActorAbsence(null, null)).toBe('no-identity');
    // A resolved identity is never reported as a refusal.
    expect(explainHiveGitActorAbsence(SERVING, null, { ownerReportsBooted: true })).toBe(
      'no-identity',
    );
  });
});

/**
 * WI-2142873 follow-on — THE OWNER-RESTART BOOT WINDOW.
 *
 * The first fix refused only when the owner POSITIVELY reported a booted handle
 * (`ownerReportsBooted === true`). But the advertisement's reader nulls out a
 * row older than 30s, which reports UNKNOWN, and UNKNOWN keeps the gh fallback.
 * On the tower one process is BOTH substrate owner and git-sync host, so its own
 * restart guarantees that window — and each pass through it minted exactly one
 * announcement signed under a device that does not serve the pot (measured
 * 2026-09-04: coord_event_log 18359971 at start+32s). Restarts (~1-5h) outran
 * the 500-row announcement window (~12-25h), so the bar never aged out and
 * P-203 Leg A stayed RED with the identity fix already running.
 *
 * The discriminator: a STALE advertisement and a NEVER-MADE one are different
 * facts. Stale is weak evidence about whether that device is still UP, and
 * strong evidence about WHICH device serves the pot.
 */
describe('pickHiveGitActor (stale advertisement during the owner-restart boot window)', () => {
  const SERVING_DEVICE = 'XPAsvso1-aviynw-tower';
  const GH = { githubUserId: 279242982, devicePubkey: 'IXfGu216-papercupai' };

  it('REFUSES when the advertisement is stale but names a DIFFERENT device as serving the pot', () => {
    const actor = pickHiveGitActor(null, GH, keychain, {
      // too old to trust as liveness ⇒ the reader reported UNKNOWN...
      ownerReportsBooted: undefined,
      // ...but it still said WHO serves this pot, and it is not us.
      lastAdvertisedServingDevicePubkey: SERVING_DEVICE,
    });
    expect(actor).toBeNull();
    expect(
      explainHiveGitActorAbsence(null, GH, {
        ownerReportsBooted: undefined,
        lastAdvertisedServingDevicePubkey: SERVING_DEVICE,
      }),
    ).toBe('refused-stale-advertisement-names-another-device');
  });

  it('PRESERVES the gh fallback on a single-account box — nothing was ever advertised', () => {
    // The case the whole guard must not break: no substrate owner has ever
    // named a device for this pot, so the gh actor is the honest best effort.
    const actor = pickHiveGitActor(null, GH, keychain, {
      ownerReportsBooted: undefined,
      lastAdvertisedServingDevicePubkey: undefined,
    });
    expect(actor?.devicePubkey).toBe(GH.devicePubkey);
    expect(actor?.source).toBe('gh-login');
  });

  it('PRESERVES the gh fallback when the stale advertisement names US as the serving device', () => {
    const actor = pickHiveGitActor(null, GH, keychain, {
      ownerReportsBooted: undefined,
      lastAdvertisedServingDevicePubkey: GH.devicePubkey,
    });
    expect(actor?.devicePubkey).toBe(GH.devicePubkey);
    expect(actor?.source).toBe('gh-login');
  });

  it('CONTROL: the same inputs WITHOUT the stale-advertisement evidence still sign — so the guard is what changes the outcome', () => {
    // Calibration for the refusal above: identical booted/gh inputs, minus the
    // one new fact. If this also refused, the test would be proving nothing.
    const actor = pickHiveGitActor(null, GH, keychain, { ownerReportsBooted: undefined });
    expect(actor?.devicePubkey).toBe(GH.devicePubkey);
    expect(actor?.source).toBe('gh-login');
  });

  it('a positively-reported booted handle still outranks the stale-advertisement path', () => {
    // Both refusal reasons can apply at once; the stronger, first-fix one wins
    // so its operator repair (fix the identity plumbing) is the one reported.
    expect(
      explainHiveGitActorAbsence(null, GH, {
        ownerReportsBooted: true,
        lastAdvertisedServingDevicePubkey: SERVING_DEVICE,
      }),
    ).toBe('refused-owner-booted-identity-unavailable');
  });
});
