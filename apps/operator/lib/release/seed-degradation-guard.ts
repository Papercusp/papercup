/**
 * P-015 — the recurrence guard for the D-009 class: a seed that CLAIMS to be sparse
 * while shipping the full own-log history.
 *
 * WHY THIS EXISTS. `computeSparseFrom` (seed-provider-corestore.ts:201-207) returns 0
 * when it finds no complete snapshot inside the reader's scan window. The provider then
 * writes `coreSparseFrom[key] = 0` into the manifest anyway — the seed is LABELLED sparse
 * and ships every block — behind nothing louder than a `console.warn`. That is how the
 * 2026-07-21 release shipped 461,475 blocks / 1.9 GB labelled sparse and nobody noticed
 * for three weeks (P-013 → D-009/D-012).
 *
 * WHY IT MUST JUDGE THE FINAL MANIFEST, NOT THE CUT (D-023, EI-19483689516127637).
 * The default release path does not take the fresh-cut branch at all. `ensure-release-seed.sh`
 * defaults `PAPERCUSP_SEED_REUSE_CORESTORE=auto`, which passes `--reuse-corestore` whenever a
 * committed corestore exists, and `graftCorestoreEntry` (cut-seed-cli.ts:316) copies that prior
 * entry onto the new manifest VERBATIM — `meta.coreSparseFrom` included — with no inspection
 * beyond a double-add check. So the degradation is SELF-PERPETUATING: every default release
 * re-ships the degraded core, and a guard that only covered the fresh path would miss the
 * only path that actually ships. Judging the FINAL manifest is what makes one guard cover
 * both branches by construction.
 *
 * THE THREE MANIFEST STATES this distinguishes (they are not two):
 *   1. no `coreSparseFrom` key at all  → an honestly-labelled FULL cut. Big, but not a lie.
 *   2. `coreSparseFrom` present, some core starting at 0 with real length → THE LIE. A sparse
 *      cut that degraded to full history and said so only in a warn.
 *   3. `coreSparseFrom` present, every core starting above 0 → a genuine sparse cut.
 * State 1 is still gated, but by the SIZE floor rather than the label, because a 50x installer
 * is a defect whether or not it is honestly described — QUALIFIED, since 2026-08-15, by block
 * count: bytes alone cannot separate a history dump from a big current-state projection, so the
 * size floor only fires on a payload long enough to HOLD history. See the size floor below.
 */

import type { SeedManifest, SeedStoreEntry } from '@papercusp/seed-bundle';

/** Explicit, deliberate acknowledgement that this cut ships full history anyway. */
export const SEED_ACK_FULL_HISTORY_ENV = 'PAPERCUSP_SEED_ACK_FULL_HISTORY';

/**
 * A corestore above this ships history, not a head span — BUT ONLY when the payload is long
 * enough to hold history (see `historyCapable` at the size check; bytes alone cannot tell a
 * history dump from a big current-state projection).
 *
 * CALIBRATION, and the population it originally MISSED. This floor was set against two
 * artifact classes: the sparse cut advertises ~40 MB, and the degraded 2026-07-21 core was
 * 1,998,388,355 B. 256 MB sits clear of both, so neither is a borderline call — that much is
 * still true, and it is why the constant is not simply raised.
 *
 * There is a THIRD class the original calibration never contemplated, and it is what the
 * shipping path actually produces: a FILTERED current-state projection. The 0.0.17-alpha cut
 * measured 318,544,683 B across 76 blocks — 7.6x the sparse figure, so ABOVE this floor, while
 * being 6.1x SMALLER and carrying 1,430x fewer blocks than the corestore that actually shipped
 * on 2026-07-05 (1,955,653,943 B / 108,633 blocks, per that cut's committed seed manifest).
 * Healthy, in other words, and well above the floor. Do NOT re-derive this as "the floor is
 * miscalibrated for the filtered path" and raise the constant: raising it would blind the
 * SPARSE path to the very regression the floor exists to catch. The block-count qualifier is
 * what separates the classes; the byte floor stays where it is.
 */
export const DEFAULT_CORESTORE_SIZE_FLOOR_BYTES = 256 * 1024 * 1024;

/**
 * Below this many blocks, `coreSparseFrom === 0` is not evidence of degradation — a core with
 * no history to trim legitimately starts at 0. Only a core long enough for the distinction to
 * matter can carry the lie.
 */
export const DEFAULT_CORE_LENGTH_FLOOR_BLOCKS = 1_000;

export type SeedDegradationCode =
  /** State 2 — the manifest claims sparse and ships a core's full history. */
  | 'sparse-label-but-full-history'
  /** Claims sparse from 0 for a core whose length the manifest does not record. */
  | 'sparse-label-unverifiable-length'
  /** The corestore payload is history-sized regardless of how it is labelled. */
  | 'corestore-exceeds-size-floor';

