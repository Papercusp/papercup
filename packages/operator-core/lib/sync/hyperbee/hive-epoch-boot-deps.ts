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
import { createBundledEpochKeyProvider } from './bundled-epoch-key-provider';
import { chainEpochKeyProviders } from './epoch-key-provider-chain';
import { resolveSeedDir } from './restore-hive-seed';
import { resolveHiveEpochCrypto, type EpochKeyProvider } from './hive-epoch-serving';
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
  /** The Hive home slug (= potId) — also what the drain hook keys `pending.drainEpoch` on. */
  hiveHomeSlug: string;
  /** Wrap the per-pass enforcement stack OUTERMOST: `applyImpl = epochGate(enforcedApply)`. */
  epochGate: (inner: (op: OpEnvelope) => Promise<boolean>) => (op: OpEnvelope) => Promise<boolean>;
  /** Inject into `startOutboxDrain({ epochEncrypt })`. */
  epochEncrypt: EpochEncryptCapability;
  /** The shared deferral buffer — the drain hook (`onEpochKeyApplied`) calls `drainEpoch`. */
  pending: PendingEpochContent;
}

/**
 * WI-3232 (offline pot): build the BUNDLED (offline) seed epoch-key provider when a seed
 * ships with this install, else null. Cheap: {@link resolveSeedDir} is an env/path check and
 * the provider reads epoch-keys.json LAZILY (only on first `keyForEpoch`), so attaching it
 * costs nothing until a decrypt actually needs it. Best-effort → null (a missing/unreadable
 * seed dir simply means no bundled fallback). A non-papercusp hive on a seeded install gets a
 * provider whose lookups all miss (its id is not in epoch-keys.json) ⇒ the chain stays
 * effectively member-only for it.
 */
function tryBuildBundledSeedProvider(): EpochKeyProvider | null {
  try {
    const resolved = resolveSeedDir();
    if (resolved.disabled || !resolved.seedDir) return null;
    return createBundledEpochKeyProvider(resolved.seedDir);
  } catch {
    return null;
  }
}

/**
 * Build the re-key apply/capture deps for a harness boot, or null when the re-key is NOT
 * active for it (flag off / not a hive / no key source — neither a local device identity NOR
 * a bundled seed key). undefined-equivalent (null) ⇒ the callers do today's plaintext path,
 * byte-for-byte.
 */
