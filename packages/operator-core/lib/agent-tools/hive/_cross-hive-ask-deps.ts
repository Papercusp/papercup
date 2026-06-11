/**
 * _cross-hive-ask-deps — the PRODUCTION wiring of the cross-Hive front-door tools
 * (hive-network-surface-2026-06-11 P-003, brief B-04). Binds the injectable ports
 * of `cross-hive-ask-send` to their live implementations:
 *
 *   - resolveBoundary    → the boot-wired boundary registry (B-01 registers).
 *   - checkOutboundGrant → stub-allow for now; swapped to B-05's direction-aware
 *                          enforcement once it lands (single line here).
 *   - store              → the C-1 ledger store (B-02), resolved LAZILY at
 *                          call-time so importing a tool never throws before
 *                          B-02 registers its impl.
 *
 * Shared by ask.ts / request_work.ts / asks.ts so the three tools stay thin.
 */
import { getCrossHiveBoundary } from '../../cross-hive-boundary-registry';
import { getCrossHiveAsksStore, type CrossHiveAsksStore } from '../../cross-hive-asks-store-port';
import { stubAllowOutboundGrant, type SendCrossHiveAskDeps } from '../../cross-hive-ask-send';

/**
 * A store proxy that defers `getCrossHiveAsksStore()` to each call — so the tool
 * modules import cleanly before B-02 registers, and a call before B-02 lands
 * surfaces the store-port's clear "pending" error.
 */
const lazyStore: CrossHiveAsksStore = {
  insertCrossHiveAsk: (ws, slug, row, sql) => getCrossHiveAsksStore().insertCrossHiveAsk(ws, slug, row, sql),
  listCrossHiveAsks: (ws, slug, filter, sql) => getCrossHiveAsksStore().listCrossHiveAsks(ws, slug, filter, sql),
};

/** The live store (lazy) — backs `hive:asks`. */
export function productionCrossHiveAsksStore(): CrossHiveAsksStore {
  return lazyStore;
}

/** The live send deps — backs `hive:ask` / `hive:request_work`. */
export function productionSendCrossHiveAskDeps(): SendCrossHiveAskDeps {
  return {
    resolveBoundary: getCrossHiveBoundary,
    // TODO(B-05): replace with cross-hive-grants outbound enforcement when it lands.
    checkOutboundGrant: stubAllowOutboundGrant,
    store: lazyStore,
  };
}