export interface SeedDegradationFinding {
  readonly code: SeedDegradationCode;
  readonly detail: string;
  /** Hex core keys that triggered a core-scoped finding. */
  readonly cores?: readonly string[];
}

/** Which branch produced the manifest under judgement — decides which remedy is quoted. */
export type SeedCutOrigin = 'fresh' | 'reuse';

export interface SeedDegradationVerdict {
  /** false ⇒ the cut must fail. `acknowledged` is applied separately by the caller. */
  readonly ok: boolean;
  /** What the manifest claims about itself. */
  readonly label: 'sparse' | 'full' | 'no-corestore';
  readonly origin: SeedCutOrigin;
  readonly sizeBytes: number;
  readonly findings: readonly SeedDegradationFinding[];
  /** Human-readable verdict + remedy, ready to throw or log. */
  readonly message: string;
}

export interface JudgeSeedDegradationOptions {
  readonly origin?: SeedCutOrigin;
  readonly sizeFloorBytes?: number;
  readonly coreLengthFloorBlocks?: number;
}

/** Narrow an untyped `meta` bag to a hex-key → number record. Manifests are read off disk
 *  from prior cuts, so nothing here may assume the provider's in-process types. */
function numberRecord(value: unknown): Record<string, number> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

/** Narrow an untyped `meta` bag to a string list. Same defensive posture as {@link numberRecord}:
 *  manifests are read off disk from prior cuts, so nothing here may assume the provider's types. */
function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const v of value) if (typeof v === 'string') out.push(v);
  return out;
}

