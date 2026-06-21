/**
 * Runtime per-workspace transaction-timeout config (live-configurability-audit-2026-06-20 P-020).
 *
 * The per-workspace advisory-lock txn wrapper in @papercusp/locks (in-workspace-txn.ts) applies a
 * lock_timeout + statement_timeout — baked at 5s/5s, the values that decide whether a same-workspace
 * contention wait or a slow statement is killed (PG 55P03 / 57014 → WorkspaceContendedError). This is
 * the runtime OVERRIDE: the operator injects txnTimeoutsConfig() into the locks LocksHost seam
 * (getTxnTimeouts), so the wrapper reads these per-txn. Mid-incident you can WIDEN the window (e.g.
 * lock_timeout 5s→15s to ride out same-workspace contention) without a deploy — the most incident-
 * relevant of the §H storage/PG dials.
 *
 * Read via the ratified D-010 mechanism: a module-level SYNC cache (zero-await — getTxnTimeouts is
 * called per-txn on the mutating hot path), refreshed on (a) the flag's onFlagChange (kill-switch flip
 * + a key===null reload), (b) local write (same-process immediate), (c) a ~60s .unref()'d periodic
 * timer for bounded (≤60s) cross-process + restart freshness. The module import is deliberately PURE
 * (no import-time getFlag/PG read — locks/configure.ts imports it on the boot path).
 *
 * Default-ON kill-switch (FLAGS.TXN_TIMEOUTS_CONFIG): the override store is empty by default ⇒
 * txnTimeoutsConfig() returns the baked 5s/5s defaults ⇒ byte-identical. Flip the flag OFF to ignore
 * any stored override and force the defaults.
 */
import { getFlag, onFlagChange } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import { systemDistinctId } from './flag-distinct-id';
import { readOperatorState, writeOperatorState } from './operator-state-pg';
import { registerOverrideConcern, type OverrideEntry } from './config-overrides/registry';

export interface TxnTimeoutsConfig {
  /** pg_advisory_xact_lock wait cap (PG lock_timeout), in ms. */
  lockTimeoutMs: number;
  /** Per-statement cap (PG statement_timeout), in ms. */
  statementTimeoutMs: number;
}

/**
 * The baked defaults — the per-workspace txn wrapper's safe floor (5s/5s), byte-identical to the
 * literal that shipped before db:txn-timeouts. MUST stay in lock-step with @papercusp/locks'
 * DEFAULT_TXN_TIMEOUTS (the package's own standalone fallback when getTxnTimeouts is unwired).
 */
export const TXN_TIMEOUTS_DEFAULTS: TxnTimeoutsConfig = {
  lockTimeoutMs: 5000,
  statementTimeoutMs: 5000,
};

/** A partial override of the defaults (only the keys the operator set). */
export type TxnTimeoutsOverride = Partial<TxnTimeoutsConfig>;

// ── D-010 sync cache ────────────────────────────────────────────────────────
let cachedEnabled = false;
let cachedOverride: TxnTimeoutsOverride = {};

/** The effective per-workspace txn timeouts for the locks hot path. SYNC, zero-await. */
export function txnTimeoutsConfig(): TxnTimeoutsConfig {
  if (!cachedEnabled) return TXN_TIMEOUTS_DEFAULTS;
  return {
    lockTimeoutMs: cachedOverride.lockTimeoutMs ?? TXN_TIMEOUTS_DEFAULTS.lockTimeoutMs,
    statementTimeoutMs: cachedOverride.statementTimeoutMs ?? TXN_TIMEOUTS_DEFAULTS.statementTimeoutMs,
  };
}

export async function refreshTxnTimeoutsConfig(): Promise<void> {
  try {
    cachedEnabled = await getFlag(FLAGS.TXN_TIMEOUTS_CONFIG, systemDistinctId());
    cachedOverride = cachedEnabled
      ? (await readOperatorState<TxnTimeoutsOverride>('operator_txn_timeouts_config')) ?? {}
      : {};
  } catch {
    // Fail-safe to the baked defaults — never let a config read change the txn window unexpectedly.
    cachedEnabled = false;
    cachedOverride = {};
  }
}
// D-010 (a): event-driven refresh — fires on the kill-switch flip + a key===null reload. No
// import-time getFlag (pure import — locks/configure.ts imports this on the boot path).
onFlagChange((key) => {
  if (key === null || key === FLAGS.TXN_TIMEOUTS_CONFIG) void refreshTxnTimeoutsConfig();
});
// D-010 (c): bounded cross-process + restart freshness. .unref() so it never holds the process open.
const _refreshTimer = setInterval(() => void refreshTxnTimeoutsConfig(), 60_000);
if (typeof _refreshTimer.unref === 'function') _refreshTimer.unref();

// ── async read/write (the tool) ──────────────────────────────────────────────
export async function readTxnTimeoutsOverride(): Promise<TxnTimeoutsOverride> {
  return (await readOperatorState<TxnTimeoutsOverride>('operator_txn_timeouts_config')) ?? {};
}

async function persist(next: TxnTimeoutsOverride): Promise<TxnTimeoutsOverride> {
  await writeOperatorState<TxnTimeoutsOverride>('operator_txn_timeouts_config', next);
  await refreshTxnTimeoutsConfig(); // same-process immediacy
  return next;
}

/** Merge a partial override over the current one (only the 2 known keys; undefined = leave). */
export async function setTxnTimeoutsOverride(patch: TxnTimeoutsOverride): Promise<TxnTimeoutsOverride> {
  const cur = await readTxnTimeoutsOverride();
  const next: TxnTimeoutsOverride = { ...cur };
  if (patch.lockTimeoutMs !== undefined) next.lockTimeoutMs = patch.lockTimeoutMs;
  if (patch.statementTimeoutMs !== undefined) next.statementTimeoutMs = patch.statementTimeoutMs;
  return persist(next);
}

export async function setTxnTimeoutsOverrideFull(o: TxnTimeoutsOverride): Promise<void> {
  await persist(o ?? {});
}

export async function resetTxnTimeoutsOverride(): Promise<void> {
  await persist({});
}

registerOverrideConcern({
  name: 'txn-timeouts-config',
  description:
    'runtime per-workspace transaction timeouts (lockTimeoutMs / statementTimeoutMs) over the baked 5s/5s defaults (kill-switch: papercusp-txn-timeouts-config)',
  auditAction: 'db:txn-timeouts',
  diff: async () => {
    const o = await readTxnTimeoutsOverride();
    const entries: OverrideEntry[] = [];
    for (const key of ['lockTimeoutMs', 'statementTimeoutMs'] as const) {
      if (o[key] !== undefined) {
        entries.push({ key, effective: o[key], default: TXN_TIMEOUTS_DEFAULTS[key], layer: 'pg-settings' });
      }
    }
    return entries;
  },
  capture: () => readTxnTimeoutsOverride(),
  reset: () => resetTxnTimeoutsOverride(),
  restore: (snap) => setTxnTimeoutsOverrideFull((snap as TxnTimeoutsOverride) ?? {}),
});
