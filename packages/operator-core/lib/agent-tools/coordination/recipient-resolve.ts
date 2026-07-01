/**
 * recipient-resolve.ts — validate + resolve coord:send recipients against the
 * live roster (owner ask 2026-06-17: the SYSTEM, not just the prompt, must fail
 * loudly when you address an agent that doesn't exist — and a SHORT ownerId
 * prefix must resolve to the FULL id so the inbox-wake key matches).
 *
 * Why this exists: coord:send's wake fires the EXACT key
 * `coord:inbox-wake:<ownerId>`, which only the owner of that full id watches
 * (see inbox-wake.ts). A short prefix (e.g. `su-df00939e` for
 * `su-df00939e-1f16-…`) injected the message but fired a key nobody watched →
 * `woken:0`, and a typo'd id silently "succeeded" the same way. This resolves a
 * unique prefix to the full ownerId and rejects a recipient that matches no
 * known agent — so the wake lands and a bad id is a loud error, not a no-op.
 */

import { listPresence } from './presence';
import { listRecordedLiveSessions } from '../../adv-sessions';
import { PRESENCE_STALE_MS } from '@papercusp/coordination/presence';
import { listLiveSessionPresence } from '../../sync/hyperbee/session-presence-store';

/** Wildcards + audience selectors that bypass concrete-recipient validation —
 *  sendMessage expands these itself (`*`/`human` broadcast; `@plan:`/`@role:`/
 *  `@wave:`/`@user:` are audience selectors). */
export function isSelectorOrWildcard(id: string): boolean {
  return id === '*' || id === 'human' || id === '' || id.startsWith('@');
}

export interface RecipientResolution {
  /** The `to[]` to actually send: selectors/wildcards passthrough + concrete
   *  ids resolved to their FULL ownerId. */
  resolved: string[];
  /** Concrete ids that matched no known agent (typos / dead-and-swept). */
  unknown: string[];
  /** Concrete ids whose prefix matched MORE than one known agent. */
  ambiguous: { id: string; matches: string[] }[];
}

/** PURE core (unit-tested): resolve each `to` entry against the known ownerId
 *  set. selector/wildcard → passthrough; exact known id → keep; unique PREFIX of
 *  one known id → the full id; prefix → >1 known id → ambiguous; no match →
 *  unknown. */
export function resolveRecipientsAgainst(
  to: readonly string[],
  knownOwnerIds: readonly string[],
): RecipientResolution {
  const known = new Set(knownOwnerIds);
  const resolved: string[] = [];
  const unknown: string[] = [];
  const ambiguous: { id: string; matches: string[] }[] = [];
  for (const id of to) {
    if (isSelectorOrWildcard(id)) {
      resolved.push(id);
      continue;
    }
    if (known.has(id)) {
      resolved.push(id);
      continue;
    }
    // Prefix match (e.g. 'su-93a38' → 'su-93a3872a-…'), then a SUBSTRING fallback so
    // the SHORT HANDLE shown in the [coord+N] injection / inbox — a mid-uuid segment
    // like '93a38' for 'su-93a3872a-…', which is NOT a prefix — resolves directly,
    // without a separate coord:presence lookup to reply (owner ask 2026-06-19).
    let matches = knownOwnerIds.filter((k) => k.startsWith(id));
    if (matches.length === 0) matches = knownOwnerIds.filter((k) => k.includes(id));
    if (matches.length === 1) resolved.push(matches[0]);
    else if (matches.length > 1) ambiguous.push({ id, matches });
    else unknown.push(id);
  }
  return { resolved, unknown, ambiguous };
}

/** Remote (federated session-grain) ownerIds — P-007 (cross-machine-coord-
 *  parity): remote agents resolve exactly like local ones. Wide window (4x
 *  stale) keeps a quiet-but-alive remote session addressable (a message
 *  injects; wake honesty is the receipts leg, P-008). Best-effort: empty on
 *  error / no workspace (mig 434 not applied, single box). */
