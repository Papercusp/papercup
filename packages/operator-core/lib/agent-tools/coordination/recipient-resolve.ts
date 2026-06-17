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
    const matches = knownOwnerIds.filter((k) => k.startsWith(id));
    if (matches.length === 1) resolved.push(matches[0]);
    else if (matches.length > 1) ambiguous.push({ id, matches });
    else unknown.push(id);
  }
  return { resolved, unknown, ambiguous };
}

/** Host-bound wrapper: resolve `to` against the live presence roster (all known
 *  agents in the workspace, live + idle). Local-roster scoped — a cross-instance
 *  federated recipient is not in the local roster, so callers that support
 *  federation must treat `unknown` as advisory there (single-instance: it's a
 *  hard error). */
export async function resolveRecipients(
  to: readonly string[],
  workspaceId?: string | null,
): Promise<RecipientResolution> {
  const presence = await listPresence({ workspaceId });
  return resolveRecipientsAgainst(
    to,
    presence.map((p) => p.ownerId),
  );
}
