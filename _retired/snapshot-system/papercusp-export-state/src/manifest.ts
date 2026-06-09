/**
 * Snapshot manifest — JSON spec'd in §15.10.
 *
 * Stored as `manifest.json` inside the snapshot tarball. Cap'n-proto
 * typed schema is deferred to v2; v1 uses JSON with strict validation.
 */

import { snapshotId, randomBase32 } from '@papercusp/publish-auth';

/**
 * v2 (rev3 plan G+): adds `runtime`, `versionPin`, `migrationManifest`
 * to SnapshotPlugin so WASM/daemon plugins capture+restore correctly
 * + so snapshot reconciliation can detect schema-migration divergence.
 *
 * Reader supports both v1 and v2 manifests. Writer always emits v2.
 * v1 fields (`pluginVersionPinned`) remain in the type as deprecated
 * for one cycle so existing in-flight tarballs round-trip cleanly.
 */
export const SNAPSHOT_SCHEMA_VERSION = 2 as const;
export const SNAPSHOT_READER_MIN_VERSION = 1 as const;

export type SnapshotKind = 'snapshot';

/**
 * Which runtime the plugin's core executes in. Determines what the
 * restore-side host needs (WASM runtime present, bwrap available, etc.)
 * — see §runtimeRequirements derivation in plugin-reenable.
 *
 * Optional in the type for v1 back-compat; reader defaults to 'js'
 * when absent.
 */
export type SnapshotPluginRuntime = 'js' | 'wasm' | 'daemon';

/**
 * Per-plugin version-pinning policy at capture time. Replaces the v1
 * boolean `pluginVersionPinned` with an explicit mode + escape hatch.
 *
 * Modes:
 *   - 'semver'   — accept any version satisfying the captured semver range.
 *   - 'exact'    — restore must use the exact version string captured.
 *                  v1's `pluginVersionPinned: true` migrates to this.
 *   - 'hash'     — content-addressed (WASM/daemon default). Captured
 *                  artifact's sha256 is the identity. Different binary
 *                  built from same source = different identity.
 *
 * `allowOverride` lets the marketplace flag a published version as
 * superseding-with-security-patch; restore prompts user to switch to
 * the patched version even though the snapshot pins the old one.
 *   - 'security-patch' — only marketplace-flagged security supersedes
 *   - 'always'         — any newer version supersedes (rare; user opt-in)
 *   - 'never'          — strict pinning even through CVE updates
 */
export type SnapshotVersionPinMode = 'semver' | 'exact' | 'hash';
export type SnapshotVersionPinOverride = 'security-patch' | 'always' | 'never';

export interface SnapshotVersionPin {
  mode: SnapshotVersionPinMode;
  /** Defaults to 'security-patch' (sane prod default) when absent. */
  allowOverride?: SnapshotVersionPinOverride;
}

/**
 * Per-migration content-hash record. Lets restore detect divergence
 * (same filename, different content = bad) vs forward-extension
 * (snapshot's list is a strict prefix of installed's list = ok, run
 * the trailing migrations against restored data).
 */
export interface SnapshotMigrationEntry {
  filename: string;
  /** Lowercase hex sha256 of the migration file's contents. */
  sha256: string;
}

export interface SnapshotPlugin {
  name: string;
  version: string;
  /**
   * The plugin's declared capabilities at capture time. Restore-side loader
   * compares these against the *installed* plugin's manifest to detect
   * capability-spoofing (see §15.6 step 10b).
   */
  capabilities: string[];
  /** Plugin's per-install config, JSON-stringified. */
  configJson: string;
  /**
   * Per-field share-semantics descriptor (V1+). JSON-stringified
   * `SnapshotShape` describing what was stripped from `configJson` and
   * why. Optional for back-compat: snapshots captured before V1 omit
   * this; the fork UI treats absent shapes as "all fields shareable".
   */
  shapeJson?: string;
  /**
   * Which runtime the plugin's core uses. Optional for v1 back-compat;
   * absent → 'js' (the only runtime v1 supported).
   */
  runtime?: SnapshotPluginRuntime;
  /**
   * v2 replacement for `pluginVersionPinned`. When both present,
   * `versionPin` wins (v2 capture overrides v1 reader fallback).
   * When only `pluginVersionPinned` present: true → { mode: 'exact' };
   * false/absent → { mode: 'semver' }.
   */
  versionPin?: SnapshotVersionPin;
  /**
   * Captured migration history. Restore-side reconciles against the
   * installed plugin's current migration list; mismatch by name+sha256
   * surfaces as a divergence warning. Optional; v1 snapshots had no
   * migration concept and load with empty list.
   */
  migrationManifest?: SnapshotMigrationEntry[];

