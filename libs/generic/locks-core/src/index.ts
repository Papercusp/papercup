/**
 * @papercusp/locks-core — generic concurrency + causality primitives.
 *
 * Three PURE, zero-I/O modules (no PG, no timers, no domain coupling) extracted
 * from the `locks-correctness-hardening` work so any project can borrow them:
 *
 *   - {@link ./hlc}             Hybrid Logical Clocks (D-003) — causal, NTP-safe
 *                               timestamps; the ordering substrate for leases + LWW.
 *   - {@link ./crdt}            state-based CRDTs (D-004) — PN-Counter / OR-Set /
 *                               HLC LWW-Register / version-vector + the
 *                               Thomas-Write-Rule `decideMerge` conflict router.
 *   - {@link ./intention-locks} the Gray-1976 multi-granularity matrix (D-005) —
 *                               IS/IX/S/SIX/X compatibility, ancestor lock-set
 *                               derivation, conflict detection.
 *
 * The host injects persistence/transport (the PG lock store in `@papercusp/locks`,
 * the federation outbox) and maps its own domain onto these algorithms; the lib
 * itself names no consumer.
 */
export * from './hlc';
export * from './crdt';
export * from './intention-locks';
