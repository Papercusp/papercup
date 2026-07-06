/**
 * cut-seed-cli — the release-time seed cutter (plan hive-seed-bundle-2026-07-04
 * P-006). Drives {@link cutHiveSeed} over the CANONICAL dogfood inputs (the
 * owner's checkout + the owner's hive corestore) to produce the seed the
 * installer bundles as a Tauri resource, and prints a SIZE REPORT so a release
 * build can see exactly how much the installer grows.
 *
 * Run — the SHIPPING command — on the OWNER box (the live epoch keychain must be
 * present: the git seal key is the hive epoch key, and deriveEpochKey is
 * get-or-CREATE, so a wrong keychain context mints a divergent key no member can
 * unwrap) against a QUIESCENT operator (stop it first so the corestore dir is not
 * being written):
 *
 *   PAPERCUSP_ALLOW_DEV_RESTART=1 \
 *   npx tsx apps/operator/lib/release/cut-seed-cli.ts \
 *     --out papercusp-desktop/src-tauri/seed \
 *     --origin https://github.com/Papercusp/papercup \
 *     --workspace-id papercusp-workspace    # seal git bundles under the hive epoch key (keyRef via=epoch)
 *
 * ⚠ Pass --workspace-id (or --epoch) for a real release: it seals via=epoch, which
 * a freshly-admitted member decrypts with the epoch key admission delivers (Q-4).
 * --encrypt-key-hex is FIXTURE/manual ONLY (keyRef via=seed-key-op) — there is NO
 * joiner delivery path for it, so a member cannot unwrap it and the git half falls
 * back to a cold clone. Do NOT use --encrypt-key-hex for a shippable seed.
 *
 * Flags (all optional except where noted):
 *   --out <dir>            seed output dir (default: papercusp-desktop/src-tauri/seed)
 *   --repo <dir>           source checkout (default: the workspace repo root)
 *   --store-dir <dir>      hive corestore dir (default: the LIVE per-workspace store
 *                          ~/.papercusp-workspaces/<workspace-id>/.papercusp/<hive>/hyperbee when
 *                          --workspace-id is given, else <root>/.papercusp/<hive>/hyperbee).
 *                          MUST already exist — a missing dir is refused, never created.
 *   --hive <slug>          hive home slug (default: papercusp)
 *   --origin <url>         origin the restored clone re-points at (default: the GitHub repo)
 *   --rev <rev>            git bundle rev selector (default: HEAD — current branch only, self-contained &
 *                          offline-cloneable; pass --all to seed every ref).
 *   --depth <n>            currently only `1`: cut an offline-cloneable one-commit snapshot of --rev instead
 *                          of full reachable history. Normal first-boot fetch back-fills history from origin.
 *                          The RELEASE default is FULL history (owner decision 2026-07-05, option A: "a full
 *                          git bundle along with a snapshot of the shared pot") — depth 1 is the opt-in
 *                          small-installer escape hatch (PAPERCUSP_SEED_DEPTH=1 in the build scripts).
 *   --shallow              alias for --depth 1.
 *   --allow-mint-epoch-key BOOTSTRAP ONLY: skip the load-don't-mint guard and let deriveEpochKey mint a
 *                          fresh epoch key when this box's keychain has no hive identity. Never for the
 *                          canonical hive — a minted key is unwrappable by every admitted member (WI-1981).
 *   --epoch <n>            cutAtEpoch override (default: resolved from PG if --workspace-id, else 0)
 *   --workspace-id <id>    SHIPPING seal: resolve cutAtEpoch from live hive_settings + seal via=epoch
 *   --core-keys <hex,hex>  extra admitted member log keys to seed (owner's own log is always included)
 *   --encrypt-key-hex <h>  FIXTURE ONLY (via=seed-key-op, no joiner delivery): 32-byte hex to seal the
 *                          git bundles at rest (env: PAPERCUSP_SEED_KEY_HEX) — never for a real release
 *   --no-git               skip the code half (hive-state-only seed)
 *   --no-corestore         skip the federated-state half (code-only seed)
 *   --reuse-corestore <dir> WI-3232: graft the ALREADY-CUT corestore from an existing seed dir onto this
 *                          (git-only) cut instead of re-snapshotting the live store. No operator quiesce
 *                          needed (git bundles from the checkout, not the store) — the safe way to re-cut
 *                          FULL-HISTORY git while keeping an earlier corestore snapshot. Same-dir (reuse ==
 *                          --out) is the normal case: the corestore is moved aside across the outDir wipe
 *                          and moved back. Requires the git half (not --no-git); epoch must match.
 *   --emit-epoch-key       WI-3232 (owner "Full pot, plaintext seed", alpha): also write epoch-keys.json
 *                          (the hive epoch key) into the seed so a FRESH packaged install decrypts the pot
 *                          OFFLINE (no admission). Ships the hive READABLE — deliberate, flag-gated. Needs
 *                          an epoch context (--workspace-id or --epoch).
 *   --json                 print the manifest + size report as JSON
 */