  /**
   * @deprecated v1 only — read by the loader for back-compat, never
   * written by v2 capture. `versionPin` supersedes. One-cycle removal:
   * after v2 has been the default for a release, drop this field.
   */
  pluginVersionPinned?: boolean;
}

export interface SnapshotProvenance {
  /**
   * Stable id of the parent snapshot this one derives from, when this
   * snapshot was created via fork-then-snapshot. Null for fresh snapshots.
   * If parent was private, redacted to `{ id: '<redacted>' }` per §15.10.
   */
  derivedFrom: { id: string; name?: string; author?: string } | null;
}

export interface SnapshotManifest {
  /**
   * Reader accepts v1 (legacy) or v2 (current). Writer emits v2.
   * Use the constants {@link SNAPSHOT_READER_MIN_VERSION} / {@link SNAPSHOT_SCHEMA_VERSION}.
   */
  schemaVersion: 1 | 2;
  kind: SnapshotKind;
  /** `snap_<12-base32>`. */
  id: string;
  /** Human-readable name (renders on detail page). */
  name: string;
  /** Long description; markdown ok. */
  description?: string;
  /** Originating harness slug. Stable across forks. */
  harnessSlug: string;
  /** Substrate version that built this snapshot. */
  substrateVersion: string;
  /** Schema version of the harness DB at capture time. */
  schemaVersion_db: number;
  /** Minimum substrate version required to restore. */
  minSubstrateVersion: string;
  /** Origin template. */
  template: { name: string; version: string };
  /** Build epoch ms. */
  createdAt: number;
  /** Files included in the tarball, with per-file sha256. */
  files: { path: string; sha256: string; bytes: number }[];
  /** Files excluded from the tarball, with reason — `denylist`, `secret`, `opt-out`, `trigger-mirror`, etc. */
  excluded: { path: string; reason: string }[];
  /** Plugins enabled at capture time. */
  plugins: SnapshotPlugin[];
  /** Whether the capture pass had to ship before all in-flight workers drained. */
  partial: boolean;
  /** Optional provenance chain. */
  provenance?: SnapshotProvenance;
  /** License identifier (SPDX). */
  license: string;
  /** Capture pass walltime ms (informational). */
  captureDurationMs?: number;
  /** Tally of redactions applied at capture time. */
  redactions: {
    blockedSecretsTier: 'verified-block' | 'high-recall-warn' | 'none';
    verifiedHits: number;
    highRecallHits: number;
  };
}

export function newSnapshotId(): string {
  return snapshotId();
}

export function newForkSlugSuffix(): string {
  // §15.6 step 6 — "random 6-character base32 suffix" appended to the
  // original slug at restore time. 32^6 = 1B keyspace.
  return randomBase32(6);
}

