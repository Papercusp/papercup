/**
 * fleet-monitor-delta.ts — the PURE fingerprint + diff half of orient's
 * monitor-mode fleet delta (fleet-deltas-leader-primitives-2026-07-10 P-004).
 *
 * A monitor loop re-reads the full fleet:assignments roster every ~60s wake and
 * ~100% of those reads are byte-identical to the previous one (P-010 audit,
 * D-003: coord:glance 200k calls/7d at ~100% exact-repeat; the orient monitor
 * fold is the same shape). What the leader actually watches is TRANSITIONS —
 * a member going speaking→stalled, a claim appearing/lapsing — so the fold
 * delivers exactly those, diffed against the caller's server-side read cursor
 * (read-cursors.ts, ack-on-next-read).
 *
 * The row shape follows the shipped delta protocol's LLM-facing format
 * (agent-tool-delta-protocol-2026-06-22 P-012): { change, type, id, … } —
 * with `from`/`to` fingerprints instead of a `data` payload, because for a
 * monitor the TRANSITION is the datum.
 *
 * IO-free on purpose: composeOrient injects the cursor; tests drive these
 * functions directly.
 */

/** Compact per-member fingerprint — scalars only (the point is to diff, not to
 *  archive). Field names are short because this is persisted per-owner in
 *  coord_read_cursors and re-read every monitor wake. */
export interface MemberFingerprint {
  /** Derived lifecycle verdict (EI-8995): booted|joined|first-turn-done|speaking|stalled|dead. */
  v?: string;
  /** presence sessionState: live|parked|ended. */
  s?: string;
  /** The item currently driven (`doing` id). */
  d?: string;
  /** Claim count. */
  c?: number;
  /** P-007: coarse context-pressure bucket (ok|high|critical) — a member crossing
   *  into high/critical (or recovering) is exactly the kind of transition a
   *  monitor loop should see without re-reading the full roster. */
  p?: string;
  [k: string]: unknown;
}

export interface FleetFingerprint {
  members: Record<string, MemberFingerprint>;
  /** Orphaned/stalled claim counts — the monitor's tripwires. */
  orphaned: number;
  stalled: number;
  [k: string]: unknown;
}

export interface FleetDeltaRow {
  change: 'added' | 'updated' | 'removed';
  type: 'member';
  id: string;
  from?: MemberFingerprint;
  to?: MemberFingerprint;
}

export interface FleetDelta {
  rows: FleetDeltaRow[];
  /** Members present and unchanged — the count the delta saved. */
  unchanged: number;
  /** Orphaned/stalled count transitions (present only when they moved). */
  orphaned?: { from: number; to: number };
  stalled?: { from: number; to: number };
}

interface AssignmentsAgentRow {
  agentId?: unknown;
  verdict?: unknown;
  sessionState?: unknown;
  doing?: unknown;
  claims?: unknown;
  contextPressure?: unknown;
}

/**
 * Project a fleet:assignments result down to the compact fingerprint. Defensive:
 * an unrecognizable shape returns null and the caller keeps the full fold
 * (fail-open — a delta must never make orientation worse than no delta).
 */
export function fingerprintFleet(me: unknown): FleetFingerprint | null {
  const m = me as { agents?: unknown; orphaned?: unknown; stalled?: unknown } | null | undefined;
  if (!m || !Array.isArray(m.agents)) return null;
  const members: Record<string, MemberFingerprint> = {};
  for (const raw of m.agents as AssignmentsAgentRow[]) {
    const id = typeof raw?.agentId === 'string' ? raw.agentId : null;
    if (!id) continue;
    const fp: MemberFingerprint = {};
    if (typeof raw.verdict === 'string') fp.v = raw.verdict;
    if (typeof raw.sessionState === 'string') fp.s = raw.sessionState;
    // `doing` may be a string id or an object row — reduce to a stable id string.
    if (typeof raw.doing === 'string') fp.d = raw.doing.slice(0, 40);
    else if (raw.doing && typeof (raw.doing as { id?: unknown }).id === 'string') {
      fp.d = ((raw.doing as { id: string }).id).slice(0, 40);
    }
    if (typeof raw.claims === 'number') fp.c = raw.claims;
    // P-007: only stamp when a real bucket ('ok'|'high'|'critical') is present —
    // omit for null/absent so an untracked member never diffs as a fake transition.
    if (typeof raw.contextPressure === 'string') fp.p = raw.contextPressure;
    members[id] = fp;
  }
  return {
    members,
    orphaned: Array.isArray(m.orphaned) ? m.orphaned.length : 0,
    stalled: Array.isArray(m.stalled) ? m.stalled.length : 0,
  };
}

function sameFingerprint(a: MemberFingerprint, b: MemberFingerprint): boolean {
  return a.v === b.v && a.s === b.s && a.d === b.d && a.c === b.c && a.p === b.p;
}

/** Diff two fleet fingerprints into transition rows. Pure. */
export function diffFleet(committed: FleetFingerprint, current: FleetFingerprint): FleetDelta {
  const rows: FleetDeltaRow[] = [];
  let unchanged = 0;
  const prev = committed.members ?? {};
  const next = current.members ?? {};
  for (const [id, to] of Object.entries(next)) {
    const from = prev[id];
    if (!from) rows.push({ change: 'added', type: 'member', id, to });
    else if (!sameFingerprint(from, to)) rows.push({ change: 'updated', type: 'member', id, from, to });
    else unchanged += 1;
  }
  for (const [id, from] of Object.entries(prev)) {
    if (!next[id]) rows.push({ change: 'removed', type: 'member', id, from });
  }
  const delta: FleetDelta = { rows, unchanged };
  const co = typeof committed.orphaned === 'number' ? committed.orphaned : 0;
  const cs = typeof committed.stalled === 'number' ? committed.stalled : 0;
  if (co !== current.orphaned) delta.orphaned = { from: co, to: current.orphaned };
  if (cs !== current.stalled) delta.stalled = { from: cs, to: current.stalled };
  return delta;
}

/**
 * The slim `me` a delta-mode monitor result carries instead of the full roster:
 * summary counts + the caller's own row + the orphaned/stalled tripwire lists
 * (small, and always actionable) — the peer rows live in the delta.
 */
export function slimAssignmentsForDelta(me: unknown): unknown {
  const m = me as Record<string, unknown> | null | undefined;
  if (!m || !Array.isArray(m.agents)) return me;
  const selfRow = (m.agents as Array<{ isSelf?: unknown }>).find((a) => a?.isSelf === true);
  return {
    ...m,
    agents: selfRow ? [selfRow] : [],
    agentsElided: (m.agents as unknown[]).length - (selfRow ? 1 : 0),
  };
}