import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { rm, readFile, writeFile, rename, cp } from 'node:fs/promises';
import Corestore from 'corestore';
import {
  cutHiveSeed,
  enumerateOwnStoreCoreKeys,
  formatBytes,
  CORESTORE_SUBDIR,
  SEED_MANIFEST_FILE,
  type GitCutSpec,
  type CorestoreCutSpec,
} from '@papercusp/operator-core/lib/sync/hyperbee/seed-cutter';
import { decodeManifest, encodeManifest, type SeedManifest, type SeedStoreEntry } from '@papercusp/seed-bundle';
import { stampOpHlc } from '@papercusp/operator-core/lib/sync/hyperbee/hlc-stamp';
import { getHiveEpoch } from '@papercusp/operator-core/lib/sync/hyperbee/hive-epoch-state';
import { resolveHiveEpochCrypto } from '@papercusp/operator-core/lib/sync/hyperbee/hive-epoch-serving';
import { loadHiveKeyStatus, type HiveKeyStatus } from '@papercusp/operator-core/lib/identity/hive-keypair';
import { papercuspPathForWorkspace } from '@papercusp/operator-core/lib/papercusp-root';
import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';

const DEFAULT_HIVE = 'papercusp';
const DEFAULT_ORIGIN = 'https://github.com/Papercusp/papercup';

export interface PickGitEncryptionInput {
  /** --encrypt-key-hex / PAPERCUSP_SEED_KEY_HEX — an EXPLICIT fixture/manual key. */
  readonly keyHex?: string;
  /** --workspace-id — presence signals a live hive whose epoch we read from PG. */
  readonly workspaceId?: string;
  /** Whether --epoch was passed explicitly (a deliberate epoch context). */
  readonly epochProvided: boolean;
  readonly hive: string;
  readonly cutAtEpoch: number;
  /** The owner's epoch-key resolver (crypto.deriveEpochKey) — injected so the branch
   *  logic unit-tests without the keychain/native crypto. */
  readonly deriveEpochKey: (hiveId: string, epoch: number) => Promise<Uint8Array>;
  readonly warn?: (msg: string) => void;
}

/**
 * Decide how to seal the git bundles (P-010 live-wire 2 completion). Pure branch logic,
 * injected `deriveEpochKey`, so it's headless-testable:
 *
 *   1. `keyHex` given      → FIXTURE/manual mode: seal with that key, keyRef via='seed-key-op'
 *      (a standalone key with NO automatic joiner delivery → a joiner defers + cold-clones
 *      the git half). For manual/test use, not a real release.
 *   2. a DELIBERATE epoch context (`workspaceId` OR explicit `--epoch`) → RELEASE mode: seal
 *      under the hive EPOCH key (keyRef via='epoch'), which a newly-admitted member decrypts
 *      with the epoch key admission delivers (the path the joiner-side deferred-git-restore
 *      trigger resolves). NEVER taken from the bare cutAtEpoch=0 guess, so we can't mint a
 *      divergent key from nothing. ⚠ MUST run on the OWNER box with the live epoch keychain:
 *      deriveEpochKey is get-or-CREATE — a keychain MISS mints a fresh key no member can
 *      unwrap (seed then cold-clones the git half; no data loss).
 *   3. otherwise            → undefined (PLAINTEXT — dev/fixture only, warned).
 */