export function validateSnapshotManifest(input: unknown): asserts input is SnapshotManifest {
  if (input == null || typeof input !== 'object') throw new Error('manifest is not an object');
  const m = input as Record<string, unknown>;
  // Accept any version in [SNAPSHOT_READER_MIN_VERSION, SNAPSHOT_SCHEMA_VERSION].
  // Reader handles v1 and v2 manifests; writer always emits v2. Forward
  // compat (reading a v3 manifest) is intentionally not supported —
  // user must update the reader before the snapshot loads.
  const sv = m.schemaVersion;
  if (
    typeof sv !== 'number' ||
    sv < SNAPSHOT_READER_MIN_VERSION ||
    sv > SNAPSHOT_SCHEMA_VERSION
  )
    throw new Error(
      `unsupported schemaVersion ${String(sv)} (reader supports ${SNAPSHOT_READER_MIN_VERSION}..=${SNAPSHOT_SCHEMA_VERSION})`,
    );
  if (m.kind !== 'snapshot') throw new Error(`kind must be "snapshot"`);
  for (const k of [
    'id',
    'name',
    'harnessSlug',
    'substrateVersion',
    'minSubstrateVersion',
    'license',
  ] as const) {
    if (typeof m[k] !== 'string') throw new Error(`manifest.${k} must be a string`);
  }
  if (typeof m.schemaVersion_db !== 'number')
    throw new Error('manifest.schemaVersion_db must be a number');
  if (typeof m.createdAt !== 'number') throw new Error('manifest.createdAt must be a number');
  if (!Array.isArray(m.files)) throw new Error('manifest.files must be an array');
  if (!Array.isArray(m.excluded)) throw new Error('manifest.excluded must be an array');
  if (!Array.isArray(m.plugins)) throw new Error('manifest.plugins must be an array');
  if (typeof m.partial !== 'boolean') throw new Error('manifest.partial must be boolean');
  const t = m.template as Record<string, unknown> | undefined;
  if (!t || typeof t.name !== 'string' || typeof t.version !== 'string')
    throw new Error('manifest.template.{name,version} required');
  const r = m.redactions as Record<string, unknown> | undefined;
  if (!r) throw new Error('manifest.redactions required');
  if (typeof r.verifiedHits !== 'number' || typeof r.highRecallHits !== 'number')
    throw new Error('manifest.redactions counts must be numbers');
}

/* ───────────────────────── v1 → v2 normalization ───────────────────── */

/**
 * Resolve a SnapshotPlugin's effective `runtime` for downstream consumers.
 * Returns the explicit field if present (v2 capture), else 'js' (v1 default).
 */
export function effectiveRuntime(p: SnapshotPlugin): SnapshotPluginRuntime {
  return p.runtime ?? 'js';
}

/**
 * Resolve a SnapshotPlugin's effective `versionPin`. Precedence:
 *   1. Explicit `versionPin` field (v2 capture).
 *   2. v1 `pluginVersionPinned: true`  → `{ mode: 'exact' }`.
 *   3. v1 `pluginVersionPinned: false` → `{ mode: 'semver' }`.
 *   4. neither field present (very old snapshots) → `{ mode: 'semver' }`.
 *
 * `allowOverride` defaults to 'security-patch' when unset (sane prod
 * default — pinned snapshots can still take CVE patches).
 */
export function effectiveVersionPin(p: SnapshotPlugin): SnapshotVersionPin {
  if (p.versionPin) {
    return {
      mode: p.versionPin.mode,
      allowOverride: p.versionPin.allowOverride ?? 'security-patch',
    };
  }
  if (p.pluginVersionPinned === true) {
    return { mode: 'exact', allowOverride: 'security-patch' };
  }
  return { mode: 'semver', allowOverride: 'security-patch' };
}

/**
 * Resolve a SnapshotPlugin's migration manifest. Returns empty array
 * for v1 snapshots that didn't capture migration history.
 */
export function effectiveMigrationManifest(
  p: SnapshotPlugin,
): SnapshotMigrationEntry[] {
  return p.migrationManifest ?? [];
}

/* ───────── Bundled-plugin filter (rev3 plan G+5 / A10) ─────────────── */

/**
 * `manifest.bundled: true` is a tooling-set field stamped by the build
 * pipeline when a plugin ships pre-installed with the operator (e.g.
 * the bundled `slack-notifier`). Capture excludes these from
 * `snapshot.plugins[]` because they're substrate, not user state — a
 * fork of the snapshot will already have them via the new install's
 * own bundled set.
 *
 * Authors must NOT set this in their own manifests; lint is expected
 * to reject author-set `bundled` (build-only field).
 */
export interface BundledLikeManifest {
  bundled?: unknown;
}

export function isBundledPlugin(manifest: BundledLikeManifest): boolean {
  return manifest.bundled === true;
}

/* ───── Plugin work-dir capture rules (rev3 plan G+4) ──────────────── */

/**
 * Per-file rule for what travels from a plugin's work-dir on snapshot.
 * Mirrors the SDK's `PluginManifest.snapshot.include[]` shape — captures
 * pulls these into a small parsed structure the capture loop walks.
 */