export async function buildHiveRekeyBootDeps(opts: {
  workspaceId: string;
  harnessSlug: string;
}): Promise<HiveRekeyBootDeps | null> {
  // 1. Flag FIRST — the cheapest off-path (cached read). Default-off ⇒ null ⇒ unchanged.
  if (!(await getFlag(FLAGS.HIVE_REKEY, 'system'))) {
    // seed-57-drop diagnostic: this bail is BEFORE the try/dbg below, so it needs its own
    // guarded log — a flag off on the shipped build silently disables the whole decrypt gate.
    if (process.env.PAPERCUSP_EPOCH_BOOT_DEBUG)
      console.error('[epoch-boot]', 'GATE NOT BUILT: FLAGS.HIVE_REKEY off', {
        workspaceId: opts.workspaceId,
        harnessSlug: opts.harnessSlug,
      });
    return null;
  }
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
    // seed-57-drop diagnostic (env-gated, off by default): the gate keys on the
    // workspace-resolved hiveHomeSlug — a fresh packaged install booting under the
    // 'default' workspace while the hive lives in 'papercusp-workspace' resolves null →
    // NO gate → encrypted content never decrypts → only plaintext rows project (the 57).
    // Set PAPERCUSP_EPOCH_BOOT_DEBUG=1 to dump the exact branch to stderr/serve.log.
    const dbg = process.env.PAPERCUSP_EPOCH_BOOT_DEBUG
      ? (msg: string, o?: unknown) => console.error('[epoch-boot]', msg, o ?? '')
      : () => {};
    // 2. The re-key applies only to a hive harness.
    const hiveHomeSlug = await hiveHomeSlugForHarness(opts.workspaceId, opts.harnessSlug);
    dbg('resolved', { workspaceId: opts.workspaceId, harnessSlug: opts.harnessSlug, hiveHomeSlug });
    if (!hiveHomeSlug) {
      dbg('GATE NOT BUILT: hiveHomeSlugForHarness → null (harness not a registered hive in this workspace)');
      return null;
    }
    // WI-3232 (offline pot): a BUNDLED seed epoch key is an OFFLINE key source needing NO
    // device identity / PG-wrapped row. Attached (as the chain's FALLBACK) whenever a seed
    // ships this hive's key, so a fresh NO-ADMISSION install decrypts the restored corestore
    // content through this SAME gate. Null on dev boxes + non-seed installs ⇒ the chain is
    // member-only, byte-for-byte today's behavior.
    const bundledProvider = tryBuildBundledSeedProvider();
    dbg('bundledProvider', { present: bundledProvider != null });

    // 3. This device's identity — the FIRST real LocalDevice (same keypair the announce
    //    uses). No local GitHub identity ⇒ no MEMBER (PG-wrapped) provider on this box; that
    //    is fine ONLY when the bundled seed provider can serve the key (the offline pot).
    const { resolveLocalGithubIdentity } = await import('../../identity/resolve-local-github-identity');
    const ident = await resolveLocalGithubIdentity();
    // No member key source AND no bundled key ⇒ this box can resolve no epoch key; return
    // null so the callers keep today's plaintext path, byte-for-byte (the cheap off-path —
    // no crypto/keychain touched below).
    if (ident.kind !== 'ok' && !bundledProvider) {
      dbg('GATE NOT BUILT: no member identity AND no bundled provider (no epoch-key source)', {
        identKind: ident.kind,
      });
      return null;
    }

    // 4. Compose the (already unit-tested) crypto / provider / resolver / gate / capability.
    const crypto = await resolveHiveEpochCrypto(true);
    let memberProvider: EpochKeyProvider | null = null;
    if (ident.kind === 'ok') {
      const localDevice = await loadOrGenerateDeviceKeypair(resolveDeviceKeychainId(ident.githubUserId));
      // WI-2009 / wake-#5742 (v3 instrumentation, leg a): the SPLIT-IDENTITY class —
      // presence stamps one device pubkey while THIS tier resolves another (an OS
      // keychain unreadable in the service context → a different file-tier key, or a
      // per-boot regenerate). Record what the epoch tier ACTUALLY resolved + which
      // keychain tier(s) hold the id, so a mismatch is diagnosable from boot-history.
      try {
        const { keychainProbeTiers } = await import('../../identity/keychain');
        const tiers = await keychainProbeTiers(localDevice.keychainId);
        recordBootEvent(
          opts.workspaceId,
          opts.harnessSlug,
          'epoch_boot_device' as BootHistoryKind,
          `pubkey=${localDevice.pubkeyBase64} keychainId=${localDevice.keychainId} tiers=secretTool:${tiers.secretTool},securityCli:${tiers.securityCli},file:${tiers.file}`,
        );
      } catch {
        /* diagnostics must never affect boot */
      }
      memberProvider = createEpochKeyProvider(
        crypto,
        createPgWrappedKeyLoader(opts.workspaceId, hiveHomeSlug),
        localDevice,
      );
    }
    // WI-3232: member (federated, all granted epochs) FIRST; bundled seed key (offline,
    // cutAtEpoch) as the fallback — see epoch-key-provider-chain. A one-provider chain is
    // transparent, so an online member with no seed is byte-for-byte unchanged.
    const provider = chainEpochKeyProviders([memberProvider, bundledProvider]);
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
      potId: hiveHomeSlug,
      pending,
      // WI-808: surface the gate's otherwise-silent per-op verdict into boot-history so a
      // joiner content drop names its cause (decrypt-fail vs defer) instead of vanishing.
      onTrace: (phase, detail) =>
        recordBootEvent(opts.workspaceId, opts.harnessSlug, phase as BootHistoryKind, detail),
    });
    const epochEncrypt = buildEpochEncryptCapability({
      crypto,
      resolveKey,
      potId: hiveHomeSlug,
      getCurrentEpoch: () => getHiveEpoch(opts.workspaceId, hiveHomeSlug),
    });
    // WI-808: the gate IS installed (applyImpl will be epochGate(enforcedApply)). Records the
    // resolved hiveHomeSlug — which is the AAD `potId`, so a decrypt-fail's hive=… can be
    // compared owner↔joiner to confirm/refute the local-slug AAD-mismatch hypothesis.
    recordBootEvent(opts.workspaceId, opts.harnessSlug, 'epoch_gate_built', `hiveHomeSlug=${hiveHomeSlug}`);
    // seed-57-drop diagnostic: the SUCCESS path — the gate IS installed. If this prints yet the
    // fold still drops to 57, the bug is DOWNSTREAM of gate-build (resolver key / AAD / opId),
    // not the workspace-context bail; if it does NOT print, the gate never built (bail above).
    dbg('GATE BUILT', {
      hiveHomeSlug,
      memberProvider: memberProvider != null,
      bundledProvider: bundledProvider != null,
    });
    return { hiveHomeSlug, epochGate, epochEncrypt, pending };
  } catch (e) {
    // Fail-open: today's behavior (plaintext path, byte-for-byte) — same silent-catch
    // pattern as `ownHiveHomeSlug`'s `hiveHomeSlugForHarness` call at this function's
    // boot.ts call site (no console.error: a caught, expected-degradation path here
    // must not trip a fail-on-console test harness — WI-755).
    // WI-2009 / wake-#5742 (v3 instrumentation, leg c): the fail-open was fully
    // SILENT — a hive whose re-key deps throw boots PLAINTEXT with no signal,
    // indistinguishable from flag-off (6b811's "no drain attempt at all" boots).
    // Record it in boot-history (not console — WI-755-safe).
    try {
      recordBootEvent(
        opts.workspaceId,
        opts.harnessSlug,
        'epoch_gate_skipped' as BootHistoryKind,
        `buildHiveRekeyBootDeps fail-open: ${e instanceof Error ? e.message : String(e)}`,
      );
    } catch {
      /* best-effort */
    }
    return null;
  }
}