export async function pickGitEncryption(inp: PickGitEncryptionInput): Promise<GitCutSpec['encryption'] | undefined> {
  const warn = inp.warn ?? (() => {});
  if (inp.keyHex) {
    const key = Buffer.from(inp.keyHex, 'hex');
    if (key.length !== 32) throw new Error(`--encrypt-key-hex must be 32 bytes (64 hex chars); got ${key.length}`);
    warn(
      '[cut-seed] sealed with an EXPLICIT key (keyRef via=seed-key-op) — a joiner has no delivery path for it and ' +
        'will cold-clone the git half. FIXTURE/manual mode; a real release should seal under the epoch key ' +
        '(drop --encrypt-key-hex, pass --workspace-id).',
    );
    return { key: Uint8Array.from(key), keyRef: { via: 'seed-key-op', hiveId: inp.hive } };
  }
  if (inp.workspaceId || inp.epochProvided) {
    const epochKey = Uint8Array.from(await inp.deriveEpochKey(inp.hive, inp.cutAtEpoch));
    if (epochKey.length !== 32) {
      throw new Error(`owner epoch key for (${inp.hive}, epoch ${inp.cutAtEpoch}) is ${epochKey.length}B, expected 32`);
    }
    warn(
      `[cut-seed] git bundles sealed under hive epoch ${inp.cutAtEpoch} (keyRef via=epoch, hive '${inp.hive}'). ` +
        'MUST have run on the OWNER box with the live epoch keychain — a wrong context mints a divergent key no ' +
        'member can unwrap (seed then cold-clones the git half).',
    );
    return { key: epochKey, keyRef: { via: 'epoch', hiveId: inp.hive, epoch: inp.cutAtEpoch } };
  }
  warn(
    '[cut-seed] ⚠ NO encryption key + no --workspace-id/--epoch — git bundles will be PLAINTEXT. The dogfood repo ' +
      'is PRIVATE; a real release MUST pass --workspace-id (seal under the hive epoch key) or --encrypt-key-hex. ' +
      'Proceeding UNENCRYPTED (dev/fixture only).',
  );
  return undefined;
}

/**
 * Load-don't-mint guard (WI-2903 / WI-1981). `deriveEpochKey` is get-or-CREATE:
 * on a box whose keychain does NOT already hold the hive identity, an epoch seal
 * silently MINTS a fresh divergent key that no admitted member can unwrap — the
 * seed ships "sealed" but every joiner falls back to a cold clone. This box
 * (2026-06) already grew one such divergent identity that way.
 *
 * So before an epoch seal we REQUIRE the hive private key to already be loadable
 * (tri-state via loadHiveKeyStatus — a keychain read error fails CLOSED, it is
 * not "no key"). `allowMint` (--allow-mint-epoch-key) is the deliberate escape
 * hatch for bootstrapping a brand-new hive's first seed.
 */
export async function assertEpochSealIdentityPresent(inp: {
  readonly workspaceId: string;
  readonly hive: string;
  readonly allowMint: boolean;
  /** Injected for tests; defaults to the real keychain read. */
  readonly loadStatus?: (workspaceId: string, slug: string) => Promise<HiveKeyStatus>;
  readonly warn?: (msg: string) => void;
}): Promise<void> {
  const warn = inp.warn ?? ((m: string) => console.warn(m));
  const status = await (inp.loadStatus ?? loadHiveKeyStatus)(inp.workspaceId, inp.hive);
  if (status.kind === 'ok') {
    warn(`[cut-seed] hive identity present (pubkey ${status.pubkeyBase64.slice(0, 8)}…) — epoch seal will use the live key.`);
    return;
  }
  if (inp.allowMint) {
    warn(
      `[cut-seed] ⚠ --allow-mint-epoch-key: hive identity ${status.kind === 'error' ? `unreadable (${status.reason})` : 'absent'} — ` +
        'deriveEpochKey WILL mint a fresh key. Only correct when bootstrapping a brand-new hive.',
    );
    return;
  }
  const why =
    status.kind === 'error'
      ? `the keychain read FAILED (${status.reason}) — a key may exist but could not be loaded`
      : 'this box holds NO private key for the hive';
  throw new Error(
    `[cut-seed] REFUSING epoch seal for hive '${inp.hive}' (workspace '${inp.workspaceId}'): ${why}. ` +
      'deriveEpochKey is get-or-CREATE, so proceeding would mint a DIVERGENT epoch key no admitted member can unwrap ' +
      '(WI-1981). Run the cut on the owner box with the live keychain, or pass --allow-mint-epoch-key to bootstrap a new hive.',
  );
}

