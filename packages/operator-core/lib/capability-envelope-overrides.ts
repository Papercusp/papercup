/**
 * Runtime capability-envelope overrides (live-configurability-audit-2026-06-20 P-009).
 *
 * The per-role capability envelope (ROLE_ENVELOPES) + the universal protected floor
 * (PROTECTED_CAPABILITY_GLOBS) are consumed by evaluateCapabilityEnvelope — a PURE, SYNC fn on the
 * dispatch hot path (checkCapabilityEnvelope, every tool call). This is the runtime OVERRIDE, read via
 * the ratified D-010 mechanism: a module-level SYNC cache (zero-await on the hot path), refreshed on
 * (a) boot, (b) local write (same-process immediate), (c) the dark-flag onFlagChange, and (d) a ~60s
 * .unref()'d periodic timer for bounded (≤60s) cross-process freshness.
 *
 * DARK by default: gated by FLAGS.CAPABILITY_ENVELOPE_OVERRIDES (default-OFF, KNOWN_DARK_FLAGS). Flag
 * OFF ⇒ the getters return empty ⇒ the dispatch step uses the baked ROLE_ENVELOPES + floor ⇒
 * byte-identical. protectedAdditions is TIGHTEN-ONLY (append-only; the floor is never removable — D-002).
 */
import { getFlag, onFlagChange } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import { systemDistinctId } from './flag-distinct-id';
import { readOperatorState, writeOperatorState } from './operator-state-pg';
import { registerOverrideConcern, type OverrideEntry } from './config-overrides/registry';
import type { RoleEnvelope } from './capability-envelope/policy';

export interface CapabilityEnvelopeOverrides {
  /** Per-role deny/allow overrides, merged OVER the baked ROLE_ENVELOPES (per-role replace). */
  roleEnvelopes?: Record<string, RoleEnvelope>;
  /** Extra protected globs, UNIONED with the baked PROTECTED_CAPABILITY_GLOBS (tighten-only). */
  protectedAdditions?: string[];
}

const dedupe = (xs: string[]): string[] => [...new Set(xs)];

// ── D-010 sync cache ────────────────────────────────────────────────────────
let cachedEnabled = false;
let cached: CapabilityEnvelopeOverrides = {};

/** Per-role overrides for the dispatch step (empty when the dark flag is off). SYNC. */
export function envelopeRoleOverrides(): Record<string, RoleEnvelope> {
  return cachedEnabled ? cached.roleEnvelopes ?? {} : {};
}
/** Tighten-only protected-floor additions for the dispatch step (empty when off). SYNC. */
export function envelopeProtectedAdditions(): readonly string[] {
  return cachedEnabled ? cached.protectedAdditions ?? [] : [];
}

export async function refreshCapabilityEnvelopeOverrides(): Promise<void> {
  try {
    cachedEnabled = await getFlag(FLAGS.CAPABILITY_ENVELOPE_OVERRIDES, systemDistinctId());
    cached = cachedEnabled
      ? (await readOperatorState<CapabilityEnvelopeOverrides>('operator_capability_envelopes')) ?? {}
      : {};
  } catch {
    cachedEnabled = false;
    cached = {};
  }
}
void refreshCapabilityEnvelopeOverrides();
onFlagChange((key) => {
  if (key === null || key === FLAGS.CAPABILITY_ENVELOPE_OVERRIDES) void refreshCapabilityEnvelopeOverrides();
});
// D-010 (d): bounded cross-process freshness. .unref() so it never holds the process (or a test) open.
const _refreshTimer = setInterval(() => void refreshCapabilityEnvelopeOverrides(), 60_000);
if (typeof _refreshTimer.unref === 'function') _refreshTimer.unref();

// ── async read/write (the tools) ─────────────────────────────────────────────
export async function readEnvelopeOverrides(): Promise<CapabilityEnvelopeOverrides> {
  return (await readOperatorState<CapabilityEnvelopeOverrides>('operator_capability_envelopes')) ?? {};
}

async function persist(next: CapabilityEnvelopeOverrides): Promise<CapabilityEnvelopeOverrides> {
  await writeOperatorState<CapabilityEnvelopeOverrides>('operator_capability_envelopes', next);
  await refreshCapabilityEnvelopeOverrides(); // same-process immediacy
  return next;
}

/** Set (or clear, when env=null) a role's envelope override. */
export async function setRoleEnvelope(role: string, env: RoleEnvelope | null): Promise<CapabilityEnvelopeOverrides> {
  const cur = await readEnvelopeOverrides();
  const roleEnvelopes = { ...(cur.roleEnvelopes ?? {}) };
  if (env === null) delete roleEnvelopes[role];
  else roleEnvelopes[role] = env;
  return persist({ ...cur, roleEnvelopes });
}

/** TIGHTEN-ONLY: append protected globs (union; the baked floor is never removable). */
export async function addProtectedGlobs(globs: string[]): Promise<CapabilityEnvelopeOverrides> {
  const cur = await readEnvelopeOverrides();
  return persist({ ...cur, protectedAdditions: dedupe([...(cur.protectedAdditions ?? []), ...globs]) });
}

export async function setEnvelopeOverrides(o: CapabilityEnvelopeOverrides): Promise<void> {
  await persist(o ?? {});
}
export async function resetEnvelopeOverrides(): Promise<void> {
  await persist({});
}

registerOverrideConcern({
  name: 'capability-envelope-overrides',
  description: 'runtime per-role capability-envelope overrides + tighten-only protected-floor additions (DARK: papercusp-capability-envelope-overrides)',
  auditAction: 'capability_envelope:set_role',
  diff: async () => {
    const o = await readEnvelopeOverrides();
    const entries: OverrideEntry[] = [];
    for (const role of Object.keys(o.roleEnvelopes ?? {})) {
      entries.push({ key: `roleEnvelope.${role}`, effective: o.roleEnvelopes![role], default: 'ROLE_ENVELOPES baked', layer: 'pg-settings' });
    }
    if (o.protectedAdditions?.length) {
      entries.push({ key: 'protectedAdditions', effective: o.protectedAdditions, default: [], layer: 'pg-settings' });
    }
    return entries;
  },
  capture: () => readEnvelopeOverrides(),
  reset: () => resetEnvelopeOverrides(),
  restore: (snap) => setEnvelopeOverrides((snap as CapabilityEnvelopeOverrides) ?? {}),
});
