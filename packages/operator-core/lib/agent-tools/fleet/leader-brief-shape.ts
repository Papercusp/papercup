/**
 * Payload-tier projection for fleet:leader-brief.
 *
 * The handler computes a deliberately rich diagnostic snapshot. That snapshot
 * is useful to in-process callers, but a default MCP read must leave room for
 * the result-door envelope. Keep the monitor decision core here and make every
 * variable-size field bounded before the framework serializes it.
 */

export type LeaderBriefPayloadTier = 'trimmed' | 'standard';

/** Leave margin below the universal ~6KB result door for its JSON envelope. */
export const LEADER_BRIEF_SHAPER_BUDGET_CHARS = 5_000;

type Dict = Record<string, unknown>;

const TIER_CAPS: Record<LeaderBriefPayloadTier, {
  memberVerdicts: number;
  members: number;
  advisories: number;
  invariants: number;
  reservationMembers: number;
}> = {
  trimmed: { memberVerdicts: 6, members: 3, advisories: 2, invariants: 2, reservationMembers: 2 },
  standard: { memberVerdicts: 10, members: 6, advisories: 3, invariants: 3, reservationMembers: 3 },
};

const clip = (value: unknown, max = 180): string | null => {
  if (typeof value !== 'string') return null;
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
};

function asDict(value: unknown): Dict | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Dict) : null;
}

function pick(value: unknown, keys: readonly string[], maxString = 180): Dict | null {
  const source = asDict(value);
  if (!source) return null;
  const out: Dict = {};
  for (const key of keys) {
    if (!(key in source)) continue;
    const v = source[key];
    out[key] = typeof v === 'string' ? clip(v, maxString) : v;
  }
  return out;
}

function compactFalsifier(value: unknown): unknown {
  return pick(value, ['tool', 'check', 'measurement', 'kills'], 220) ?? value;
}

function compactBlockedAt(value: unknown): unknown {
  const source = asDict(value);
  if (!source) return value;
  const out = pick(source, ['layer', 'reason', 'remedy'], 220) ?? {};
  if (Array.isArray(source.subordinate)) {
    out.subordinate = source.subordinate.slice(0, 3).map((entry) => compactFalsifier(entry));
    if (source.subordinate.length > 3) out.subordinateTruncated = source.subordinate.length;
  }
  if ('falsifier' in source) out.falsifier = compactFalsifier(source.falsifier);
  return out;
}

function compactSummary(value: unknown, ultra = false): unknown {
  const source = asDict(value);
  if (!source) return value;
  const metricKeys = [
    'fleet',
    'members',
    'speaking',
    'monitoring',
    'waiting',
    'parked_awaiting_capability',
    'stalled',
    'dead',
    'unanswered_directed',
    'high_context',
    'critical_context',
    'parked',
    'coord_deaf',
    'bench_suggested',
    'idle_with_claimable',
    'laneless_idle',
    'dormant',
    'spinning',
    'throttled',
    'claimable_now',
    'unowned_criticals',
    'unowned_criticals_federated',
    'abandoned_unclaimed',
    'admission_blocked',
    'fleet_paused',
  ];
  const out = pick(source, metricKeys, 120) ?? {};

  const population = pick(source.population, ['population', 'basis', 'candidates', 'counted', 'withheld', 'withheldReason', 'reveal'], 150);
  if (population) out.population = population;

  const claimableSpec = pick(source.claimable_now_spec, ['claimable', 'matchedByFilter', 'spec', 'note'], 150);
  if (claimableSpec) {
    const spec = asDict(claimableSpec.spec);
    if (spec) claimableSpec.spec = pick(spec, ['ref', 'harness', 'revision'], 120) ?? {};
    out.claimable_now_spec = claimableSpec;
  }

  const pool = pick(source.pool_capacity, ['poolExhausted', 'degraded', 'factor', 'queueDepth', 'usableAccounts', 'availableAccounts'], 120);
  if (pool) out.pool_capacity = pool;

  if (!ultra && Array.isArray(source.degraded_roster_legs)) {
    out.degraded_roster_legs = source.degraded_roster_legs.slice(0, 3).map((entry) => clip(entry, 160) ?? entry);
    if (source.degraded_roster_legs.length > 3) out.degraded_roster_legs_truncated = source.degraded_roster_legs.length;
  }
  return out;
}

