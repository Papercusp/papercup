/**
 * P-015 — the D-009 recurrence guard.
 *
 * FALSIFIABILITY DISCIPLINE. A guard that has never failed is a guard nobody has tested, and
 * the safe way to prove this one CAN fail is a permanent in-file control rather than a mutation
 * of the shared tree (CLAUDE.md § "Proving a guard is falsifiable" — the tier-1 case, since the
 * subject is a module we import). Each control below is a deliberately NARROWER rule; every
 * `expect` that a control MISSES a fixture the real guard CATCHES is what proves the widening
 * is load-bearing rather than decorative. The calibration block then shows the controls are not
 * simply broken — they agree with the real guard on the healthy and the obvious cases.
 */

import { describe, expect, it, vi } from 'vitest';
import type { SeedManifest, SeedStoreEntry } from '@papercusp/seed-bundle';
import {
  DEFAULT_CORESTORE_SIZE_FLOOR_BYTES,
  DEFAULT_CORE_LENGTH_FLOOR_BLOCKS,
  SEED_ACK_FULL_HISTORY_ENV,
  assertSeedNotDegraded,
  isFullHistoryAcknowledged,
  judgeSeedDegradation,
} from './seed-degradation-guard.js';

// ── fixtures ───────────────────────────────────────────────────────────────────────────
// The degraded values are the REAL ones from papercusp-desktop/src-tauri/seed/manifest.json
// (cut 2026-07-21), so the guard is calibrated against the artifact it exists to reject.
const CORE_A = '5b00878b7df0637b4f758129d02bc797d6c1928e18bc3751cb27b9ca0d541bac';
const CORE_B = 'aa11bb22cc33dd44ee55ff6677889900aabbccddeeff00112233445566778899';
const SHIPPED_DEGRADED_BYTES = 1_998_388_355;
const SHIPPED_DEGRADED_BLOCKS = 461_475;

function manifest(stores: SeedStoreEntry[]): SeedManifest {
  return { seedFormatVersion: 1, potId: 'papercusp', cutAtEpoch: 1, cutHlc: 'h', cutTs: 0, stores };
}

function corestore(meta: Record<string, unknown>, sizeBytes = SHIPPED_DEGRADED_BYTES): SeedStoreEntry {
  return { kind: 'corestore', hash: 'h', sizeBytes, source: { type: 'resource', path: '/x' }, meta };
}

const gitEntry: SeedStoreEntry = {
  kind: 'git',
  hash: 'g',
  sizeBytes: 131_296_503,
  source: { type: 'resource', path: '/g' },
};

/** State 2 — the shipped lie: labelled sparse, starts at 0, ships every block. */
const DEGRADED = manifest([
  gitEntry,
  corestore({ coreKeys: [CORE_A], coreLengths: { [CORE_A]: SHIPPED_DEGRADED_BLOCKS }, coreSparseFrom: { [CORE_A]: 0 } }),
]);

/** State 2, partial — one core healthy, one degraded. The same lie, and the case a
 *  whole-manifest "are they ALL zero?" rule cannot see. */
const PARTIALLY_DEGRADED = manifest([
  gitEntry,
  corestore({
    coreKeys: [CORE_A, CORE_B],
    coreLengths: { [CORE_A]: 460_000, [CORE_B]: SHIPPED_DEGRADED_BLOCKS },
    coreSparseFrom: { [CORE_A]: 459_000, [CORE_B]: 0 },
  }),
]);

/** State 3 — a genuine sparse cut: a real suffix start, and a head-span-sized payload. */
const HEALTHY_SPARSE = manifest([
  gitEntry,
  corestore(
    { coreKeys: [CORE_A], coreLengths: { [CORE_A]: SHIPPED_DEGRADED_BLOCKS }, coreSparseFrom: { [CORE_A]: 461_000 } },
    41 * 1024 * 1024,
  ),
]);

/** State 1 — an honestly-labelled full cut (no coreSparseFrom key at all), still a 50x installer. */
const HONEST_FULL = manifest([
  gitEntry,
  corestore({ coreKeys: [CORE_A], coreLengths: { [CORE_A]: SHIPPED_DEGRADED_BLOCKS } }),
]);

/** What `cutHiveSeed` returns on the reuse path BEFORE the graft — git only. Judging this
 *  object instead of the final manifest is the reuse-path blind spot (D-023). */