/** The bundled-epoch-key file (WI-3232). Ships INSIDE the seed dir alongside the
 *  manifest so a fresh packaged install can decrypt the pot OFFLINE (no admission).
 *  Shape: { "<hive>": { "<epoch>": "<base64 32-byte key>" } }. */
export const EPOCH_KEYS_FILE = 'epoch-keys.json';

/** WI-3232 (owner "Full pot, plaintext seed", alpha-authorised): serialize the hive
 *  epoch key so the bundled EpochKeyProvider can unwrap the seed's git bundles AND
 *  the corestore content with NO federation join. Ships the hive READABLE — only
 *  emitted behind the explicit --emit-epoch-key flag. */
export function encodeEpochKeysFile(hive: string, epoch: number, key: Uint8Array): string {
  if (key.length !== 32) throw new Error(`epoch key must be 32 bytes, got ${key.length}`);
  return JSON.stringify({ [hive]: { [String(epoch)]: Buffer.from(key).toString('base64') } }, null, 2) + '\n';
}

/**
 * WI-3232 --reuse-corestore: read the reusable corestore store-entry from an EXISTING
 * seed dir's manifest. Lets a git-only re-cut (e.g. full-history) graft the already-cut
 * corestore back on WITHOUT re-snapshotting the live store — so no operator quiesce is
 * needed (avoids the outage class). Throws if the dir has no manifest, no corestore
 * entry, or no corestore payload on disk. Injected fs for tests.
 */
export async function readReusableCorestore(
  seedDir: string,
  deps: { readManifest?: (p: string) => Promise<string>; exists?: (p: string) => boolean } = {},
): Promise<{ entry: SeedStoreEntry; cutAtEpoch: number }> {
  const readManifest = deps.readManifest ?? ((p: string) => readFile(p, 'utf8'));
  const exists = deps.exists ?? existsSync;
  const manifestPath = join(seedDir, SEED_MANIFEST_FILE);
  if (!exists(manifestPath)) {
    throw new Error(`--reuse-corestore: no ${SEED_MANIFEST_FILE} in ${seedDir} (not a seed dir?)`);
  }
  const manifest = decodeManifest(await readManifest(manifestPath));
  const entry = manifest.stores.find((s) => s.kind === 'corestore');
  if (!entry) {
    throw new Error(`--reuse-corestore: ${join(seedDir, SEED_MANIFEST_FILE)} has no 'corestore' store entry — nothing to reuse`);
  }
  if (!exists(join(seedDir, CORESTORE_SUBDIR))) {
    throw new Error(`--reuse-corestore: manifest lists a corestore but ${join(seedDir, CORESTORE_SUBDIR)} is missing on disk`);
  }
  return { entry, cutAtEpoch: manifest.cutAtEpoch };
}

/** Graft a reused corestore entry onto a git-only cut's manifest (pure — exported for
 *  tests). Refuses to double-add a corestore. */
export function graftCorestoreEntry(gitManifest: SeedManifest, corestoreEntry: SeedStoreEntry): SeedManifest {
  if (gitManifest.stores.some((s) => s.kind === 'corestore')) {
    throw new Error('graftCorestoreEntry: manifest already has a corestore entry');
  }
  return { ...gitManifest, stores: [...gitManifest.stores, corestoreEntry] };
}

