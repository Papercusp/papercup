/**
 * Single source of the lock TTL / wait defaults (live-configurability-audit-2026-06-20 P-013, D-006).
 *
 * These were copy-pasted across the lock agent-tools (acquire, acquire_granular, acquire_resource,
 * heartbeat, heartbeat_resource, file-lock-guard, resource-lock-guard) — a ~6-way desync footgun: a
 * runtime change to one copy silently mis-sets the lease elsewhere. Consolidated here; the companion
 * one-source test (lock-config.test.ts) asserts no surviving `*_TTL_SEC = <literal>` re-declaration in
 * this directory. The locks STORE (libs/papercusp/packages/locks/coordinator.ts) keeps its own default
 * for direct-store callers — a separate package layer.
 *
 * P-013 EXPOSE (the runtime locks:lock_config tool) is the next step: it will make the DEFAULT settable
 * (a sync-cached operator_lock_config read at the call site); MAX_LOCK_TTL_SEC / MAX_LOCK_WAIT_SEC stay
 * hard zod ceilings (schema-time consts), with any configured soft-max validated in the handler.
 */

/** Default lock lease (20 min) — matches the PreToolUse per-edit hook lease. */
export const DEFAULT_LOCK_TTL_SEC = 1200;
/** Hard cap on a lock lease (1 h). */
export const MAX_LOCK_TTL_SEC = 3600;
/** Max blocking same-turn wait (5 min) — past this, end your turn with wake_on_grant. */
export const MAX_LOCK_WAIT_SEC = 300;
