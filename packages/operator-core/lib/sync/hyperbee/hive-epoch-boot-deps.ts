/**
 * hive-epoch-boot-deps — the boot-scope COMPOSITION of the read-plane re-key apply/capture
 * deps (shared-hive-rekey-2026-06-19, K's lane / su-ee7e9). ONE call builds the crypto +
 * provider + owner|member key resolver + pending buffer + the decrypt gate / encrypt
 * capability — OR returns null when the re-key is not active for this harness. The two
 * thread sites stay one-liners:
 *   - boot.ts (decrypt gate → mergeOpts.applyImpl): `rekeyDeps ? rekeyDeps.epochGate(enforcedApply) : enforcedApply`.
 *   - wire-outbox.ts (encrypt capability → startOutboxDrain): `{ epochEncrypt: rekeyDeps?.epochEncrypt }`.
 *
 * CHEAP OFF-PATH (7dcd8's contract): `wireOutboxForHarness` runs for EVERY harness at boot,
 * most non-hive — so the FLAG is checked first (one cached read; default-off returns null
 * immediately, byte-for-byte today's behavior), and the LocalDevice / crypto / keychain are
 * touched ONLY for an active re-key hive. Call it ONCE per boot (328af invariant 2); store
 * the result in a boot-scope var both sites reference.
 *
 * This owns the "first real LocalDevice" build (the same device keypair the announce uses:
 * resolveLocalGithubIdentity → resolveDeviceKeychainId → loadOrGenerateDeviceKeypair), so
 * the unknown lives in one tested place. Pure composition of already-unit-tested components
 * (the gate/resolver/provider/buffer).
 */
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import { createEpochKeyProvider } from './hive-epoch-key-provider';
import { createPgWrappedKeyLoader } from './hive-epoch-keys-store';
import { resolveHiveEpochCrypto } from './hive-epoch-serving';
import { getHiveEpoch } from './hive-epoch-state';
import { PendingEpochContent } from './pending-epoch-content';
import { isCanonicalHiveOwner } from '../../hive-identity';
import { hiveHomeSlugForHarness } from '../../hive-federation';
import { resolveDeviceKeychainId } from '../../identity/device-keychain-id';
import { loadOrGenerateDeviceKeypair } from '../../identity/attest';
import {
  buildEpochKeyResolver,
  buildEpochDecryptGate,
  buildEpochEncryptCapability,
} from './hive-epoch-op-gate';
import { recordBootEvent, type BootHistoryKind } from './boot-history';
import type { OpEnvelope } from './op-envelope-types';
import type { EpochEncryptCapability } from './outbox-drain';

export interface HiveRekeyBootDeps {
  /** The Hive home slug (= hiveId) — also what the drain hook keys `pending.drainEpoch` on. */
  hiveHomeSlug: string;
  /** Wrap the per-pass enforcement stack OUTERMOST: `applyImpl = epochGate(enforcedApply)`. */
  epochGate: (inner: (op: OpEnvelope) => Promise<boolean>) => (op: OpEnvelope) => Promise<boolean>;
  /** Inject into `startOutboxDrain({ epochEncrypt })`. */
  epochEncrypt: EpochEncryptCapability;
  /** The shared deferral buffer — the drain hook (`onEpochKeyApplied`) calls `drainEpoch`. */
  pending: PendingEpochContent;
}

/**
 * Build the re-key apply/capture deps for a harness boot, or null when the re-key is NOT
 * active for it (flag off / not a hive / no local device identity). undefined-equivalent
 * (null) ⇒ the callers do today's plaintext path, byte-for-byte.
 */