export async function remoteSessionOwnerIds(workspaceId?: string | null): Promise<Set<string>> {
  if (!workspaceId) return new Set();
  try {
    const rows = await listLiveSessionPresence({
      workspaceId,
      staleMs: PRESENCE_STALE_MS * 4,
    });
    return new Set(rows.map((r) => r.owner_id));
  } catch {
    return new Set();
  }
}

async function readKnownOwnerIds(workspaceId?: string | null): Promise<string[]> {
  const [presenceRes, recordedRes, remoteRes] = await Promise.allSettled([
    listPresence({ workspaceId }),
    listRecordedLiveSessions({ workspaceId }),
    // P-007: the unified-roster leg — remote su-/bee ownerIds from
    // shared_session_presence, so direct addressing, prefix, AND short-handle
    // resolution all work cross-machine (the parity ask). Best-effort.
    remoteSessionOwnerIds(workspaceId),
  ]);
  const ids = new Set<string>();
  if (presenceRes.status === 'fulfilled') {
    for (const p of presenceRes.value) ids.add(p.ownerId);
  }
  if (recordedRes.status === 'fulfilled') {
    for (const s of recordedRes.value) {
      if (s.coordOwnerId) ids.add(s.coordOwnerId);
    }
  }
  if (remoteRes.status === 'fulfilled') {
    for (const id of remoteRes.value) ids.add(id);
  }
  return [...ids];
}

/** Host-bound wrapper: resolve `to` against the UNIFIED roster (local presence
 *  + recorded live sessions + P-007 federated session-grain presence), so a
 *  remote hive peer's su-/bee ownerId resolves exactly like a local one. An
 *  `unknown` is therefore a hard error everywhere: nobody local OR remote
 *  claims the id. */
export async function resolveRecipients(
  to: readonly string[],
  workspaceId?: string | null,
): Promise<RecipientResolution> {
  let knownOwnerIds: string[];
  try {
    knownOwnerIds = await readKnownOwnerIds(workspaceId);
  } catch {
    knownOwnerIds = []; // roster unavailable → fail open below
  }
  // No roster to validate against (empty / unavailable — tests, a fresh box, a
  // federated-only recipient) → DON'T reject; pass everything through. The hard
  // unknown-recipient error only fires when we actually HAVE a roster to check,
  // so an absent roster never turns a legitimate send into a false failure.
  if (knownOwnerIds.length === 0) {
    return { resolved: [...to], unknown: [], ambiguous: [] };
  }
  return resolveRecipientsAgainst(to, knownOwnerIds);
}

/** PURE best-effort core: rewrite each entry to its FULL ownerId when a unique
 *  prefix matches, otherwise leave it UNCHANGED (the silent twin of
 *  resolveRecipientsAgainst — for the shared message/wake layers where a hard
 *  fail would break federation + broadcasts). selector/wildcard, exact match,
 *  ambiguous, and unknown all pass through untouched; only a unique prefix is
 *  rewritten. */
export function resolveBestEffort(
  to: readonly string[],
  knownOwnerIds: readonly string[],
): string[] {
  const known = new Set(knownOwnerIds);
  return to.map((id) => {
    if (isSelectorOrWildcard(id) || known.has(id)) return id;
    let matches = knownOwnerIds.filter((k) => k.startsWith(id));
    if (matches.length === 0) matches = knownOwnerIds.filter((k) => k.includes(id));
    return matches.length === 1 ? matches[0] : id;
  });
}

/** Host wrapper: resolve `to` best-effort against the live roster. SKIPS the
 *  roster read entirely when every entry is a selector/wildcard (broadcasts pay
 *  nothing), and FAILS SOFT (returns `to` unchanged) if the roster read errors —
 *  resolution must never break a send/wake. */
export async function resolveBestEffortAgainstRoster(
  to: readonly string[],
  workspaceId?: string | null,
): Promise<string[]> {
  if (!to.some((id) => !isSelectorOrWildcard(id))) return [...to];
  try {
    return resolveBestEffort(to, await readKnownOwnerIds(workspaceId));
  } catch {
    return [...to];
  }
}