/**
 * Build JUST the member-side EpochKeyProvider for (workspace, hiveHomeSlug) — the
 * device-identity + crypto + provider slice that {@link buildHiveRekeyBootDeps} also
 * composes inline (steps 3–4a). Returns null when this box has no local device
 * identity (⇒ it can unwrap no epoch key). Best-effort: any resolution hiccup ⇒ null,
 * so the caller degrades to a cold path rather than failing.
 *
 * Consumer: the post-admission deferred-git-restore trigger (deferred-git-restore.ts,
 * plan hive-seed-bundle-2026-07-04 P-010) — a git seed sealed with keyRef via='epoch'
 * is decrypted with the hive epoch key at cutAtEpoch, which this provider unwraps from
 * THIS device's `hive_epoch_keys` row (guaranteed present for a fresh member by Q-4 /
 * grantEpochKeysToMembers). Not flag-gated: unlike the re-key gate it does no writes
 * and only READS a key the member already holds. (buildHiveRekeyBootDeps keeps its own
 * inline assembly to avoid churning that boot-critical path; the two could unify later.)
 */
export async function buildMemberEpochKeyProvider(opts: {
  workspaceId: string;
  hiveHomeSlug: string;
}): Promise<EpochKeyProvider | null> {
  try {
    const { resolveLocalGithubIdentity } = await import('../../identity/resolve-local-github-identity');
    const ident = await resolveLocalGithubIdentity();
    if (ident.kind !== 'ok') return null;
    const localDevice = await loadOrGenerateDeviceKeypair(resolveDeviceKeychainId(ident.githubUserId));
    const crypto = await resolveHiveEpochCrypto(true);
    return createEpochKeyProvider(crypto, createPgWrappedKeyLoader(opts.workspaceId, opts.hiveHomeSlug), localDevice);
  } catch {
    return null;
  }
}
