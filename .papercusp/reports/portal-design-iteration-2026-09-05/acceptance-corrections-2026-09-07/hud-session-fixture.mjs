const text = value => (typeof value === 'string' ? value.trim() : '');

/**
 * The HUD fixture needs a session that is both present in the active roster
 * and attached to a fleet. Recorded/ended sessions are real ids, but they do
 * not render the Fleet toggle that this acceptance case exercises. `ownerId`
 * is the backend-neutral identity consumed by `agentConversation` and the
 * fleet-peer resolver; the legacy `sessionId` is only populated for Claude
 * sessions and must not gate current Codex/OMP rows.
 */
export function isLiveFleetSession(row) {
  return Boolean(
    row &&
      text(row.ownerId) &&
      text(row.fleetSlug) &&
      row.liveness === 'live' &&
      row.stale !== true &&
      row.sessionState !== 'ended',
  );
}

function stableKey(row) {
  return [text(row.ownerId), text(row.fleetSlug), text(row.sessionId)].join('\u0000');
}

/**
 * Resolve the HUD session from an explicit reproduction override or a live
 * roster response. The sort makes a run deterministic when several fleets
 * are active, while still allowing the selected session to rotate as the
 * roster naturally changes.
 */
export function resolveHudSession({ envSession, roster }) {
  const explicit = text(envSession);
  if (explicit) return { sessionOwnerId: explicit, source: 'env' };

  const candidates = (Array.isArray(roster?.active) ? roster.active : [])
    .filter(isLiveFleetSession)
    .sort((a, b) => {
      const left = stableKey(a);
      const right = stableKey(b);
      return left < right ? -1 : left > right ? 1 : 0;
    });
  const selected = candidates[0];
  if (!selected) {
    throw new Error('No live fleet-bearing session is available in /api/adv/roster.active');
  }
  return {
    sessionOwnerId: text(selected.ownerId),
    source: 'live-roster',
    fleetSlug: text(selected.fleetSlug),
    ownerId: text(selected.ownerId) || null,
  };
}

export async function resolveHudSessionFromRoster({ base, envSession, fetchImpl = globalThis.fetch }) {
  const explicit = text(envSession);
  if (explicit) return resolveHudSession({ envSession: explicit });
  if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required to resolve the HUD fixture');

  const rosterUrl = new URL('api/adv/roster', base).toString();
  const response = await fetchImpl(rosterUrl);
  if (!response.ok) {
    throw new Error(`Unable to resolve HUD fixture roster (${response.status} ${response.statusText})`);
  }
  let roster;
  try {
    roster = await response.json();
  } catch (error) {
    throw new Error(`Unable to parse HUD fixture roster: ${error.message}`);
  }
  return { ...resolveHudSession({ roster }), rosterUrl };
}