const PRE_GRAFT_GIT_ONLY = manifest([gitEntry]);

/** A tiny core legitimately starting at 0 — there is no history to trim. Must NOT trip. */
const SMALL_CORE = manifest([
  gitEntry,
  corestore({ coreKeys: [CORE_A], coreLengths: { [CORE_A]: 12 }, coreSparseFrom: { [CORE_A]: 0 } }, 4 * 1024),
]);

/**
 * The FILTERED current-state projection — the path that ACTUALLY SHIPS. `cut-seed-cli` passes
 * `filtered: true` unconditionally, and seed-provider-corestore's `if (filtered)` branch returns
 * before the sparse block, deliberately omitting `coreSparseFrom` ("a complete current-state
 * projection, not a source-log suffix").
 *
 * WI-10001612 — it now RECORDS that it minted a projection (`coreProjectedFrom`: shipped minted
 * key → the owner own-log it was projected from) instead of leaving the guard to infer it from a
 * block count. `OWNER_LOG` is deliberately a DIFFERENT key from the shipped one: a projection is
 * minted into a fresh core the owner never wrote, and that inequality is the falsifier.
 *
 * REAL values from the 2026-08-15 0.0.17-alpha cut, which this guard refused ~81 minutes in:
 * 76 blocks — the head snapshot's exact chunk count — carrying 318,544,683 B, against a
 * 1,788,251-block own-log.
 */
const OWNER_LOG = '77f0e1d2c3b4a5968778695a4b3c2d1e0f00112233445566778899aabbccddee';
const PROJECTION_BLOCKS = 76;
const PROJECTION_BYTES = 318_544_683;
const projectionMeta = (key: string, blocks: number) => ({
  coreKeys: [key],
  coreLengths: { [key]: blocks },
  coreProjectedFrom: { [key]: OWNER_LOG },
});
const FILTERED_PROJECTION = manifest([
  gitEntry,
  corestore(projectionMeta(CORE_A, PROJECTION_BLOCKS), PROJECTION_BYTES),
]);

/**
 * THE WI-10001612 REGRESSION, at its real size. The 2026-09-16 0.0.20 cut minted 1,041 blocks
 * carrying 4.06 GB — 4.1% over the 1,000-block floor the old proxy exempted by — and was refused
 * after a 4.5-hour scan. Per-block size is IDENTICAL to the 0.0.17-alpha cut above (4.19 MB in
 * both); the workspace itself grew 13.7x. So this is an honest projection, and the only thing
 * that changed between "exempt" and "refused" was the workspace outgrowing a proxy.
 */
const PROJECTION_0020_BLOCKS = 1_041;
const PROJECTION_0020_BYTES = 4_360_000_000;
const PROJECTION_0020 = manifest([
  gitEntry,
  corestore(projectionMeta(CORE_A, PROJECTION_0020_BLOCKS), PROJECTION_0020_BYTES),
]);

/** CONTROL, the structural claim stated as a pair: byte-for-byte and block-for-block IDENTICAL to
 *  `PROJECTION_0020`, differing ONLY in whether the projection fact is recorded. Opposite
 *  verdicts here are what prove the exemption rests on the FACT — not on size, and no longer on a
 *  block count that a growing workspace can walk past. */
const UNMARKED_SAME_PAYLOAD = manifest([
  gitEntry,
  corestore(
    { coreKeys: [CORE_A], coreLengths: { [CORE_A]: PROJECTION_0020_BLOCKS } },
    PROJECTION_0020_BYTES,
  ),
]);

/** CONTROL, the falsifier: the manifest claims a projection but names the SHIPPED key as its own
 *  source. A real projection is minted into a core the owner never wrote, so this is a replica of
 *  the owner's log wearing a projection label — the one way the exemption could become a hole. */
const PROJECTION_SELF_SOURCED = manifest([
  gitEntry,
  corestore(
    {
      coreKeys: [CORE_A],
      coreLengths: { [CORE_A]: SHIPPED_DEGRADED_BLOCKS },
      coreProjectedFrom: { [CORE_A]: CORE_A },
    },
    PROJECTION_0020_BYTES,
  ),
]);

/** CONTROL, partial mark: two shipped cores, one proven a projection and one not. The unproven
 *  core is still unproven, so the exemption must not apply — the same reasoning as the partial
 *  sparse degradation above, where healthy siblings do not excuse the bad core. */