function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${n} B`;
}

const REMEDY: Record<SeedCutOrigin, string> = {
  fresh:
    'Append a fresh head snapshot at the own-log tail before cutting (produceLogSnapshot after the ' +
    'pre-cut drain) so computeSparseFrom resolves a real suffix start.',
  reuse:
    'The committed corestore is being grafted forward as-cut (D-023: PAPERCUSP_SEED_REUSE_CORESTORE ' +
    'defaults to `auto`). Re-cut fresh with PAPERCUSP_SEED_REUSE_CORESTORE=0 — fixing the sparse path ' +
    'alone can never change what ships while the degraded core is reused.',
};

/**
 * Judge a FINAL seed manifest — the one written to disk, after any `--reuse-corestore` graft.
 * Pure: no env, no fs. The caller supplies `origin` and applies the acknowledgement.
 */
export function judgeSeedDegradation(
  manifest: SeedManifest,
  opts: JudgeSeedDegradationOptions = {},
): SeedDegradationVerdict {
  const origin: SeedCutOrigin = opts.origin ?? 'fresh';
  const sizeFloor = opts.sizeFloorBytes ?? DEFAULT_CORESTORE_SIZE_FLOOR_BYTES;
  const lengthFloor = opts.coreLengthFloorBlocks ?? DEFAULT_CORE_LENGTH_FLOOR_BLOCKS;

  const entry: SeedStoreEntry | undefined = manifest.stores.find((s) => s.kind === 'corestore');
  if (!entry) {
    return {
      ok: true,
      label: 'no-corestore',
      origin,
      sizeBytes: 0,
      findings: [],
      message: '[seed-guard] no corestore entry in the manifest — nothing to judge.',
    };
  }

  const meta = entry.meta ?? {};
  const sparseFrom = numberRecord(meta.coreSparseFrom);
  const lengths = numberRecord(meta.coreLengths) ?? {};
  const label: 'sparse' | 'full' = sparseFrom === undefined ? 'full' : 'sparse';
  const findings: SeedDegradationFinding[] = [];

  if (sparseFrom !== undefined) {
    // State 2 vs 3. A core is degraded when the manifest claims a sparse start of 0 for a core
    // long enough that a real snapshot would have moved it. Judge per-core: a PARTIAL degradation
    // (one core of several starting at 0) is the same lie and must not pass because its siblings
    // are healthy.
    const degraded: string[] = [];
    const unverifiable: string[] = [];
    for (const [key, from] of Object.entries(sparseFrom)) {
      if (from > 0) continue;
      const len = lengths[key];
      if (len === undefined) unverifiable.push(key);
      else if (len > lengthFloor) degraded.push(key);
    }
    if (degraded.length > 0) {
      findings.push({
        code: 'sparse-label-but-full-history',
        cores: degraded,
        detail:
          `${degraded.length} core(s) are labelled sparse but start at block 0, shipping full history: ` +
          degraded.map((k) => `${k.slice(0, 12)}… (${lengths[k]!.toLocaleString()} blocks)`).join(', '),
      });
    }
    if (unverifiable.length > 0) {
      findings.push({
        code: 'sparse-label-unverifiable-length',
        cores: unverifiable,
        detail:
          `${unverifiable.length} core(s) claim a sparse start of 0 but the manifest records no ` +
          `coreLengths entry, so the claim cannot be shown harmless: ` +
          unverifiable.map((k) => `${k.slice(0, 12)}…`).join(', '),
      });
    }
  }

  // A payload can only be HISTORY if some core is long enough to hold history. Bytes alone
  // cannot tell a history dump from a big current-state projection; BLOCK COUNT can.
  //
  // WHY THIS QUALIFIER EXISTS (2026-08-15, the 0.0.17-alpha cut, ~81 min in). The shipping path
  // is the FILTERED branch: cut-seed-cli.ts passes `filtered: true` unconditionally, and
  // seed-provider-corestore.ts's `if (filtered)` branch returns BEFORE the sparse block. It mints
  // a complete current-state projection and omits `coreSparseFrom` deliberately — its own comment
  // says the result "must not trip the history-degradation guard as though a private prefix had
  // been dropped". So it arrives here labelled `full`, the label findings correctly stay silent,
  // and the SIZE floor fired anyway: 318,544,683 B over the 256 MB floor. That floor is calibrated
  // for a DIFFERENT artifact class (a ~41 MB sparse head span vs the 1.9 GB / 461,475-block
  // history dump). The projection is a third population: 76 blocks — the head snapshot's exact
  // chunk count — against a 1,788,251-block own-log. It cannot be history by ~23,000x.
  //
  // Reuse DEFAULT_CORE_LENGTH_FLOOR_BLOCKS, which already encodes this idea for the sparse
  // findings above ("below this many blocks, a core has no history to trim"), rather than raising
  // the byte floor — raising it would blind the sparse path to the very regression it exists to
  // catch. FAIL SAFE: if any core's length is unknown we cannot PROVE the payload is not history,
  // so the floor still applies.
  const coreKeys = stringArray(meta.coreKeys) ?? Object.keys(lengths);
  const everyLengthKnown = coreKeys.length > 0 && coreKeys.every((k) => lengths[k] !== undefined);
  const historyCapable = !everyLengthKnown || coreKeys.some((k) => lengths[k]! > lengthFloor);

  if (entry.sizeBytes > sizeFloor && historyCapable) {
    findings.push({
      code: 'corestore-exceeds-size-floor',
      detail:
        `corestore payload is ${formatBytes(entry.sizeBytes)}, above the ${formatBytes(sizeFloor)} floor ` +
        `— this seed ships history, not a head span.`,
    });
  }

  const ok = findings.length === 0;
  const message = ok
    ? `[seed-guard] corestore OK (${label}, ${formatBytes(entry.sizeBytes)}).`
    : [
        `[seed-guard] REFUSING a degraded seed (${origin} cut, labelled ${label}, ${formatBytes(entry.sizeBytes)}):`,
        ...findings.map((f) => `  • ${f.code}: ${f.detail}`),
        `  remedy: ${REMEDY[origin]}`,
        `  to ship it anyway, set ${SEED_ACK_FULL_HISTORY_ENV}=1 — a deliberate, recorded acknowledgement.`,
      ].join('\n');

  return { ok, label, origin, sizeBytes: entry.sizeBytes, findings, message };
}

/** Read the acknowledgement from an env bag. Kept separate so `judgeSeedDegradation` stays pure. */
export function isFullHistoryAcknowledged(env: Record<string, string | undefined>): boolean {
  return env[SEED_ACK_FULL_HISTORY_ENV] === '1';
}

/**
 * Enforce the verdict: throw unless clean or explicitly acknowledged. An acknowledged
 * degradation is announced on stderr — the whole defect class is that it used to be silent,
 * so the acknowledged path must be louder than the refusal, not quieter.
 */
export function assertSeedNotDegraded(
  manifest: SeedManifest,
  opts: JudgeSeedDegradationOptions & { readonly env?: Record<string, string | undefined> } = {},
): SeedDegradationVerdict {
  const verdict = judgeSeedDegradation(manifest, opts);
  if (verdict.ok) return verdict;
  if (isFullHistoryAcknowledged(opts.env ?? process.env)) {
    console.warn(
      `${verdict.message}\n[seed-guard] ⚠ ${SEED_ACK_FULL_HISTORY_ENV}=1 — shipping the degraded seed ` +
        `BY EXPLICIT ACKNOWLEDGEMENT. The installer carries full history.`,
    );
    return verdict;
  }
  throw new Error(verdict.message);
}
