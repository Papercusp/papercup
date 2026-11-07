/**
 * cells.ts — facts as a WATERMARK SURFACE (P-008 (c), D-012, D-077).
 *
 * D-012 rules that cells are a watermark surface, not a new subscription
 * mechanism: the default tier is a fold into `coord:orient`, which already runs
 * on every wake and already carries watermarked deltas. This module is the pure
 * delta computation that fold uses; the cursor itself lives in the agent's
 * existing `Watermark.cursors` map (the open surface map added by D-077).
 *
 * WHY THE FULL FOLD STAYS
 * -----------------------
 * This does NOT turn the facts fold into a delta-only read, and that is the
 * point of the watermark design rather than an oversight. D-012's decisive
 * property is: *"read with watermark 0 and you get current state … a cold-started,
 * compacted, respawned or newly-joined agent is correct immediately, with no
 * replay and no subscription registration to lose."* A delta-only fold would
 * reintroduce exactly the miss-the-event-and-you-are-wrong failure that argument
 * rejects. So orient keeps folding current state, and this module answers the
 * separate question layered on top: *which of these did I not already have?*
 *
 * THE CURSOR IS THE HLC, NOT THE ROW ID
 * -------------------------------------
 * Per D-012's hard constraint, cell versions ride the existing HLC scheme
 * (`agent_facts.fed_hlc`, stamped by migration 693 — see D-077 for why that
 * migration was needed at all). An HLC is a total order by construction, so
 * comparison is a plain string compare and the cursor is a single opaque token.
 * The local `id` sequence would have been easier and is WRONG: it is per-database,
 * so two hives both mint id 5 and cells silently break under federation.
 */

import type { AgentFact } from './store';

/**
 * The `Watermark.cursors` key under which an agent's facts-surface position is
 * stored. One key for the whole facts surface: the fold is already scoped by
 * selector (workspace + owner + harness), so a per-scope cursor would fragment
 * the position without making any consumer more precise.
 */
export const FACTS_CELL_SURFACE = 'facts';

/** Body receipts extend the existing read-cursor store, never the legacy maximum
 * watermark. A subset can prove one scoped cell without proving its siblings. */
export type FactBodyCursor = { schemaVersion: 1; versions: Record<string, string> };
export type FactBodyCell = Pick<AgentFact, 'scope' | 'scopeRef' | 'key' | 'body' | 'cellVersion'>;
export type DeliveredFactBody = { scope: string; ref: string | null; body: string };

export function factCellKey(f: Pick<FactBodyCell, 'scope' | 'scopeRef' | 'key'>): string {
  return JSON.stringify([f.scope, f.scopeRef ?? '', f.key]);
}

function factBodyCursor(value: unknown): FactBodyCursor | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Partial<FactBodyCursor>;
  if (row.schemaVersion !== 1 || !row.versions || typeof row.versions !== 'object' || Array.isArray(row.versions)) return null;
  if (!Object.values(row.versions).every(v => typeof v === 'string' && v.length > 0)) return null;
  return { schemaVersion: 1, versions: { ...row.versions } };
}

/** Trusted host seam, not a model/tool argument. Omission is explicitly NO
 * proof; the generic store's legacy ACK-on-arrival must never consume facts. */
export async function readFactBodyCursor(ownerId: string, confirmedToken: string | null = null): Promise<FactBodyCursor | null> {
  const { ackAndRead } = await import('../agent-tools/coordination/read-cursors');
  const ack = await ackAndRead(ownerId, FACTS_CELL_SURFACE, { confirmedToken });
  return factBodyCursor(ack.committed);
}

/** Stage only complete bodies present in the host's FINAL emitted view. Call
 * this from a host that can later prove emission with the same token. Building
 * an orient result, returning it over MCP, and rendering fact KEYS cannot call
 * this seam as if they proved body delivery. Unsupported hosts keep replaying.
 *
 * Match a multiset of exact scoped bodies: shortened/key-only rows match none.
 * If identical bodies hide distinct keys, consume that group only when every
 * member is present; guessing which omitted key arrived would invent proof. */