function compactMember(value: unknown): unknown {
  const source = asDict(value);
  if (!source) return value;
  const out = pick(source, [
    'agentId',
    'label',
    'alive',
    'sessionState',
    'verdict',
    'wakeMode',
    'monitorState',
    'nextFireAt',
    'lastToolCallAgeMs',
    'queuedCount',
    'load',
    'stalled',
    'contextPressure',
    'dormant',
    'spinning',
    'isSelf',
  ], 120) ?? {};
  if (source.idleVerdict && typeof source.idleVerdict === 'object') {
    out.idleVerdict = pick(source.idleVerdict, ['cause', 'reason'], 160) ?? source.idleVerdict;
  }
  if (source.doing && typeof source.doing === 'object') {
    out.doing = pick(source.doing, ['id', 'title', 'status', 'activity'], 140) ?? source.doing;
  }
  if (source.unanswered && typeof source.unanswered === 'object') {
    out.unanswered = pick(source.unanswered, ['count', 'oldestAgeMs'], 100) ?? source.unanswered;
  }
  if (Array.isArray(source.parkedOn) && source.parkedOn.length > 0) {
    out.parkedOn = source.parkedOn.slice(0, 3).map((entry) => clip(entry, 140) ?? entry);
  }
  if (source.benchSuggestion && typeof source.benchSuggestion === 'object') {
    out.benchSuggestion = pick(source.benchSuggestion, ['kind', 'item', 'itemTitle', 'reason'], 160) ?? source.benchSuggestion;
  }
  if (source.throttled && typeof source.throttled === 'object') {
    out.throttled = pick(source.throttled, ['reason', 'until', 'resumesInMs'], 120) ?? source.throttled;
  }
  return out;
}

function compactVerdict(value: unknown): unknown {
  return pick(value, ['agentId', 'verdict', 'idleCause'], 120) ?? value;
}

function compactAdvisory(value: unknown): unknown {
  const source = asDict(value);
  if (!source) return value;
  const keys = [
    'id',
    'workItemId',
    'itemId',
    'title',
    'summary',
    'status',
    'priority',
    'assignee',
    'holder',
    'origin',
    'activity',
    'progress',
  ];
  return pick(source, keys, 160) ?? {};
}

/**
 * EI-18680302159738037: a fleet-scope admission block, bounded for the monitor
 * transport. `itemId`/`member`/`specId`/`specRevision` are the ACTIONABLE core
 * (what was refused, to whom, and which spec+revision the leader edits) and are
 * kept whole; `reason` is the one field that can be long, so it clips.
 */
function compactAdmissionBlock(value: unknown): unknown {
  return pick(value, [
    'itemId',
    'member',
    'specId',
    'specRevision',
    'code',
    'occurrences',
    'action',
    'reason',
  ], 160) ?? {};
}

function compactInvariant(value: unknown): unknown {
  const source = asDict(value);
  if (!source) return value;
  const out = pick(source, ['name', 'severity', 'status', 'violationCount', 'truncated', 'error', 'elapsedMs'], 160) ?? {};
  if (Array.isArray(source.rows)) {
    out.rows = source.rows.slice(0, 2).map((row) => {
      const record = asDict(row);
      if (!record) return row;
      const clipped: Dict = {};
      for (const [key, item] of Object.entries(record).slice(0, 8)) {
        clipped[key] = typeof item === 'string' ? clip(item, 120) : typeof item === 'number' || typeof item === 'boolean' || item === null ? item : String(item);
      }
      return clipped;
    });
    if (source.rows.length > 2) out.rowsTruncated = source.rows.length;
  }
  return out;
}

function compactReservation(value: unknown, cap: number): unknown {
  const source = asDict(value);
  if (!source) return value;
  const out = pick(source, ['scarcity', 'counts', 'reason', 'note'], 160) ?? {};
  if (Array.isArray(source.members)) {
    out.members = source.members.slice(0, cap).map((entry) => compactMember(entry));
    if (source.members.length > cap) out.membersTruncated = { total: source.members.length, shown: cap };
  }
  return out;
}

function compactCampaignValue(value: unknown, recentCap: number, depth = 0): unknown {
  if (typeof value === 'string') return clip(value, depth <= 1 ? 150 : 100) ?? value;
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, recentCap).map((entry) => compactCampaignValue(entry, recentCap, depth + 1));
  const source = asDict(value);
  if (!source) return String(value);
  const out: Dict = {};
  for (const [key, item] of Object.entries(source).slice(0, depth >= 3 ? 10 : 20)) {
    if (key === 'rows' && Array.isArray(item)) {
      out.rows = item.slice(0, recentCap).map((entry) => compactCampaignValue(entry, recentCap, depth + 1));
      continue;
    }
    out[key] = compactCampaignValue(item, recentCap, depth + 1);
  }
  return out;
}