export interface PluginSnapshotInclude {
  /** Path relative to the plugin's work-dir root. Globs supported. */
  path: string;
  /** When 'strip': capture the path as a zero-byte placeholder. */
  redact?: 'strip';
}

export interface PluginSnapshotConfig {
  include?: PluginSnapshotInclude[];
}

export interface SnapshotIncludeLikeManifest {
  snapshot?: unknown;
}

/**
 * Pull the `snapshot.include` rules out of a plugin manifest, with
 * defensive validation. Unknown shapes return empty array (default
 * behavior: nothing from the work-dir travels). When daemon-runtime
 * capture ships in Batch I, this is the function the capture loop
 * consults to decide which work-dir files to include.
 */
export function readSnapshotIncludeRules(
  manifest: SnapshotIncludeLikeManifest,
): PluginSnapshotInclude[] {
  const s = manifest.snapshot;
  if (s == null || typeof s !== 'object') return [];
  const include = (s as Record<string, unknown>).include;
  if (!Array.isArray(include)) return [];
  const out: PluginSnapshotInclude[] = [];
  for (const entry of include) {
    if (entry == null || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.path !== 'string' || e.path.length === 0) continue;
    const item: PluginSnapshotInclude = { path: e.path };
    if (e.redact === 'strip') item.redact = 'strip';
    out.push(item);
  }
  return out;
}

/* ───── Capture-time write helpers (rev3 plan G+, capture migration) ─ */

export interface CapturePluginManifest {
  runtime?: unknown;
  versionPin?: unknown;
  pluginVersionPinned?: unknown;
}

export interface CapturePluginExtras {
  /** Set when the installed plugin's manifest declared a runtime. */
  runtime?: SnapshotPluginRuntime;
  /** v2 canonical pin shape. Always set (translated from legacy if needed). */
  versionPin: SnapshotVersionPin;
  /** Legacy boolean form kept for one cycle of reader back-compat. */
  pluginVersionPinned: boolean;
}

/**
 * Capture-side: read v1 + v2 manifest fields from an installed plugin's
 * papercusp.json and emit the SnapshotPlugin extras. Always returns
 * canonical v2 `versionPin` PLUS legacy `pluginVersionPinned` so older
 * readers (rev3-plan-pre-G+) still understand the snapshot.
 *
 * Translation rules (matches the v1→v2 reader fallbacks):
 *   - Manifest has v2 versionPin              → use as-is
 *   - Manifest has v1 pluginVersionPinned:true → versionPin = { mode: 'exact' }
 *   - Manifest has v1 pluginVersionPinned:false → versionPin = { mode: 'semver' }
 *   - Neither field present                    → versionPin = { mode: 'semver' }
 *
 * `runtime` is read straight through (validated against the enum);
 * unrecognized values are dropped.
 */
export function readCapturePluginExtras(
  manifest: CapturePluginManifest,
): CapturePluginExtras {
  // versionPin: prefer v2 explicit field, fall back to legacy translation.
  let versionPin: SnapshotVersionPin;
  let pluginVersionPinned: boolean;
  const vp = manifest.versionPin;
  if (vp != null && typeof vp === 'object') {
    const mode = (vp as Record<string, unknown>).mode;
    const allowOverride = (vp as Record<string, unknown>).allowOverride;
    if (mode === 'semver' || mode === 'exact' || mode === 'hash') {
      versionPin = { mode };
      if (
        allowOverride === 'security-patch' ||
        allowOverride === 'always' ||
        allowOverride === 'never'
      ) {
        versionPin.allowOverride = allowOverride;
      }
      // Derive legacy boolean: 'exact' → true, anything else → false.
      pluginVersionPinned = mode === 'exact';
    } else {
      versionPin = { mode: 'semver' };
      pluginVersionPinned = false;
    }
  } else if (manifest.pluginVersionPinned === true) {
    versionPin = { mode: 'exact' };
    pluginVersionPinned = true;
  } else if (manifest.pluginVersionPinned === false) {
    versionPin = { mode: 'semver' };
    pluginVersionPinned = false;
  } else {
    versionPin = { mode: 'semver' };
    pluginVersionPinned = false;
  }

  // runtime: accept both
  //   - v2.1 object form (per @plugin's plugin/v1-completion):
  //       { kind: 'js' | 'wasm' | 'daemon', wasmPath?, daemonCommand?, ... }
  //   - legacy v2.0 string form (pre-v1-completion authors who followed
  //     the earlier doc): "js" | "wasm" | "daemon"
  // Only `kind` round-trips into the captured snapshot manifest today;
  // the rest (wasmPath, memoryBudgetMb, etc.) is host-config, not
  // snapshot-content, so it gets re-resolved from the manifest at
  // restore time.
  let runtime: SnapshotPluginRuntime | undefined;
  const rt = manifest.runtime;
  if (typeof rt === 'string' && (rt === 'js' || rt === 'wasm' || rt === 'daemon')) {
    runtime = rt;
  } else if (rt != null && typeof rt === 'object') {
    const kind = (rt as Record<string, unknown>).kind;
    if (kind === 'js' || kind === 'wasm' || kind === 'daemon') {
      runtime = kind;
    }
  }

  return runtime ? { runtime, versionPin, pluginVersionPinned } : { versionPin, pluginVersionPinned };
}

