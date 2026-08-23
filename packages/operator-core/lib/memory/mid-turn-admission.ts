/**
 * Host-wide admission for the optional mid-turn memory-injection beat.
 *
 * `mid-turn-context` is served by several SO_REUSEPORT workers. Its original
 * rolling limiter and degraded latch were both process-local, so ten workers
 * could each spend their own allowance and probe recovery independently. A
 * fleet burst therefore multiplied an optional recall path until ordinary MCP
 * responses could not return headers promptly (EI-21270032782365521).
 *
 * Reuse the existing named-resource counting semaphore rather than introduce a
 * second limiter store. There are two deliberately separate gates:
 *
 *   1. one in-flight recall per worker (zero-I/O fast rejection); and
 *   2. at most {@link MID_TURN_MEMORY_MAX_HOLDERS} workers across the host.
 *
 * The resource acquire never waits. A full or unavailable admission store is a
 * clean skip because this context is optional; the caller returns `{ text: '' }`
 * and the agent's tool turn continues. A short lease is the crash backstop,
 * while the normal path releases in `finally`.
 */

import { pinModuleState } from '@papercusp/module-singleton';
import { hostGlobalLockDomain } from '../agent-tools/locks/coordination-domain';
import { inWorkspaceTxn } from '../agent-tools/locks/in-workspace-txn';
import { registerResource, tryAcquireResource, tryReleaseResource } from '../agent-tools/locks/su-lock-store';

export const MID_TURN_MEMORY_RESOURCE = 'memory-injection:mid-turn';
export const MID_TURN_MEMORY_MAX_HOLDERS = 2;
export const MID_TURN_MEMORY_LOCK_TTL_SEC = 30;

const REGISTRATION_RETRY_MS = 60_000;
const WARNING_INTERVAL_MS = 60_000;

export interface MidTurnAdmissionLocalState {
  inFlight: boolean;
}

export interface MidTurnAdmissionStore {
  ensureRegistered: () => Promise<boolean>;
  tryAcquire: (ownerId: string) => Promise<{ ok: true; lockId: string } | { ok: false; reason: string }>;
  release: (ownerId: string, lockId: string) => Promise<void>;
}

export type MidTurnAdmissionOutcome<T> = { admitted: true; value: T } | { admitted: false; reason: string };

export interface MidTurnAdmissionGuardOptions {
  ownerId: string;
  state: MidTurnAdmissionLocalState;
  store: MidTurnAdmissionStore;
  onShed?: (reason: string) => void;
  onDiagnostic?: (message: string, error: unknown) => void;
}

/**
 * Testable guard core. Separate `state` objects model independent worker realms;
 * a shared `store` models the host-global semaphore they all contend on.
 */
export async function guardMidTurnMemoryAdmission<T>(
  options: MidTurnAdmissionGuardOptions,
  run: () => Promise<T>,
): Promise<MidTurnAdmissionOutcome<T>> {
  const { ownerId, state, store, onShed, onDiagnostic } = options;

  if (state.inFlight) {
    onShed?.('local_in_flight');
    return { admitted: false, reason: 'local_in_flight' };
  }

  // Claim the local slot before the first await. Two requests entering this
  // worker in the same tick must not both reach the shared store under the same
  // stable process owner (that acquire is intentionally idempotent per owner).
  state.inFlight = true;
  try {
    let registered: boolean;
    try {
      registered = await store.ensureRegistered();
    } catch (error) {
      onDiagnostic?.('mid-turn admission resource registration failed', error);
      onShed?.('admission_unavailable');
      return { admitted: false, reason: 'admission_unavailable' };
    }
    if (!registered) {
      onShed?.('admission_unavailable');
      return { admitted: false, reason: 'admission_unavailable' };
    }

    let acquired: Awaited<ReturnType<MidTurnAdmissionStore['tryAcquire']>>;
    try {
      acquired = await store.tryAcquire(ownerId);
    } catch (error) {
      onDiagnostic?.('mid-turn admission acquire failed', error);
      onShed?.('admission_unavailable');
      return { admitted: false, reason: 'admission_unavailable' };
    }
    if (!acquired.ok) {
      onShed?.(acquired.reason);
      return { admitted: false, reason: acquired.reason };
    }

    try {
      return { admitted: true, value: await run() };
    } finally {
      // Release failure must not discard a successfully built context block.
      // The 30s lease is the correctness backstop; surface a throttled
      // diagnostic so an expiry-backed release never looks healthy.
      try {
        await store.release(ownerId, acquired.lockId);
      } catch (error) {
        onDiagnostic?.('mid-turn admission release failed; lease will expire', error);
      }
    }
  } finally {
    state.inFlight = false;
  }
}