/** P-007: keep every campaign axis' availability/writer/units while bounding only
 * recent evidence rows. Exact aggregate scalars and the boundary always survive. */
export function compactCampaign(value: unknown, recentCap = 2): unknown {
  const source = asDict(value);
  if (!source) return value;
  const out: Dict = {};
  if ('boundary' in source) out.boundary = compactCampaignValue(source.boundary, recentCap);
  if ('everMembers' in source) out.everMembers = compactCampaignValue(source.everMembers, recentCap);
  const axes = asDict(source.axes);
  if (axes) {
    const projected: Dict = {};
    for (const [name, axis] of Object.entries(axes)) {
      projected[name] = compactCampaignValue(axis, recentCap);
    }
    out.axes = projected;
  }
  return out;
}

function addCappedArray(out: Dict, source: Dict, key: string, cap: number, project: (value: unknown) => unknown): void {
  const rows = source[key];
  if (!Array.isArray(rows)) return;
  out[key] = rows.slice(0, cap).map(project);
  if (rows.length > cap) out[`${key}Truncated`] = { total: rows.length, shown: cap, more: 'fleet:leader-brief { payloadTier:"full" } or a narrow follow-up' };
}

function addAlertFields(out: Dict, source: Dict): void {
  for (const [key, value] of Object.entries(source)) {
    // EI-18680302159738037: `*Action` joins the carried set. An advisory's RESOLVING
    // ACTION was being computed and then dropped by this projection, so the default
    // monitor read showed a count and rows with no remedy — and for both advisories
    // that emit one, the intuitive remedy is the WRONG verb (release is a no-op on
    // abandonedUnclaimed; a nudge cannot clear an admission block). Clipped like a
    // reason, so a long note cannot crowd out the decision core.
    if (!/(?:AlertReason|AlertFalsifier|Action)$/.test(key) && key !== 'customInvariantAlertReason' && key !== 'fleetPausedReason') continue;
    out[key] = key.endsWith('Falsifier') ? compactFalsifier(value) : clip(value, 220) ?? value;
  }
}

function buildProjection(
  data: Dict,
  tier: LeaderBriefPayloadTier,
  caps: typeof TIER_CAPS.trimmed,
  campaignRecentRows: number,
): Dict {
  const out: Dict = { ok: data.ok === true };
  for (const key of ['self', 'notLeader', 'leadershipClaimed']) {
    if (key in data) out[key] = pick(data[key], ['ownerId', 'ownerLabel', 'registeredLeader', 'leaderState', 'reason', 'note', 'claimWith', 'previousLeader', 'notified'], 180) ?? data[key];
  }
  if ('blockedAt' in data) out.blockedAt = compactBlockedAt(data.blockedAt);
  if ('summary' in data) out.summary = compactSummary(data.summary);
  if ('deltaSummary' in data) out.deltaSummary = clip(data.deltaSummary, 220) ?? data.deltaSummary;
  if ('delta' in data) out.delta = data.delta;
  if ('campaign' in data) out.campaign = compactCampaign(data.campaign, campaignRecentRows);
  if ('idleCauses' in data) out.idleCauses = data.idleCauses;
  if ('reservation' in data) out.reservation = compactReservation(data.reservation, caps.reservationMembers);

  addCappedArray(out, data, 'memberVerdicts', caps.memberVerdicts, compactVerdict);
  addCappedArray(out, data, 'members', caps.members, compactMember);
  for (const key of ['unownedCriticals', 'unownedCriticalsFederated', 'abandonedUnclaimed', 'orphanedInFlight']) {
    addCappedArray(out, data, key, caps.advisories, compactAdvisory);
  }
  // EI-18680302159738037: admission blocks project through their OWN compactor —
  // compactAdvisory's key set (workItemId/title/status/assignee/…) shares not one
  // field with a block, so routing them through it would emit `{}` per row: a
  // count with rows that say nothing, which is how this signal got ignored the
  // first time.
  addCappedArray(out, data, 'admissionBlocked', caps.advisories, compactAdmissionBlock);
  if (Array.isArray(data.customInvariants)) {
    addCappedArray(out, data, 'customInvariants', caps.invariants, compactInvariant);
  }
  addAlertFields(out, data);

  for (const key of ['specRevision', 'specUpdatedBy', 'specUpdatedAt', 'harnessWidePool', 'specMatched', 'fleetPausedReason']) {
    if (key in data) out[key] = typeof data[key] === 'string' ? clip(data[key], 180) : data[key];
  }
  if (data.specFilter !== undefined) {
    const serialized = (() => {
      try { return JSON.stringify(data.specFilter); } catch { return ''; }
    })();
    if (serialized.length <= 500) out.specFilter = data.specFilter;
    else out.specFilterOmitted = { reason: 'bounded for monitor transport', chars: serialized.length, more: 'scheduler:get_claim_spec { fleet }' };
  }

  out.leaderBriefProjection = {
    tier,
    memberVerdicts: Array.isArray(data.memberVerdicts) ? { shown: Math.min(caps.memberVerdicts, data.memberVerdicts.length), total: data.memberVerdicts.length } : undefined,
    members: Array.isArray(data.members) ? { shown: Math.min(caps.members, data.members.length), total: data.members.length } : undefined,
    note: 'Default monitor projection keeps the decision core; use payloadTier:"full" or narrow follow-up reads for detail.',
  };
  return out;
}