const PARTIALLY_MARKED = manifest([
  gitEntry,
  corestore(
    {
      coreKeys: [CORE_A, CORE_B],
      coreLengths: { [CORE_A]: PROJECTION_BLOCKS, [CORE_B]: SHIPPED_DEGRADED_BLOCKS },
      coreProjectedFrom: { [CORE_A]: OWNER_LOG },
    },
    PROJECTION_0020_BYTES,
  ),
]);

/**
 * The PRE-MARKER artifact sitting in papercusp-desktop/src-tauri/seed/ (cut 2026-09-01): 882
 * blocks / 3,697,100,615 B, no `coreProjectedFrom`, grafted forward by `--reuse-corestore`.
 * Measured 882/1,000 — the proxy was at 88% of its expiry here, one cut before it blew.
 */
const LEGACY_REUSE_BLOCKS = 882;
const LEGACY_REUSE_BYTES = 3_697_100_615;
const LEGACY_REUSE_PROJECTION = manifest([
  gitEntry,
  corestore({ coreKeys: [CORE_A], coreLengths: { [CORE_A]: LEGACY_REUSE_BLOCKS } }, LEGACY_REUSE_BYTES),
]);

/** CONTROL: the SAME oversized payload with history-sized blocks and no projection fact. Relaxing
 *  the floor by BYTES alone would let this through; it must still be REFUSED. */
const OVERSIZED_WITH_HISTORY = manifest([
  gitEntry,
  corestore({ coreKeys: [CORE_A], coreLengths: { [CORE_A]: SHIPPED_DEGRADED_BLOCKS } }, PROJECTION_BYTES),
]);

/** CONTROL, fail-safe direction: oversized, and the manifest records NO length for its core. The
 *  payload cannot be PROVEN harmless, so the floor must still fire. */
const OVERSIZED_UNKNOWN_LENGTH = manifest([
  gitEntry,
  corestore({ coreKeys: [CORE_A] }, PROJECTION_BYTES),
]);

// ── deliberately-wrong controls, kept permanently ──────────────────────────────────────

/** CONTROL 1 — the narrow rule: fail only when EVERY core starts at 0. Blind to a partial. */
function naiveAllZerosGuard(m: SeedManifest): boolean {
  const e = m.stores.find((s) => s.kind === 'corestore');
  const from = e?.meta?.coreSparseFrom as Record<string, number> | undefined;
  if (!from) return true;
  return !Object.values(from).every((v) => v === 0);
}

/** CONTROL 2 — label-only: trust the absence of a sparse label, never weigh the payload size. */
function labelOnlyGuard(m: SeedManifest): boolean {
  const e = m.stores.find((s) => s.kind === 'corestore');
  const from = e?.meta?.coreSparseFrom as Record<string, number> | undefined;
  if (!from) return true;
  return Object.values(from).every((v) => v > 0);
}

/**
 * CONTROL 3 — the rule this guard USED to apply, kept permanently so the widening stays
 * falsifiable: exempt an oversized payload only when every core is shorter than the block floor.
 *
 * This is not a strawman. It is the real prior implementation, and it was CORRECT for the two
 * artifacts it was calibrated against (a 76-block projection, a 461,475-block history dump). It
 * is here because a proxy does not fail loudly — it expires, and the only visible symptom is a
 * healthy artifact being refused for a reason that never applied to it.
 */
function blockCountProxyGuard(m: SeedManifest, sizeFloor = DEFAULT_CORESTORE_SIZE_FLOOR_BYTES): boolean {
  const e = m.stores.find((s) => s.kind === 'corestore');
  if (!e) return true;
  const lengths = (e.meta?.coreLengths ?? {}) as Record<string, number>;
  const keys = (e.meta?.coreKeys as string[] | undefined) ?? Object.keys(lengths);
  const everyLengthKnown = keys.length > 0 && keys.every((k) => lengths[k] !== undefined);
  const historyCapable = !everyLengthKnown || keys.some((k) => lengths[k]! > DEFAULT_CORE_LENGTH_FLOOR_BLOCKS);
  return !(e.sizeBytes > sizeFloor && historyCapable);
}

const real = (m: SeedManifest, origin: 'fresh' | 'reuse' = 'fresh') => judgeSeedDegradation(m, { origin }).ok;

