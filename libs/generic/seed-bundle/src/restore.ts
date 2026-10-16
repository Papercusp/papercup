/**
 * @papercusp/seed-bundle — the restore orchestration.
 *
 * The generic "restore-before-join" step: validate the manifest, then for each
 * store entry resolve its payload, VERIFY it, and RESTORE it. This NEVER throws
 * — it returns a per-store outcome so the host decides fallback (any not-ok
 * store ⇒ that store drops to its cold catch-up path; the others still benefit).
 * The host's live sync/join runs AFTER this and is unmodified.
 */

import { validateManifest, type SeedManifest, type SeedStoreEntry } from './manifest';
import type { SeedPayload, SeedProviderRegistry, SeedRestoreContext, SeedRestorePhase } from './registry';

/** The result of restoring one store. */
export interface StoreRestoreOutcome {
  readonly kind: string;
  readonly ok: boolean;
  /** Why it failed (absent on success) — surfaced to the host's fallback logic. */
  readonly reason?: string;
}

export interface RestoreResult {
  /** True iff EVERY store restored — else the host cold-paths the failed ones. */
  readonly ok: boolean;
  readonly outcomes: readonly StoreRestoreOutcome[];
}

/** Resolves a store entry to its payload bytes/handle (fetch from the source). */
export type SeedPayloadResolver = (entry: SeedStoreEntry) => Promise<SeedPayload>;

/**
 * Restore every store in a manifest. Order-preserving; failure-isolating (one
 * store's failure never aborts the others). A store fails (with a reason) when:
 * the manifest is invalid, no provider is registered for its kind, the payload
 * resolver throws, `verify` returns not-ok, or `restore` throws.
 */
export async function restoreSeed(
  manifest: SeedManifest,
  registry: SeedProviderRegistry,
  resolvePayload: SeedPayloadResolver,
  ctx: SeedRestoreContext,
): Promise<RestoreResult> {
  const emit = (event: Parameters<NonNullable<SeedRestoreContext['onPhase']>>[0]): void => {
    try {
      ctx.onPhase?.(event);
    } catch {
      // Diagnostics must never change the fail-soft restore contract.
    }
  };
  const validation = validateManifest(manifest);
  if (!validation.ok) {
    return {
      ok: false,
      outcomes: [{ kind: '(manifest)', ok: false, reason: 'invalid manifest: ' + validation.errors.join('; ') }],
    };
  }

  const outcomes: StoreRestoreOutcome[] = [];
  for (const entry of manifest.stores) {
    const provider = registry.get(entry.kind);
    if (!provider) {
      outcomes.push({ kind: entry.kind, ok: false, reason: `no provider registered for kind ${entry.kind}` });
      continue;
    }
    let phase: SeedRestorePhase = 'resolve';
    try {
      emit({ kind: entry.kind, phase, state: 'started' });
      const payload = await resolvePayload(entry);
      emit({ kind: entry.kind, phase, state: 'succeeded' });
      phase = 'verify';
      emit({ kind: entry.kind, phase, state: 'started' });
      const verdict = await provider.verify(entry, payload);
      if (!verdict.ok) {
        emit({ kind: entry.kind, phase, state: 'failed', reason: verdict.reason ?? 'unknown' });
        outcomes.push({ kind: entry.kind, ok: false, reason: `verify failed: ${verdict.reason ?? 'unknown'}` });
        continue;
      }
      emit({ kind: entry.kind, phase, state: 'succeeded' });
      phase = 'restore';
      emit({ kind: entry.kind, phase, state: 'started' });
      await provider.restore(entry, payload, ctx);
      emit({ kind: entry.kind, phase, state: 'succeeded' });
      outcomes.push({ kind: entry.kind, ok: true });
    } catch (e) {
      const reason = (e as Error).message;
      emit({ kind: entry.kind, phase, state: 'failed', reason });
      outcomes.push({ kind: entry.kind, ok: false, reason: `${phase} threw: ${reason}` });
    }
  }

  return { ok: outcomes.every((o) => o.ok), outcomes };
}
