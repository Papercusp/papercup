/**
 * cells.ts — facts as a WATERMARK SURFACE (P-008 (c), D-012, D-077).
 *
 * D-012 rules that cells are a watermark surface, not a new subscription
 * mechanism: the default tier is a fold into `coord:orient`, which already runs
 * on every wake and already carries watermarked deltas. This module is the pure
 * delta computation that fold uses. Legacy cursors live in `Watermark.cursors`;
 * proof-backed per-cell versions reuse `coord_read_cursors`. Full-body delivery
 * requires the trusted host seam below; constructing a fold never advances it.
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
 * comparison is a plain string compare. A legacy cursor is a single opaque token;
 * body delivery keeps one HLC per scoped key so partial output cannot skip peers.
 * The local `id` sequence would have been easier and is WRONG: it is per-database,
 * so two hives both mint id 5 and cells silently break under federation.
 */

import { createHash } from 'node:crypto';
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
export type DeliveredFactBody = { scope: string; ref: string | null; key: string; cellVersion: FactBodyCell['cellVersion']; body: string };

export function factCellKey(f: { scope: string; scopeRef?: string | null; key: string }): string {
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
 * The host must bind each delivered body to its offered key AND HLC. Text alone
 * cannot identify a cell: a truncated body's prefix can equal another cell's
 * complete body. Shortened, key-only, and unbound rows therefore prove nothing. */
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
  const offeredByKey = new Map(offered.map(cell => [factCellKey(cell), cell]));
  const matchedKeys = new Set<string>();
  for (const row of delivered) {
    if (!row || typeof row.body !== 'string' || typeof row.scope !== 'string' ||
      typeof row.key !== 'string' || !row.cellVersion) continue;
    const identity = factCellKey({ scope: row.scope, scopeRef: row.ref, key: row.key });
    const cell = offeredByKey.get(identity);
    if (!cell || cell.body !== row.body || cell.cellVersion !== row.cellVersion) continue;
    versions[identity] = versions[identity] && versions[identity] > row.cellVersion
      ? versions[identity] : row.cellVersion;
    matchedKeys.add(identity);
  }
  const matched = matchedKeys.size;
  if (matched > 0) await stage(ownerId, FACTS_CELL_SURFACE, { schemaVersion: 1, versions }, { deliveryToken });
  return matched;
}

/** Private native-host metadata. Receipts retain hashes, never fact plaintext. */
export type FactBodyManifest = {
  scope: string; ref: string | null; key: string; cellVersion: string;
  bodySha256: string; bodyBytes: number;
};
export type FactBodyOffer = FactBodyManifest & { rendered: string };

/** One complete line binds identity, HLC and body, including quotes/newlines. */
export function factBodyOffer(f: FactBodyCell): FactBodyOffer | null {
  if (!f.cellVersion) return null;
  const identity = { scope: f.scope, ref: f.scopeRef, key: f.key, cellVersion: f.cellVersion };
  const rendered = `- Standing fact: ${JSON.stringify({ ...identity, body: f.body })}`;
  return { ...identity, rendered, bodySha256: createHash('sha256').update(rendered).digest('hex'),
    bodyBytes: Buffer.byteLength(rendered) };
}

/** Stage the server offer; only a final native emission manifest may confirm it. */
export async function stageNativeFactBodyDelivery(ownerId: string, offers: readonly FactBodyOffer[], token: string): Promise<void> {
  if (!token.trim()) throw new Error('Fact body delivery requires a host emission token');
  const { stage } = await import('../agent-tools/coordination/read-cursors');
  const committed = await readFactBodyCursor(ownerId);
  await stage(ownerId, FACTS_CELL_SURFACE, {
    schemaVersion: 1, versions: committed?.versions ?? {},
    nativeOffer: { token, bodies: offers.map(({ rendered: _rendered, ...manifest }) => manifest) },
  }, { deliveryToken: token });
}

/** Reuse the native stdout token, requiring the receipt's exact final-body subset.
 * An old/key-only hook cannot confirm this offer even if it echoes that token. */
export async function confirmNativeFactBodyDelivery(
  ownerId: string, token: string | null, delivered: readonly FactBodyManifest[],
): Promise<FactBodyCursor | null> {
  const { ackAndRead, stage } = await import('../agent-tools/coordination/read-cursors');
  // Deliberately do not promote the offered candidate on the shared token alone.
  const ack = await ackAndRead(ownerId, FACTS_CELL_SURFACE, { confirmedToken: null });
  const committed = factBodyCursor(ack.committed);
  const candidate = ack.unconfirmedPending?.nativeOffer as { token?: unknown; bodies?: FactBodyManifest[] } | undefined;
  if (!token || candidate?.token !== token || !Array.isArray(candidate.bodies)) return committed;
  const versions = { ...(committed?.versions ?? {}) };
  let matched = false;
  for (const body of candidate.bodies) {
    if (!delivered.some(row => row && row.scope === body.scope && row.ref === body.ref &&
      row.key === body.key && row.cellVersion === body.cellVersion &&
      row.bodySha256 === body.bodySha256 && row.bodyBytes === body.bodyBytes)) continue;
    const key = factCellKey({ scope: body.scope, scopeRef: body.ref, key: body.key });
    versions[key] = versions[key] && versions[key] > body.cellVersion ? versions[key] : body.cellVersion;
    matched = true;
  }
  if (!matched) return committed;
  await stage(ownerId, FACTS_CELL_SURFACE, { schemaVersion: 1, versions }, { deliveryToken: token });
  return readFactBodyCursor(ownerId, token);
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