/* ───── Migration divergence reconciliation (rev3 plan G+6) ────────── */

/**
 * Outcome of comparing a snapshot's captured migration history against
 * the locally-installed plugin's current migration set. Three of the
 * four variants are restore-blockers; only `identical` and `extends`
 * permit restoring the snapshot's data into the installed schema.
 *
 * Per rev3 plan G+6 / audit A4: divergence is detected by
 * (filename, sha256) match — content matters, not just filenames.
 * A migration that was renamed but kept the same filename, or
 * rewritten in-place after publishing, surfaces as `diverged`.
 */
export type MigrationReconciliation =
  /** No migrations to apply; both lists match exactly. Safe restore. */
  | { kind: 'identical' }
  /**
   * Installed plugin has all of snapshot's migrations PLUS additional
   * ones at the tail. Restore-side runs `toRun` (the trailing
   * migrations) against the freshly-imported snapshot data. Safe.
   */
  | { kind: 'extends'; toRun: SnapshotMigrationEntry[] }
  /**
   * Same filename, different content hash. Restore is REFUSED — the
   * migration history was rewritten between capture and now, so we
   * can't reason about whether the snapshot's data is still valid
   * under the installed schema.
   */
  | { kind: 'diverged'; conflictingFiles: string[] }
  /**
   * Snapshot references migration filenames the installed plugin
   * doesn't know about. Refuse restore — snapshot was captured
   * against a NEWER version of the plugin than is installed locally
   * (downgrade scenario).
   */
  | { kind: 'snapshot-ahead'; missing: string[] };

/**
 * Reconcile migration histories. Both lists are filename+sha256
 * pairs in apply-order (oldest first). Pure function — no I/O.
 */
export function reconcileMigrations(
  snapshot: SnapshotMigrationEntry[],
  installed: SnapshotMigrationEntry[],
): MigrationReconciliation {
  // Build name→sha256 lookups from each side for the divergence check.
  const installedByName = new Map(installed.map((m) => [m.filename, m.sha256]));
  const snapshotByName = new Map(snapshot.map((m) => [m.filename, m.sha256]));

  // Conflict check: same filename, different sha256.
  const conflicts: string[] = [];
  for (const [name, sha] of snapshotByName) {
    const local = installedByName.get(name);
    if (local !== undefined && local !== sha) conflicts.push(name);
  }
  if (conflicts.length > 0) {
    return { kind: 'diverged', conflictingFiles: conflicts.sort() };
  }

  // Snapshot-ahead check: snapshot has filenames installed doesn't.
  const missing: string[] = [];
  for (const name of snapshotByName.keys()) {
    if (!installedByName.has(name)) missing.push(name);
  }
  if (missing.length > 0) {
    return { kind: 'snapshot-ahead', missing: missing.sort() };
  }

  // All snapshot entries match installed by name+sha. Either lists
  // are identical OR installed has additional trailing entries.
  if (snapshot.length === installed.length) {
    return { kind: 'identical' };
  }

  // Installed extends snapshot. Trailing entries are what the
  // restore-side runs. Order matters; preserve installed's order.
  const trailing = installed.filter((m) => !snapshotByName.has(m.filename));
  return { kind: 'extends', toRun: trailing };
}
