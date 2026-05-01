/**
 * Snapshot manifest — JSON spec'd in §15.10.
 *
 * Stored as `manifest.json` inside the snapshot tarball. Cap'n-proto
 * typed schema is deferred to v2; v1 uses JSON with strict validation.
 */

import { snapshotId, randomBase32 } from '@papercusp/publish-auth';

export const SNAPSHOT_SCHEMA_VERSION = 1 as const;

export type SnapshotKind = 'snapshot';

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
   * The plugin's `pluginVersionPinned` flag at capture time. Defaults
   * to `true` per share-semantics spec when absent.
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
  schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
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
  if (m.schemaVersion !== SNAPSHOT_SCHEMA_VERSION)
    throw new Error(`unsupported schemaVersion ${String(m.schemaVersion)}`);
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