export async function buildHiveRekeyBootDeps(opts: {
  workspaceId: string;
  harnessSlug: string;
}): Promise<HiveRekeyBootDeps | null> {
  // 1. Flag FIRST — the cheapest off-path (cached read). Default-off ⇒ null ⇒ unchanged.
  if (!(await getFlag(FLAGS.HIVE_REKEY, 'system'))) return null;
  // Steps 2-4 are wrapped fail-open (WI-755): this whole composition is BEST-EFFORT by
  // contract (see the docstring above — null always means "callers do today's plaintext
  // path, byte-for-byte"), so any resolution hiccup along the way — a transient PG error,
  // a harness-composition-rig test scope that doesn't wire a cell around this boot-time
  // call the way it does per-op cell-scoped calls, a missing local device identity —
  // degrades to null rather than failing the whole harness boot. This mirrors the
  // `ownHiveHomeSlug` resolution immediately above this function's boot.ts call site,
  // which wraps the SAME `hiveHomeSlugForHarness` call in an identical fail-open try/catch
  // for the identical reason.
  try {
    // 2. The re-key applies only to a hive harness.
    const hiveHomeSlug = await hiveHomeSlugForHarness(opts.workspaceId, opts.harnessSlug);
    if (!hiveHomeSlug) return null;
    // 3. This device's identity — the FIRST real LocalDevice (same keypair the announce uses).
    //    No local GitHub identity ⇒ cannot build a device ⇒ no re-key on this box.
    const { resolveLocalGithubIdentity } = await import('../../identity/resolve-local-github-identity');
    const ident = await resolveLocalGithubIdentity();
    if (ident.kind !== 'ok') return null;
    const localDevice = await loadOrGenerateDeviceKeypair(resolveDeviceKeychainId(ident.githubUserId));
    // 4. Compose the (already unit-tested) crypto / provider / resolver / gate / capability.
    const crypto = await resolveHiveEpochCrypto(true);
    const provider = createEpochKeyProvider(
      crypto,
      createPgWrappedKeyLoader(opts.workspaceId, hiveHomeSlug),
      localDevice,
    );
    const resolveKey = buildEpochKeyResolver({
      crypto,
      provider,
      // WI-1981 wake-#5515: ownership = the held key MATCHES the hive's canonical
      // identity — never mere key presence. A stale divergent file-tier key made a
      // JOINER resolve isOwner=true here and MINT fresh-random epoch keys instead of
      // unwrapping the owner's wrapped rows → permanent mutual epoch_decrypt_fail
      // (proven live tower↔VM 2026-07-03, with NO re-mint of the hive key).
      isOwner: () => isCanonicalHiveOwner(opts.workspaceId, hiveHomeSlug),
    });
    const pending = new PendingEpochContent();
    const epochGate = buildEpochDecryptGate({
      crypto,
      resolveKey,
      hiveId: hiveHomeSlug,
      pending,
      // WI-808: surface the gate's otherwise-silent per-op verdict into boot-history so a
      // joiner content drop names its cause (decrypt-fail vs defer) instead of vanishing.
      onTrace: (phase, detail) =>
        recordBootEvent(opts.workspaceId, opts.harnessSlug, phase as BootHistoryKind, detail),
    });
    const epochEncrypt = buildEpochEncryptCapability({
      crypto,
      resolveKey,
      hiveId: hiveHomeSlug,
      getCurrentEpoch: () => getHiveEpoch(opts.workspaceId, hiveHomeSlug),
    });
    // WI-808: the gate IS installed (applyImpl will be epochGate(enforcedApply)). Records the
    // resolved hiveHomeSlug — which is the AAD `hiveId`, so a decrypt-fail's hive=… can be
    // compared owner↔joiner to confirm/refute the local-slug AAD-mismatch hypothesis.
    recordBootEvent(opts.workspaceId, opts.harnessSlug, 'epoch_gate_built', `hiveHomeSlug=${hiveHomeSlug}`);
    return { hiveHomeSlug, epochGate, epochEncrypt, pending };
  } catch {
    // Fail-open: today's behavior (plaintext path, byte-for-byte) — same silent-catch
    // pattern as `ownHiveHomeSlug`'s `hiveHomeSlugForHarness` call at this function's
    // boot.ts call site (no console.error: a caught, expected-degradation path here
    // must not trip a fail-on-console test harness — WI-755).
    return null;
  }
}