export async function stageFactBodyDelivery(
  ownerId: string,
  offered: readonly FactBodyCell[],
  delivered: readonly DeliveredFactBody[],
  deliveryToken: string,
): Promise<number> {
  if (!deliveryToken.trim()) throw new Error('Fact body delivery requires a host emission token');
  const { stage } = await import('../agent-tools/coordination/read-cursors');
  // Discard an older unconfirmed offer, retaining ONLY committed per-cell floors.
  const committed = await readFactBodyCursor(ownerId);
  const versions = { ...(committed?.versions ?? {}) };
  const bodyKey = (scope: string, ref: string | null, body: string) => JSON.stringify([scope, ref ?? '', body]);
  const counts = new Map<string, number>();
  for (const row of delivered) {
    if (!row || typeof row.body !== 'string' || typeof row.scope !== 'string') continue;
    const key = bodyKey(row.scope, row.ref, row.body);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const groups = new Map<string, FactBodyCell[]>();
  for (const cell of offered) {
    const key = bodyKey(cell.scope, cell.scopeRef, cell.body);
    const group = groups.get(key) ?? [];
    group.push(cell);
    groups.set(key, group);
  }
  let matched = 0;
  for (const [key, cells] of groups) {
    if ((counts.get(key) ?? 0) < cells.length) continue;
    for (const cell of cells) {
      if (!cell.cellVersion) continue;
      const identity = factCellKey(cell);
      versions[identity] = versions[identity] && versions[identity] > cell.cellVersion
        ? versions[identity] : cell.cellVersion;
      matched++;
    }
  }
  if (matched > 0) await stage(ownerId, FACTS_CELL_SURFACE, { schemaVersion: 1, versions }, { deliveryToken });
  return matched;
}

export interface FactsCellDelta {
  /**
   * Facts whose cell version is strictly newer than the reader's cursor —
   * i.e. asserted or superseded since it last looked. Empty on a bootstrap read.
   */
  changed: readonly AgentFact[];
  /** The cursor to persist. Never moves backward; equals `cursor` when nothing newer was seen. */
  nextCursor: string;
  /**
   * True when the reader had no cursor at all (first read ever, or a cleared
   * watermark). The fold reports NOTHING as changed in this case — see below.
   */
  bootstrap: boolean;
}

/**
 * Compare `facts` against a reader's `cursor` and report what moved.
 *
 * ⚠ BOOTSTRAP IS DELIBERATELY SILENT. With no prior cursor, every versioned fact
 * is trivially "newer than nothing" — reporting them all as *changed* would tell a
 * fresh agent that its entire standing context just changed, on the one read where
 * that is least true and least useful. The honest reading of a first fold is "here
 * is current state", which the fold already delivers. So a bootstrap read marks
 * nothing changed and simply records the position; the NEXT fold reports real
 * movement against it.
 *
 * A fact with no `cellVersion` (a row written before migration 693 and not
 * rewritten since) can never be reported as changed — it carries no version to
 * compare, and inventing one would be the version-counter D-012 forbids. Such rows
 * self-heal the first time they are written.
 */
export function factsCellDelta(facts: readonly AgentFact[], cursor: string | FactBodyCursor | undefined | null): FactsCellDelta {
  const proven = typeof cursor === 'object' && cursor !== null ? cursor : null;
  const from = typeof cursor === 'string' ? cursor.trim() : '';
  const bootstrap = proven ? Object.keys(proven.versions).length === 0 : from === '';

  let max = from;
  const changed: AgentFact[] = [];
  for (const f of facts) {
    const v = f.cellVersion;
    if (typeof v !== 'string' || v === '') continue; // unversioned → not comparable
    if (v > max) max = v;
    if (!bootstrap && v > (proven ? (proven.versions[factCellKey(f)] ?? '') : from)) changed.push(f);
  }

  return { changed, nextCursor: max, bootstrap };
}
