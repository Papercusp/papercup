/**
 * wake-mode.ts — the per-agent wake MODE store (hive-agent-tabs-psu-tui-2026-06-09
 * P-015 / D-005).
 *
 * Each agent's wake mode is `auto` (DEFAULT — a wake fires immediately, the
 * shipped behavior) or `manual` (the wake is STAGED for owner release/edit — the
 * P-007 gate in `wakeRecipients` consumes this). Resolution precedence: a
 * per-agent override wins over the global default, which itself defaults to
 * `auto`. So with nothing configured every agent is `auto` ⇒ the fleet-wide wake
 * path is unchanged (default-preserving).
 *
 * Stored in the `operator_settings` KV (PG, per storage policy — no new table for
 * the mode itself; the staged wakes get their own table in P-007):
 *   - global default       → key `wake_mode:default`
 *   - per-agent override    → key `wake_mode:agent:<ownerId>`
 *
 * Orthogonal to driveMode (D-005): driveMode decides whether an agent is SENT
 * wakes at all; wake-mode decides how RECEIVED wakes are handled.
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';

export const WAKE_MODES = ['auto', 'manual'] as const;
export type WakeMode = (typeof WAKE_MODES)[number];

/** The mode an agent has when nothing (override or global default) is set. */
export const DEFAULT_WAKE_MODE: WakeMode = 'auto';

const DEFAULT_KEY = 'wake_mode:default';
const agentKey = (ownerId: string): string => `wake_mode:agent:${ownerId}`;

/** Narrow an arbitrary stored string to a WakeMode (garbage / null → null). */
export function coerceWakeMode(v: string | null | undefined): WakeMode | null {
  return v === 'auto' || v === 'manual' ? v : null;
}

/** Pure resolution: per-agent override wins over the global default, else auto. */
export function resolveWakeModeFrom(
  override: WakeMode | null,
  globalDefault: WakeMode | null,
): WakeMode {
  return override ?? globalDefault ?? DEFAULT_WAKE_MODE;
}

async function readSetting(key: string): Promise<string | null> {
  const { sql } = getOrgPg();
  const rows = await sql`SELECT value FROM harness_shared.operator_settings WHERE key = ${key} LIMIT 1`;
  return (rows[0] as { value?: string } | undefined)?.value ?? null;
}

async function writeSetting(key: string, value: string, description: string): Promise<void> {
  const { sql } = getOrgPg();
  await sql`
    INSERT INTO harness_shared.operator_settings (key, value, description, updated_at, workspace_id)
    VALUES (${key}, ${value}, ${description}, ${Date.now()}, ${activeWorkspaceId()})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
  `;
}

/** The global default wake mode (auto unless an owner set it). */
export async function getDefaultWakeMode(): Promise<WakeMode> {
  return coerceWakeMode(await readSetting(DEFAULT_KEY)) ?? DEFAULT_WAKE_MODE;
}

export async function setDefaultWakeMode(mode: WakeMode): Promise<void> {
  await writeSetting(DEFAULT_KEY, mode, 'Global default agent wake mode (hive-agent-tabs P-015 / D-005).');
}

/** This agent's per-agent override, or null when unset (→ falls back to default). */
export async function getWakeModeOverride(ownerId: string): Promise<WakeMode | null> {
  return coerceWakeMode(await readSetting(agentKey(ownerId)));
}

export async function setWakeMode(ownerId: string, mode: WakeMode, description?: string): Promise<void> {
  await writeSetting(agentKey(ownerId), mode, description ?? `Per-agent wake mode for ${ownerId} (hive-agent-tabs P-015).`);
}

/**
 * fleet-member-wake-immunity (WI-2185): make a freshly-spawned fleet MEMBER immune to a
 * `manual` GLOBAL default (the D-005 pause/edit gate) by writing it a per-agent
 * `auto` override at boot.
 *
 * Why members specifically: a member's only steering channel is its LEADER's
 * `coord:send` wakes. Under a manual global default a member with no override inherits
 * `manual`, so every steering wake is STAGED for owner release — and the member's leader
 * (often a weak local model) neither knows to flip it nor CAN release a staged wake (only
 * the owner can). The fleet then deadlocks on steering it can never receive. The owner
 * isn't conversing with each member directly, so the manual gate buys nothing there but
 * the deadlock. A LEADER under a manual default is deliberately left gated — the owner IS
 * present, and releasing the leader's staged routing-gate wake is the gate working as
 * intended.
 *
 * Scoped per-agent so the owner's global default is UNTOUCHED for every non-member, and
 * reversible (the owner can flip a specific member back with `coord:wake-mode`). No-op
 * for a leader or a non-fleet launch. Returns the mode written, or null when it did
 * nothing. The member's owner id is freshly minted at boot, so there is never a
 * pre-existing override to clobber.
 */
export async function ensureFleetMemberWakeAuto(
  ownerId: string,
  fleetRole: string | null | undefined,
): Promise<WakeMode | null> {
  if (fleetRole !== 'member') return null;
  await setWakeMode(
    ownerId,
    'auto',
    `Fleet MEMBER ${ownerId} pinned to auto wake-mode at boot (WI-2185) — immune to a manual global default so its leader's steering wakes land.`,
  );
  return 'auto';
}

/** Effective wake mode for an agent: override ?? global default ?? auto. */
export async function resolveWakeMode(ownerId: string): Promise<WakeMode> {
  return resolveWakeModeFrom(await getWakeModeOverride(ownerId), await getDefaultWakeMode());
}

/**
 * ALL per-agent overrides in one read, keyed by ownerId — for the roster, where
 * resolveWakeMode per agent would be N round-trips (P-008 badge). Agents without a
 * row fall back to the global default (resolve in-memory with getDefaultWakeMode).
 */
export async function getAllWakeModeOverrides(): Promise<Map<string, WakeMode>> {
  const { sql } = getOrgPg();
  const rows = await sql`
    SELECT key, value FROM harness_shared.operator_settings
    WHERE key LIKE 'wake_mode:agent:%'
  `;
  const out = new Map<string, WakeMode>();
  const prefix = 'wake_mode:agent:';
  for (const r of rows as unknown as Array<{ key: string; value: string }>) {
    const ownerId = r.key.slice(prefix.length);
    const mode = coerceWakeMode(r.value);
    if (ownerId && mode) out.set(ownerId, mode);
  }
  return out;
}
