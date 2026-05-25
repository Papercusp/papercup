/**
 * claim-handle-adapter — Phase 6 P-037 bridge.
 *
 * Plan: papercusp-dogfood-phase6-orchestrator-claim-2026-05-24.
 *
 * Turns a substrate `AutobaseHarnessHandle` into the
 * `ClaimAutobaseHandle` that `feature-claim.ts` consumes.
 *
 * Two responsibilities:
 *
 *   appendClaim(record)         — writes the OpEnvelope envelope
 *                                  ({type:'put', table:'claims', value: record})
 *                                  through the substrate's append() and
 *                                  resolves with the resulting view seq.
 *
 *   readClaimsForFeature(id)    — walks base.view, parses each entry,
 *                                  filters to `kind:'feature_claim'` ops
 *                                  matching `feature_id`, returns them
 *                                  ordered by view seq.
 *
 * Pure logic — no PG, no FS. The substrate handle is the only
 * dependency; tests can fake it.
 *
 * Per D-024: the appendClaim wrapper passes through the record's
 * `schema_version` so the substrate's accept-op gate uses the same
 * value the orchestrator emitted.
 */

import type { AutobaseHarnessHandle, OpEnvelope } from '../sync/hyperbee/autobase-setup';
import type {
  ClaimAutobaseHandle,
  FeatureClaimRecord,
  MergedClaim,
} from './feature-claim';

/**
 * Minimal Hypercore-style view surface this adapter reads. The
 * substrate's `base.view` exposes `length` + `get(seq)` returning
 * the appended op envelope.
 */
export interface ClaimViewReader {
  length: number;
  get(seq: number): Promise<OpEnvelope | null | undefined>;
}

export interface AdapterOpts {
  /** Substrate handle from bootHarnessSubstrate. */
  base: AutobaseHarnessHandle;
  /** Reader for the merged Autobase view. Default = `base.base.view`. */
  view?: ClaimViewReader;
  /** Our local writer's pubkey (hex). Used as `claimer_pubkey`. */
  myPubkey: string;
  /** Hyperbee table tag for claims. Default `'claims'`. */
  table?: string;
}

const DEFAULT_CLAIM_TABLE = 'claims';

/**
 * Read the view from the substrate's Autobase. Cast through unknown
 * because the upstream `Autobase` types don't expose `view` as a
 * Hypercore — this is the documented surface from the apply()
 * function in autobase-setup.ts (`view.append(op)`).
 */
function defaultViewFor(base: AutobaseHarnessHandle): ClaimViewReader {
  const v = (base.base as unknown as { view?: ClaimViewReader }).view;
  if (!v || typeof v.get !== 'function') {
    throw new Error(
      'claim-handle-adapter: base.view missing or has no get(seq)',
    );
  }
  return v;
}

/** Build the `ClaimAutobaseHandle` for one substrate. */
export function buildClaimAutobaseHandle(
  opts: AdapterOpts,
): ClaimAutobaseHandle {
  if (!opts.myPubkey) {
    throw new Error('claim-handle-adapter: myPubkey required');
  }
  const table = opts.table ?? DEFAULT_CLAIM_TABLE;
  const view = opts.view ?? defaultViewFor(opts.base);

  return {
    myPubkey: opts.myPubkey,
    async appendClaim(record: FeatureClaimRecord): Promise<{ seq: number }> {
      const before = view.length;
      const envelope: OpEnvelope = {
        type: 'put',
        table,
        hbKey: `feature_claim/${record.feature_id}/${record.claimer_pubkey}/${record.ts}`,
        value: record,
        schema_version: record.schema_version,
        ts: record.ts,
      };
      await opts.base.append(envelope);
      // Best-effort: report the post-append length as the seq. The
      // accept-op gate + merge may produce a different final view
      // seq; the orchestrator tolerates this and uses readClaimsForFeature
      // to resolve the actual ordering.
      return { seq: Math.max(before, view.length - 1) };
    },
    async readClaimsForFeature(
      feature_id: string,
    ): Promise<ReadonlyArray<MergedClaim>> {
      const out: MergedClaim[] = [];
      const len = view.length;
      for (let seq = 0; seq < len; seq += 1) {
        let env: OpEnvelope | null | undefined;
        try {
          env = await view.get(seq);
        } catch {
          continue;
        }
        if (!env || env.type !== 'put') continue;
        if (env.table !== table) continue;
        const v = env.value as FeatureClaimRecord | undefined;
        if (!v || v.kind !== 'feature_claim') continue;
        if (v.feature_id !== feature_id) continue;
        out.push({ record: v, seq });
      }
      return out;
    },
  };
}
