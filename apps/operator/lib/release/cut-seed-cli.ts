/**
 * cut-seed-cli — the release-time seed cutter (plan hive-seed-bundle-2026-07-04
 * P-006). Drives {@link cutHiveSeed} over the CANONICAL dogfood inputs (the
 * owner's checkout + the owner's hive corestore) to produce the seed the
 * installer bundles as a Tauri resource, and prints a SIZE REPORT so a release
 * build can see exactly how much the installer grows.
 *
 * Run (against a QUIESCENT operator — stop it first so the corestore dir is not
 * being written):
 *
 *   PAPERCUSP_ALLOW_DEV_RESTART=1 \
 *   npx tsx apps/operator/lib/release/cut-seed-cli.ts \
 *     --out papercusp-desktop/src-tauri/seed \
 *     --origin https://github.com/Papercusp/papercup \
 *     --encrypt-key-hex <64-hex>            # REQUIRED for the private repo
 *
 * Flags (all optional except where noted):
 *   --out <dir>            seed output dir (default: papercusp-desktop/src-tauri/seed)
 *   --repo <dir>           source checkout (default: the workspace repo root)
 *   --store-dir <dir>      hive corestore dir (default: <root>/.papercusp/<hive>/hyperbee)
 *   --hive <slug>          hive home slug (default: papercusp)
 *   --origin <url>         origin the restored clone re-points at (default: the GitHub repo)
 *   --rev <rev>            git bundle rev selector (default: --all; pass HEAD for a smaller seed — Q-1)
 *   --epoch <n>            cutAtEpoch override (default: resolved from PG if --workspace-id, else 0)
 *   --workspace-id <id>    resolve cutAtEpoch from live hive_settings
 *   --core-keys <hex,hex>  extra admitted member log keys to seed (owner's own log is always included)
 *   --encrypt-key-hex <h>  32-byte hex key to seal the git bundles at rest (env: PAPERCUSP_SEED_KEY_HEX)
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const root = resolveWorkspaceRoot();
  const hive = str(args, 'hive') ?? DEFAULT_HIVE;
  const repo = str(args, 'repo') ?? root;
  const outDir = resolve(str(args, 'out') ?? join(root, 'papercusp-desktop', 'src-tauri', 'seed'));
  const origin = str(args, 'origin') ?? DEFAULT_ORIGIN;
  const rev = str(args, 'rev') ?? '--all';
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
    const keyHex = str(args, 'encrypt-key-hex') ?? process.env.PAPERCUSP_SEED_KEY_HEX;
    let encryption: GitCutSpec['encryption'];
    if (keyHex) {
      const key = Buffer.from(keyHex, 'hex');
      if (key.length !== 32) throw new Error(`--encrypt-key-hex must be 32 bytes (64 hex chars); got ${key.length}`);
      encryption = { key, keyRef: { via: 'seed-key-op', hiveId: hive } };
    } else {
      console.warn(
        '[cut-seed] ⚠ NO encryption key — git bundles will be PLAINTEXT. The dogfood repo is PRIVATE; a real ' +
          'release MUST pass --encrypt-key-hex (or PAPERCUSP_SEED_KEY_HEX). Proceeding UNENCRYPTED (dev/fixture only).',
      );
    }
    git = { sourceRepoDir: repo, originUrl: origin, rev, ...(encryption ? { encryption } : {}) };
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