describe('P-015 seed degradation guard', () => {
  describe('catches the D-009 class', () => {
    it('REFUSES the manifest the 2026-07-21 release actually shipped', () => {
      const v = judgeSeedDegradation(DEGRADED);
      expect(v.ok).toBe(false);
      expect(v.label).toBe('sparse');
      expect(v.findings.map((f) => f.code)).toContain('sparse-label-but-full-history');
      expect(v.message).toMatch(/461,475 blocks/);
    });

    it('REFUSES a partial degradation — one bad core among healthy siblings', () => {
      const v = judgeSeedDegradation(PARTIALLY_DEGRADED);
      expect(v.ok).toBe(false);
      const finding = v.findings.find((f) => f.code === 'sparse-label-but-full-history');
      expect(finding?.cores).toEqual([CORE_B]);
    });

    it('REFUSES an honestly-labelled FULL cut on the size floor', () => {
      const v = judgeSeedDegradation(HONEST_FULL);
      expect(v.ok).toBe(false);
      expect(v.label).toBe('full');
      expect(v.findings.map((f) => f.code)).toEqual(['corestore-exceeds-size-floor']);
    });

    it('REFUSES a sparse-from-0 claim whose length the manifest does not record', () => {
      const v = judgeSeedDegradation(
        manifest([corestore({ coreKeys: [CORE_A], coreSparseFrom: { [CORE_A]: 0 } }, 1024)]),
      );
      expect(v.ok).toBe(false);
      expect(v.findings.map((f) => f.code)).toEqual(['sparse-label-unverifiable-length']);
    });

    it('REFUSES an oversized payload whose blocks COULD hold history', () => {
      // Same bytes as the legitimate projection below. Only the block count differs, so this is
      // the case a bytes-only relaxation would wrongly admit.
      const v = judgeSeedDegradation(OVERSIZED_WITH_HISTORY);
      expect(v.ok).toBe(false);
      expect(v.findings.map((f) => f.code)).toEqual(['corestore-exceeds-size-floor']);
    });

    it('REFUSES an oversized payload whose core lengths are unrecorded — fail safe', () => {
      // Not provably harmless ⇒ still refused. The qualifier must never turn "unknown" into "fine".
      const v = judgeSeedDegradation(OVERSIZED_UNKNOWN_LENGTH);
      expect(v.ok).toBe(false);
      expect(v.findings.map((f) => f.code)).toEqual(['corestore-exceeds-size-floor']);
    });
  });

  describe('does not fire on healthy seeds', () => {
    it('passes a genuine sparse cut', () => {
      expect(judgeSeedDegradation(HEALTHY_SPARSE).ok).toBe(true);
    });

    it('PASSES the filtered current-state projection the shipping path produces', () => {
      // THE 2026-08-15 REGRESSION. This exact manifest (76 blocks / 318,544,683 B) failed the
      // 0.0.17-alpha cut ~81 minutes in, after the seed had already been built. It is oversized
      // by bytes and honest by label; the guard must judge it on what actually separates a
      // projection from a history dump.
      const v = judgeSeedDegradation(FILTERED_PROJECTION);
      expect(v.ok).toBe(true);
      expect(v.label).toBe('projection');
      expect(v.sizeBytes).toBeGreaterThan(DEFAULT_CORESTORE_SIZE_FLOOR_BYTES);
      expect(v.findings).toEqual([]);
    });

    it('PASSES the 1,041-block projection that broke the 0.0.20 cut (WI-10001612)', () => {
      // The regression, at the size that produced it: 4.1% past a floor the 0.0.17 cut cleared
      // by 13x. Under the old block-count proxy this refused; it is the same honest artifact.
      const v = judgeSeedDegradation(PROJECTION_0020);
      expect(v.ok).toBe(true);
      expect(v.label).toBe('projection');
      expect(PROJECTION_0020_BLOCKS).toBeGreaterThan(DEFAULT_CORE_LENGTH_FLOOR_BLOCKS);
      expect(v.legacyProjectionAdmitted).toBe(false); // exempt by the FACT, not the fallback
    });

    it('rests the exemption on the recorded FACT: identical payload, marker alone flips it', () => {
      // The pair is byte-for-byte and block-for-block identical — `coreProjectedFrom` is the
      // ONLY difference. That is the whole claim of the structural rule, and it is also why a
      // growing workspace can no longer walk out of the exemption.
      expect(judgeSeedDegradation(PROJECTION_0020).ok).toBe(true);
      expect(judgeSeedDegradation(UNMARKED_SAME_PAYLOAD).ok).toBe(false);
      expect(judgeSeedDegradation(UNMARKED_SAME_PAYLOAD).findings.map((f) => f.code)).toEqual([
        'corestore-exceeds-size-floor',
      ]);
    });

    it('announces an oversized projection instead of passing it silently', () => {
      // Exempt from the HISTORY floor is not "unremarkable": whether a 4 GB installer is
      // acceptable is a product call, and it must not reach one unstated.
      const v = judgeSeedDegradation(PROJECTION_0020);
      expect(v.ok).toBe(true);
      expect(v.message).toMatch(/4\.06 GB/);
      expect(v.message).toMatch(/judge whether an installer this large is acceptable/);
    });

    it('still REFUSES an oversized payload with history-sized blocks and no projection fact', () => {
      expect(judgeSeedDegradation(OVERSIZED_WITH_HISTORY).ok).toBe(false);
    });

    it('passes a small core that legitimately starts at 0', () => {
      expect(judgeSeedDegradation(SMALL_CORE).ok).toBe(true);
    });

    it('passes a manifest with no corestore at all', () => {
      const v = judgeSeedDegradation(PRE_GRAFT_GIT_ONLY);
      expect(v.ok).toBe(true);
      expect(v.label).toBe('no-corestore');
    });
  });

  describe('the projection fact is checked, not trusted (WI-10001612)', () => {
    it('REFUSES a projection claim whose shipped key IS its own source', () => {
      // A projection is minted into a fresh core the owner never wrote, so `minted === source`
      // says the payload is a replica of the owner's log. Left unchecked, a manifest could buy
      // the size-floor exemption for exactly the history the floor exists to refuse.
      const v = judgeSeedDegradation(PROJECTION_SELF_SOURCED);
      expect(v.ok).toBe(false);
      expect(v.findings.map((f) => f.code)).toContain('projection-label-but-source-core');
      expect(v.findings.find((f) => f.code === 'projection-label-but-source-core')?.cores).toEqual([CORE_A]);
    });

    it('REFUSES a partially-marked entry — an unproven core is not excused by a proven sibling', () => {
      const v = judgeSeedDegradation(PARTIALLY_MARKED);
      expect(v.ok).toBe(false);
      expect(v.findings.map((f) => f.code)).toEqual(['corestore-exceeds-size-floor']);
    });

    it('a self-sourced claim is refused even though its bytes+blocks would otherwise pass as a projection', () => {
      // Isolates the falsifier: same oversized payload, and the ONLY reason it is refused is
      // that the recorded source key is the shipped key itself.
      expect(judgeSeedDegradation(PROJECTION_0020).ok).toBe(true);
      expect(judgeSeedDegradation(PROJECTION_SELF_SOURCED).ok).toBe(false);
    });
  });

  describe('the remedy names the branch that produced the payload', () => {
    it('a SPARSE degradation is the only refusal allowed to mention computeSparseFrom', () => {
      expect(judgeSeedDegradation(DEGRADED).message).toMatch(/computeSparseFrom/);
    });

    it('an oversized FULL cut does NOT get sparse-path advice', () => {
      // THE 2026-09-16 FAILURE, as an executable fact. The refusal used to prescribe appending a
      // head snapshot "so computeSparseFrom resolves a real suffix start" at a cut that never
      // calls computeSparseFrom — 4.5 hours to arrive at a byte-identical refusal. A confidently
      // wrong remedy is worse than a vague error, because it gets followed.
      const v = judgeSeedDegradation(UNMARKED_SAME_PAYLOAD);
      expect(v.ok).toBe(false);
      expect(v.message).not.toMatch(/computeSparseFrom/);
      expect(v.message).toMatch(/Cut it FILTERED/);
    });

    it('a self-sourced projection refusal points at the MINTING branch, not the sparse path', () => {
      const v = judgeSeedDegradation(PROJECTION_SELF_SOURCED);
      expect(v.message).not.toMatch(/computeSparseFrom/);
      expect(v.message).toMatch(/mintFilteredSeedContentCore/);
    });

    it('the reuse graft still dominates every other remedy', () => {
      // Fixing the cut path cannot change what ships while the degraded core is grafted forward.
      expect(judgeSeedDegradation(UNMARKED_SAME_PAYLOAD, { origin: 'reuse' }).message).toMatch(
        /PAPERCUSP_SEED_REUSE_CORESTORE=0/,
      );
    });
  });

  describe('the pre-marker artifact grafted forward', () => {
    it('admits the committed 882-block seed on the reuse path, and SAYS the evidence was the fallback', () => {
      // papercusp-desktop/src-tauri/seed/ as cut 2026-09-01: 882 blocks / 3.70 GB, no projection
      // fact. Refusing it would impose a 4.5-hour re-cut for an artifact we have no reason to
      // doubt — but the verdict must never again rest on a heuristic silently.
      const v = judgeSeedDegradation(LEGACY_REUSE_PROJECTION, { origin: 'reuse' });
      expect(v.ok).toBe(true);
      expect(v.legacyProjectionAdmitted).toBe(true);
      expect(v.message).toMatch(/LEGACY block-count heuristic/);
      expect(v.message).toMatch(/PAPERCUSP_SEED_REUSE_CORESTORE=0/);
    });

    it('does NOT extend the fallback to a FRESH cut — a fresh projection must record the fact', () => {
      // cut-seed-cli passes `filtered: true`, so a fresh cut always marks. An unmarked fresh
      // payload is therefore a sparse or full cut, which the byte floor is calibrated to judge —
      // and if marking ever breaks, this is what refuses to paper over it.
      const v = judgeSeedDegradation(LEGACY_REUSE_PROJECTION, { origin: 'fresh' });
      expect(v.ok).toBe(false);
      expect(v.legacyProjectionAdmitted).toBe(false);
    });

    it('the fallback cannot expire the way the proxy did — it judges a FROZEN artifact', () => {
      // The proxy failed because newly-minted projections GREW past it (76 → 882 → 1,041). A
      // reused entry's block count was fixed when it was cut, so the same constant applied here
      // cannot drift. A reused entry that is ALREADY over the floor is refused, not admitted.
      const overFloor = manifest([
        gitEntry,
        corestore({ coreKeys: [CORE_A], coreLengths: { [CORE_A]: PROJECTION_0020_BLOCKS } }, PROJECTION_0020_BYTES),
      ]);
      expect(judgeSeedDegradation(overFloor, { origin: 'reuse' }).ok).toBe(false);
    });
  });

  describe('the reuse path (D-023) — the branch that actually ships', () => {
    it('judges a GRAFTED degraded corestore, and quotes the reuse remedy', () => {
      // graftCorestoreEntry copies the prior entry verbatim, coreSparseFrom included.
      const grafted = manifest([...PRE_GRAFT_GIT_ONLY.stores, DEGRADED.stores[1]!]);
      const v = judgeSeedDegradation(grafted, { origin: 'reuse' });
      expect(v.ok).toBe(false);
      expect(v.message).toMatch(/PAPERCUSP_SEED_REUSE_CORESTORE=0/);
    });

    it('CONTROL: judging the pre-graft manifest instead would pass the same degraded seed', () => {
      // This is the blind spot, stated as an executable fact: the object cutHiveSeed returns on
      // the reuse path carries no corestore, so a guard wired there can never see the lie.
      expect(judgeSeedDegradation(PRE_GRAFT_GIT_ONLY).ok).toBe(true);
      const grafted = manifest([...PRE_GRAFT_GIT_ONLY.stores, DEGRADED.stores[1]!]);
      expect(judgeSeedDegradation(grafted, { origin: 'reuse' }).ok).toBe(false);
    });
  });

  describe('falsifiability — each control MISSES what the real guard catches', () => {
    it('CONTROL 1 (all-zeros rule) passes the partial degradation the real guard refuses', () => {
      expect(naiveAllZerosGuard(PARTIALLY_DEGRADED)).toBe(true); // control: clean
      expect(real(PARTIALLY_DEGRADED)).toBe(false); // real guard: refuses
    });

    it('CONTROL 2 (label-only rule) passes the honest 1.9 GB full cut the real guard refuses', () => {
      expect(labelOnlyGuard(HONEST_FULL)).toBe(true); // control: clean
      expect(real(HONEST_FULL)).toBe(false); // real guard: refuses
    });

    it('CONTROL 3 (block-count proxy) REFUSES the healthy 0.0.20 projection the real guard passes', () => {
      // The expiry, stated as an executable fact. 1,041 blocks is 4.1% past the floor, and that
      //4.1% is the entire difference between the two verdicts — the artifact is honest either
      // way. This is the assertion that would have failed the day the proxy went wrong, and did
      // not exist to.
      expect(blockCountProxyGuard(PROJECTION_0020)).toBe(false); // control: refuses
      expect(real(PROJECTION_0020)).toBe(true); // real guard: passes
    });

    it('CONTROL 3 is blind to the falsifier the real guard catches', () => {
      // A self-sourced "projection" is short enough for the proxy to wave through on block count
      // alone in the small case — the proxy never asks what the payload IS, only how long it is.
      const shortSelfSourced = manifest([
        gitEntry,
        corestore(
          {
            coreKeys: [CORE_A],
            coreLengths: { [CORE_A]: PROJECTION_BLOCKS },
            coreProjectedFrom: { [CORE_A]: CORE_A },
          },
          PROJECTION_BYTES,
        ),
      ]);
      expect(blockCountProxyGuard(shortSelfSourced)).toBe(true); // control: clean
      expect(real(shortSelfSourced)).toBe(false); // real guard: refuses
    });

    it('CALIBRATION: CONTROL 3 agrees with the real guard where the proxy had not yet expired', () => {
      // Without this the two assertions above could be a control that simply refuses everything,
      // which would make them theatre rather than evidence.
      expect(blockCountProxyGuard(FILTERED_PROJECTION)).toBe(true); // 76 blocks — inside the proxy
      expect(real(FILTERED_PROJECTION)).toBe(true);

      expect(blockCountProxyGuard(OVERSIZED_WITH_HISTORY)).toBe(false);
      expect(real(OVERSIZED_WITH_HISTORY)).toBe(false);
    });

    it('CALIBRATION: both controls agree with the real guard on healthy + obviously-degraded', () => {
      // Without this the controls above could be passing everything, which would make the two
      // assertions above vacuous rather than evidence.
      expect(naiveAllZerosGuard(HEALTHY_SPARSE)).toBe(true);
      expect(labelOnlyGuard(HEALTHY_SPARSE)).toBe(true);
      expect(real(HEALTHY_SPARSE)).toBe(true);

      expect(naiveAllZerosGuard(DEGRADED)).toBe(false);
      expect(labelOnlyGuard(DEGRADED)).toBe(false);
      expect(real(DEGRADED)).toBe(false);
    });
  });

  describe('the acknowledgement env', () => {
    it('throws by default on a degraded manifest', () => {
      expect(() => assertSeedNotDegraded(DEGRADED, { env: {} })).toThrow(/REFUSING a degraded seed/);
    });

    it('lets an EXPLICIT acknowledgement through, and still returns the not-ok verdict', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const v = assertSeedNotDegraded(DEGRADED, { env: { [SEED_ACK_FULL_HISTORY_ENV]: '1' } });
        expect(v.ok).toBe(false);
        // The whole defect class is silence, so the acknowledged path must ANNOUNCE itself.
        expect(warn).toHaveBeenCalledOnce();
        expect(warn.mock.calls[0]![0]).toMatch(/BY EXPLICIT ACKNOWLEDGEMENT/);
      } finally {
        warn.mockRestore();
      }
    });

    it('only `1` acknowledges — a truthy-looking value is not an acknowledgement', () => {
      for (const value of ['0', 'true', 'yes', '', undefined]) {
        expect(isFullHistoryAcknowledged({ [SEED_ACK_FULL_HISTORY_ENV]: value })).toBe(false);
      }
      expect(isFullHistoryAcknowledged({ [SEED_ACK_FULL_HISTORY_ENV]: '1' })).toBe(true);
    });

    it('does not throw on a clean manifest regardless of the env', () => {
      expect(() => assertSeedNotDegraded(HEALTHY_SPARSE, { env: {} })).not.toThrow();
    });
  });

  describe('floors', () => {
    it('the size floor sits clear of both a sparse seed and the known-bad core', () => {
      expect(41 * 1024 * 1024).toBeLessThan(DEFAULT_CORESTORE_SIZE_FLOOR_BYTES);
      expect(SHIPPED_DEGRADED_BYTES).toBeGreaterThan(DEFAULT_CORESTORE_SIZE_FLOOR_BYTES);
    });

    it('floors are overridable so a caller can tighten them', () => {
      expect(judgeSeedDegradation(HEALTHY_SPARSE, { sizeFloorBytes: 1024 }).ok).toBe(false);
    });
  });
});