interface ProductionAdmissionState extends MidTurnAdmissionLocalState {
  registered: boolean;
  registrationPromise: Promise<boolean> | null;
  registrationRetryAfter: number;
  nextWarningAt: number;
}

// Pinned across duplicated module records inside one worker. Different worker
// processes still get distinct state and meet through the shared lock store.
const productionState = pinModuleState<ProductionAdmissionState>(
  '@papercusp/operator-core.midTurnMemoryAdmission',
  () => ({
    inFlight: false,
    registered: false,
    registrationPromise: null,
    registrationRetryAfter: 0,
    nextWarningAt: 0,
  }),
);

const productionOwnerId = `mid-turn-memory:${process.pid}`;

function warnOnce(message: string, error?: unknown): void {
  if (process.env.NODE_ENV === 'test') return;
  const now = Date.now();
  if (now < productionState.nextWarningAt) return;
  productionState.nextWarningAt = now + WARNING_INTERVAL_MS;
  const detail = error instanceof Error ? `: ${error.message}` : error ? `: ${String(error)}` : '';
  console.warn(`[memory-injection] ${message}${detail}`);
}

async function ensureProductionResource(): Promise<boolean> {
  if (productionState.registered) return true;
  if (Date.now() < productionState.registrationRetryAfter) return false;
  if (productionState.registrationPromise) return productionState.registrationPromise;

  const domain = hostGlobalLockDomain();
  const registrationOwner = `${productionOwnerId}:register`;
  productionState.registrationPromise = inWorkspaceTxn(domain, registrationOwner, (tx) =>
    registerResource(tx, {
      resource: MID_TURN_MEMORY_RESOURCE,
      description: 'Host-wide concurrency budget for optional per-tool-batch memory injection across operator workers.',
      rule_text:
        'The mid-turn context endpoint acquires a shared, no-wait hold before optional recall and releases it in finally. Full or unavailable capacity sheds the recall; callers must never wait for this resource.',
      enforcement: 'enforced',
      max_holders: MID_TURN_MEMORY_MAX_HOLDERS,
    }),
  )
    .then((result) => {
      const capacity = result.resource.max_holders;
      // A lower operator-set ceiling is safe. Unbounded or wider-than-code
      // policy is not: fail closed instead of silently losing the host cap.
      if (capacity == null || capacity > MID_TURN_MEMORY_MAX_HOLDERS) {
        throw new Error(
          `${MID_TURN_MEMORY_RESOURCE} capacity is ${String(capacity)}; expected <= ${MID_TURN_MEMORY_MAX_HOLDERS}`,
        );
      }
      productionState.registered = true;
      return true;
    })
    .catch((error) => {
      productionState.registrationRetryAfter = Date.now() + REGISTRATION_RETRY_MS;
      warnOnce('host-wide mid-turn admission is unavailable; optional recall is being shed', error);
      return false;
    })
    .finally(() => {
      productionState.registrationPromise = null;
    });

  return productionState.registrationPromise;
}

const productionStore: MidTurnAdmissionStore = {
  ensureRegistered: ensureProductionResource,
  async tryAcquire(ownerId) {
    const domain = hostGlobalLockDomain();
    const result = await inWorkspaceTxn(domain, ownerId, (tx) =>
      tryAcquireResource(tx, {
        coordinationDomain: domain,
        resource: MID_TURN_MEMORY_RESOURCE,
        mode: 'shared',
        owner: ownerId,
        ownerLabel: `operator-worker:${process.pid}`,
        reason: 'optional mid-turn memory recall',
        ttlSec: MID_TURN_MEMORY_LOCK_TTL_SEC,
      }),
    );
    return result.ok ? { ok: true as const, lockId: result.lock_id } : { ok: false as const, reason: result.reason };
  },
  async release(ownerId, lockId) {
    const domain = hostGlobalLockDomain();
    const result = await inWorkspaceTxn(domain, ownerId, (tx) =>
      tryReleaseResource(tx, {
        coordinationDomain: domain,
        owner: ownerId,
        lockId,
      }),
    );
    if (result.released === 0) {
      const expired = result.expired?.some((entry) => entry.lockId === lockId) ?? false;
      throw new Error(expired ? 'admission lease expired before release' : 'admission lock was not released');
    }
  },
};

/** Production entry point used by the mid-turn endpoint. */
export function withMidTurnMemoryAdmission<T>(run: () => Promise<T>): Promise<MidTurnAdmissionOutcome<T>> {
  return guardMidTurnMemoryAdmission(
    {
      ownerId: productionOwnerId,
      state: productionState,
      store: productionStore,
      onShed: (reason) => warnOnce(`host-wide mid-turn admission shed optional recall (${reason})`),
      onDiagnostic: (message, error) => warnOnce(message, error),
    },
    run,
  );
}