/** Move a dir, falling back to copy+remove across filesystems (EXDEV). */
async function moveDir(src: string, dst: string): Promise<void> {
  try {
    await rename(src, dst);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
    await cp(src, dst, { recursive: true });
    await rm(src, { recursive: true, force: true });
  }
}

function resolveWorkspaceRoot(): string {
  // Mirrors role-codex-home.ts. From apps/operator/lib/release → up to the repo root.
  const here = dirname(fileURLToPath(import.meta.url));
  return process.env.PAPERCUSP_WORKSPACE_ROOT || resolve(here, '..', '..', '..', '..');
}

interface Args {
  [k: string]: string | boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function str(args: Args, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' ? v : undefined;
}

export function parseGitDepth(args: Args): number | undefined {
  const raw = str(args, 'depth');
  if (args.shallow === true && raw !== undefined && raw !== '1') {
    throw new Error('--shallow is an alias for --depth 1; do not pass both with different values');
  }
  const value = raw ?? (args.shallow === true ? '1' : undefined);
  if (value === undefined) return undefined;
  const depth = Number(value);
  if (!Number.isInteger(depth) || depth < 1) {
    throw new Error(`--depth must be a positive integer; got ${value}`);
  }
  if (depth !== 1) {
    throw new Error(`--depth currently supports only 1; got ${depth}`);
  }
  return depth;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const root = resolveWorkspaceRoot();
  const hive = str(args, 'hive') ?? DEFAULT_HIVE;
  const repo = str(args, 'repo') ?? root;
  const outDir = resolve(str(args, 'out') ?? join(root, 'papercusp-desktop', 'src-tauri', 'seed'));
  const origin = str(args, 'origin') ?? DEFAULT_ORIGIN;
  // Default to HEAD (current branch). Build scripts add --depth 1 so the release
  // seed is a small offline-cloneable tree snapshot; omit depth for full history.
  const rev = str(args, 'rev') ?? 'HEAD';
  const depth = parseGitDepth(args);
  const wantGit = args['no-git'] !== true;
  // WI-3232 --reuse-corestore: graft an existing corestore instead of cutting a fresh
  // one from the live store (no quiesce). Mutually exclusive with cutting a corestore.
  const reuseCorestoreRaw = str(args, 'reuse-corestore');
  const reuseCorestoreDir = reuseCorestoreRaw ? resolve(reuseCorestoreRaw) : undefined;
  const emitEpochKey = args['emit-epoch-key'] === true;
  const wantCorestore = args['no-corestore'] !== true && !reuseCorestoreDir;
  const asJson = args['json'] === true;

  if (reuseCorestoreDir && args['no-corestore'] === true) {
    throw new Error('--reuse-corestore and --no-corestore are mutually exclusive (reuse IS the corestore source)');
  }
  if (reuseCorestoreDir && !wantGit) {
    throw new Error('--reuse-corestore grafts the corestore onto a FRESH git cut; with --no-git there is nothing new to cut');
  }
  if (!wantGit && !wantCorestore && !reuseCorestoreDir) {
    throw new Error('nothing to cut: both --no-git and --no-corestore given');
  }

  // Epoch: resolve from live hive_settings when a workspace id is given, else
  // default to 0 (the canonical dogfood hive has no boundary bumps — all content
  // is under epoch 0, decryptable by a new member's single epoch-0 key).
  let cutAtEpoch = 0;
  const workspaceId = str(args, 'workspace-id');
  if (str(args, 'epoch') !== undefined) {
    cutAtEpoch = Number(str(args, 'epoch'));
  } else if (workspaceId) {
    cutAtEpoch = await getHiveEpoch(workspaceId, hive);
  } else {
    console.warn('[cut-seed] no --workspace-id/--epoch — defaulting cutAtEpoch=0 (canonical dogfood hive).');
  }

  // WI-3232: read the reusable corestore entry BEFORE any outDir wipe. Refuse an epoch
  // mismatch — a corestore cut at a different epoch would ship inconsistent hive state.
  let reused: { entry: SeedStoreEntry; cutAtEpoch: number } | undefined;
  if (reuseCorestoreDir) {
    reused = await readReusableCorestore(reuseCorestoreDir);
    if (reused.cutAtEpoch !== cutAtEpoch) {
      throw new Error(
        `--reuse-corestore: the reused corestore was cut at epoch ${reused.cutAtEpoch} but this cut resolves epoch ` +
          `${cutAtEpoch} — refusing to mix epochs (pass --epoch ${reused.cutAtEpoch} to match, or re-cut the corestore).`,
      );
    }
  }

  const cutTs = Date.now();
  const cutHlc = stampOpHlc({ ts: cutTs }).hlc;

  // WI-3232 --emit-epoch-key: captured from the git epoch seal when available (no
  // re-derive), else derived on demand in the emit step below.
  let epochKeyForEmit: Uint8Array | undefined;

  // --- git half ---
  let git: GitCutSpec | null = null;
  if (wantGit) {
    const keyHex = str(args, 'encrypt-key-hex') ?? process.env.PAPERCUSP_SEED_KEY_HEX;
    // Load-don't-mint guard BEFORE touching deriveEpochKey (get-or-CREATE).
    if (!keyHex && workspaceId) {
      await assertEpochSealIdentityPresent({
        workspaceId,
        hive,
        allowMint: args['allow-mint-epoch-key'] === true,
      });
    }
    const encryption = await pickGitEncryption({
      keyHex,
      workspaceId,
      epochProvided: str(args, 'epoch') !== undefined,
      hive,
      cutAtEpoch,
      // Lazily resolve the crypto ONLY on the epoch path (keyHex/plaintext never touch it).
      deriveEpochKey: async (h, e) => (await resolveHiveEpochCrypto(true)).deriveEpochKey(h, e),
      warn: (m) => console.warn(m),
    });
    git = { sourceRepoDir: repo, originUrl: origin, rev, ...(depth !== undefined ? { depth } : {}), ...(encryption ? { encryption } : {}) };
    // WI-3232: the epoch seal already derived the hive epoch key — reuse it for
    // --emit-epoch-key rather than deriving twice.
    if (encryption && encryption.keyRef.via === 'epoch') epochKeyForEmit = encryption.key;
  }

  // --- corestore (federated hive state) half ---
  // Store-dir default: the LIVE per-workspace store (~/.papercusp-workspaces/<id>/
  // .papercusp/<hive>/hyperbee) when --workspace-id names one, else the repo-local
  // layout. The repo-relative guess was the WI-2903 trap: on a multi-workspace box
  // it points at empty dev scratch, and `new Corestore()` HAPPILY CREATES an empty
  // store there — a silently-empty seed. Hence the existsSync refusal below.
  const storeDir =
    str(args, 'store-dir') ??
    (workspaceId ? papercuspPathForWorkspace(workspaceId, hive, 'hyperbee') : join(root, '.papercusp', hive, 'hyperbee'));
  let corestore: CorestoreCutSpec | null = null;
  let store: Corestore | undefined;
  if (wantCorestore) {
    if (!existsSync(storeDir)) {
      throw new Error(
        `[cut-seed] corestore dir not found: ${storeDir} — refusing to cut (opening it would CREATE an empty store ` +
          'and ship a silently-empty seed). Pass --store-dir <live hive store> or --no-corestore.',
      );
    }
    store = new Corestore(storeDir);
    await store.ready();
    const own = await enumerateOwnStoreCoreKeys(store);
    const extra = (str(args, 'core-keys') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const coreKeys = [...new Set([...own, ...extra])];
    if (extra.length === 0) {
      console.warn(
        '[cut-seed] seeding the OWNER own-log only (' +
          `${coreKeys.length} core). Additional admitted MEMBER logs require the live admitted set ` +
          '(pass --core-keys or run inside a swarm session — see plan P-007). New members still cold-catch the rest.',
      );
    }
    corestore = { sourceStore: store, coreKeys };
  }

  // WI-3232 --reuse-corestore: preserve the existing corestore across the outDir wipe
  // so the git-only cut can graft it back (no live-store re-snapshot ⇒ no quiesce). The
  // normal case is same-dir (reuse == --out): move the corestore aside then back (instant
  // on one fs). Different-dir: copy from the source AFTER the cut (leaves the source seed
  // intact). The pre-read (readReusableCorestore, above) already validated both exist.
  const sameReuseDir = reuseCorestoreDir !== undefined && resolve(reuseCorestoreDir) === resolve(outDir);
  let stashDir: string | undefined;
  if (reuseCorestoreDir && sameReuseDir) {
    stashDir = join(dirname(outDir), `.seed-corestore-reuse-${cutTs}`);
    await moveDir(join(outDir, CORESTORE_SUBDIR), stashDir);
  }

  // Fresh output dir (providers write into subdirs; a stale seed would poison the hash).
  await rm(outDir, { recursive: true, force: true });

  try {
    const res = await cutHiveSeed({ hiveId: hive, cutAtEpoch, cutHlc, cutTs, outDir, git, corestore });

    // WI-3232: graft the reused corestore back in + merge its manifest entry.
    if (reuseCorestoreDir && reused) {
      const dst = join(outDir, CORESTORE_SUBDIR);
      if (stashDir) await moveDir(stashDir, dst);
      else await cp(join(reuseCorestoreDir, CORESTORE_SUBDIR), dst, { recursive: true });
      const grafted = graftCorestoreEntry(res.manifest, reused.entry);
      await writeFile(res.manifestPath, encodeManifest(grafted));
      console.warn(
        `[cut-seed] reused corestore from ${reuseCorestoreDir} (${formatBytes(reused.entry.sizeBytes)}, no live-store snapshot).`,
      );
    }

    // WI-3232 --emit-epoch-key: write the bundled key so the pot decrypts OFFLINE.
    if (emitEpochKey) {
      let key = epochKeyForEmit;
      if (!key) {
        if (!workspaceId && str(args, 'epoch') === undefined) {
          throw new Error('--emit-epoch-key needs an epoch context — pass --workspace-id (or --epoch).');
        }
        if (workspaceId) {
          await assertEpochSealIdentityPresent({ workspaceId, hive, allowMint: args['allow-mint-epoch-key'] === true });
        }
        key = Uint8Array.from(await (await resolveHiveEpochCrypto(true)).deriveEpochKey(hive, cutAtEpoch));
      }
      await writeFile(join(outDir, EPOCH_KEYS_FILE), encodeEpochKeysFile(hive, cutAtEpoch, key));
      console.warn(
        `[cut-seed] ⚠ WI-3232: wrote ${EPOCH_KEYS_FILE} (hive '${hive}' epoch ${cutAtEpoch}) — the seed is now ` +
          'OFFLINE-DECRYPTABLE (owner-authorised for alpha; the pot ships READABLE).',
      );
    }

    if (asJson) {
      console.log(JSON.stringify({ manifest: res.manifest, sizeReport: res.sizeReport, manifestPath: res.manifestPath }, null, 2));
    } else {
      console.log(`\n=== Hive seed cut → ${outDir} ===`);
      console.log(`hive=${hive} epoch=${cutAtEpoch} hlc=${cutHlc} ts=${cutTs}`);
      for (const s of res.sizeReport.stores) {
        console.log(`  • ${s.kind.padEnd(10)} ${formatBytes(s.sizeBytes).padStart(12)}  (${s.subdir}${s.encrypted ? ', encrypted' : ''})`);
      }
      console.log(`  • ${'manifest'.padEnd(10)} ${formatBytes(res.sizeReport.manifestBytes).padStart(12)}`);
      console.log(`  = ${'TOTAL'.padEnd(10)} ${formatBytes(res.sizeReport.totalBytes).padStart(12)}  ← installer growth`);
      console.log(`\nmanifest: ${res.manifestPath}\n`);
    }
  } finally {
    if (store) await store.close();
  }
}

if (isCliEntry(import.meta.url)) {
  main().catch((e) => {
    console.error('[cut-seed] FAILED:', e instanceof Error ? e.stack ?? e.message : e);
    process.exitCode = 1;
  });
}