/**
 * Shape both declared tiers with the same monitor contract. `standard` keeps a
 * few more rows, while the hard-ceiling path invokes `trimmed` so the default
 * full call remains below the result door too.
 */
export function shapeLeaderBrief(data: unknown, tier: LeaderBriefPayloadTier): unknown {
  const source = asDict(data);
  if (!source) return data;
  const initial = TIER_CAPS[tier];
  const attempts = [
    { caps: initial, campaignRecentRows: tier === 'trimmed' ? 1 : 2 },
    {
      caps: { ...initial, memberVerdicts: 4, members: 2, advisories: 1, invariants: 1, reservationMembers: 1 },
      campaignRecentRows: 1,
    },
    {
      caps: { memberVerdicts: 2, members: 1, advisories: 1, invariants: 1, reservationMembers: 1 },
      // Preserve every campaign axis and its exact aggregates before sacrificing
      // the pre-existing truthful truncation pointers. Recent rows remain
      // available from a standard/full follow-up and are the only lossy field.
      campaignRecentRows: 0,
    },
    {
      // Last normal projection: retain one actionable member row plus truthful
      // zero-shown pointers for every other high-fanout family. This is still
      // materially richer than the emergency tier and keeps campaign aggregates.
      caps: { memberVerdicts: 1, members: 1, advisories: 0, invariants: 0, reservationMembers: 0 },
      campaignRecentRows: 0,
    },
  ];
  for (const attempt of attempts) {
    const out = buildProjection(source, tier, attempt.caps, attempt.campaignRecentRows);
    if (JSON.stringify(out).length <= LEADER_BRIEF_SHAPER_BUDGET_CHARS) return out;
  }
  // A pathological invariant/reason string must not defeat the safety rail.
  const emergency: Dict = {
    ok: source.ok === true,
    ...(source.blockedAt !== undefined ? { blockedAt: compactBlockedAt(source.blockedAt) } : {}),
    ...(source.summary !== undefined ? { summary: compactSummary(source.summary, true) } : {}),
    leaderBriefProjection: { tier, emergency: true, note: 'Further optional detail was omitted to keep the monitor response valid JSON.' },
  };
  // Emergency is a byte-pressure tier, not permission to turn bounded arrays
  // into unexplained omissions. Keep one actionable member/verdict and retain
  // truthful zero-shown pointers for every dropped family.
  addCappedArray(emergency, source, 'memberVerdicts', 1, compactVerdict);
  addCappedArray(emergency, source, 'members', 1, compactMember);
  for (const key of ['unownedCriticals', 'unownedCriticalsFederated', 'abandonedUnclaimed', 'orphanedInFlight']) {
    addCappedArray(emergency, source, key, 0, compactAdvisory);
  }
  addCappedArray(emergency, source, 'admissionBlocked', 0, compactAdmissionBlock);
  addCappedArray(emergency, source, 'customInvariants', 0, compactInvariant);
  if (source.specFilter !== undefined) {
    emergency.specFilterOmitted = {
      reason: 'bounded for monitor transport',
      chars: (() => { try { return JSON.stringify(source.specFilter).length; } catch { return null; } })(),
      more: 'scheduler:get_claim_spec { fleet }',
    };
  }
  if (source.campaign !== undefined) {
    const campaign = compactCampaign(source.campaign, 0);
    if (JSON.stringify({ ...emergency, campaign }).length <= LEADER_BRIEF_SHAPER_BUDGET_CHARS) {
      emergency.campaign = campaign;
    }
  }
  return emergency;
}
