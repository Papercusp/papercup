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
 *   --store-dir <dir>      hive corestore dir (default: <root>/.papercusp/<hive>/hyperbee)
 *   --hive <slug>          hive home slug (default: papercusp)
 *   --origin <url>         origin the restored clone re-points at (default: the GitHub repo)
 *   --rev <rev>            git bundle rev selector (default: HEAD — current branch only, self-contained &
 *                          offline-cloneable; pass --all to seed every ref).
 *   --depth <n>            currently only `1`: cut an offline-cloneable one-commit snapshot of --rev instead
 *                          of full reachable history. Normal first-boot fetch back-fills history from origin.
 *   --shallow              alias for --depth 1 (the release default used by build scripts).
 *   --epoch <n>            cutAtEpoch override (default: resolved from PG if --workspace-id, else 0)
 *   --workspace-id <id>    SHIPPING seal: resolve cutAtEpoch from live hive_settings + seal via=epoch
 *   --core-keys <hex,hex>  extra admitted member log keys to seed (owner's own log is always included)
 *   --encrypt-key-hex <h>  FIXTURE ONLY (via=seed-key-op, no joiner delivery): 32-byte hex to seal the
 *                          git bundles at rest (env: PAPERCUSP_SEED_KEY_HEX) — never for a real release
 *   --no-git               skip the code half (hive-state-only seed)
 *   --no-corestore         skip the federated-state half (code-only seed)
 *   --json                 print the manifest + size report as JSON
 */

import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rm } from 'node:fs/promises';
import Corestore from 'corestore';
import {
  cutHiveSeed,
  enumerateOwnStoreCoreKeys,
  formatBytes,
  type GitCutSpec,
  type CorestoreCutSpec,
} from '@papercusp/operator-core/lib/sync/hyperbee/seed-cutter';
import { stampOpHlc } from '@papercusp/operator-core/lib/sync/hyperbee/hlc-stamp';
import { getHiveEpoch } from '@papercusp/operator-core/lib/sync/hyperbee/hive-epoch-state';
import { resolveHiveEpochCrypto } from '@papercusp/operator-core/lib/sync/hyperbee/hive-epoch-serving';
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
  const storeDir = str(args, 'store-dir') ?? join(root, '.papercusp', hive, 'hyperbee');
  const wantGit = args['no-git'] !== true;
  const wantCorestore = args['no-corestore'] !== true;
  const asJson = args['json'] === true;

  if (!wantGit && !wantCorestore) {
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

  const cutTs = Date.now();
  const cutHlc = stampOpHlc({ ts: cutTs }).hlc;

  // --- git half ---
  let git: GitCutSpec | null = null;
  if (wantGit) {
    const encryption = await pickGitEncryption({
      keyHex: str(args, 'encrypt-key-hex') ?? process.env.PAPERCUSP_SEED_KEY_HEX,
      workspaceId,
      epochProvided: str(args, 'epoch') !== undefined,
      hive,
      cutAtEpoch,
      // Lazily resolve the crypto ONLY on the epoch path (keyHex/plaintext never touch it).
      deriveEpochKey: async (h, e) => (await resolveHiveEpochCrypto(true)).deriveEpochKey(h, e),
      warn: (m) => console.warn(m),
    });
    git = { sourceRepoDir: repo, originUrl: origin, rev, ...(depth !== undefined ? { depth } : {}), ...(encryption ? { encryption } : {}) };
  }

  // --- corestore (federated hive state) half ---
  let corestore: CorestoreCutSpec | null = null;
  let store: Corestore | undefined;
  if (wantCorestore) {
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

  // Fresh output dir (providers write into subdirs; a stale seed would poison the hash).
  await rm(outDir, { recursive: true, force: true });

  try {
    const res = await cutHiveSeed({ hiveId: hive, cutAtEpoch, cutHlc, cutTs, outDir, git, corestore });
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
