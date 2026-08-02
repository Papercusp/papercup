'use client';

/**
 * AgentOrders — the LEFT panel of the session popup's two-panel dossier
 * (session-chat-popup-direction-d-2026-08-02 P-014, owner ask 2026-08-02:
 * "Two panels: told on the left, did on the right").
 *
 * ── Why left, and why a separate panel at all ───────────────────────────────
 * With Orders on the left the three columns read in CAUSAL order: what the
 * agent was told → the conversation → what the agent did. The right rail
 * (AgentDossier) is behaviour; this one is the instructions that produced it.
 * They also change at completely different rates — orders shift when a mode
 * flips or a fact is asserted (minutes to days), activity shifts every turn —
 * and mixing those two cadences in one column is what made the original rail
 * read as a wall of text.
 *
 * ── The content rule (owner ask, verbatim) ──────────────────────────────────
 * "EVERYTHIGN that could be returnied from orient/the carry brief that you
 * showed me were missing from the panel should be in the panel. So make a spot
 * for all these things." Every field the orient/carry-brief diff identified has
 * a section here, including the ones that are usually empty — an empty section
 * that NAMES what it would hold is how a reader learns the signal exists.
 *
 * ── Three states, never two (plan D-003) ────────────────────────────────────
 * "The read failed", "genuinely none", and "the agent never wrote one" are
 * three different conclusions about an agent's health. `unavailable` carries
 * the first, `neverWritten` the third, and neither is allowed to render as the
 * plain empty state. This is the `unavailableSignals` lesson
 * (EI-18694403367371331) applied to a whole panel.
 *
 * ── Staleness is rendered, not buried ───────────────────────────────────────
 * The carry data model carries three fields that exist purely to DATE it, plus
 * the cited-ref drift tell. A checkpoint written a dozen turns ago is close to
 * worthless, so its age renders at the same weight as its content — and its
 * severity is graded against the agent's carry mode, because for a COLD agent
 * the checkpoint IS its memory across wakes.
 */

import { useMemo } from 'react';
import {
  carryStaleness,
  formatAgeShort,
  useAgentOrders,
  type AgentOrders as AgentOrdersDTO,
  type AgentOrdersSignalKey,
} from './use-agent-orders';
import { RailSectionHead, useRailCollapse } from './rail-sections';
import './AgentOrders.css';

/** A section that could not be read, rendered so it can never be mistaken for
 *  an empty one. */
function Unavailable({ what }: { what: string }): React.JSX.Element {
  return (
    <div className="pc-orders__unavailable" data-testid="orders-unavailable">
      ⚠ couldn’t read {what} — this is not “none”
    </div>
  );
}

function Empty({ text }: { text: string }): React.JSX.Element {
  return <div className="pc-orders__empty">{text}</div>;
}

/** Age chip whose tone is graded against the agent's carry mode. */
function AgeChip({
  atMs,
  mode,
  nowMs,
}: {
  atMs: number | null | undefined;
  mode: 'warm' | 'cold' | null;
  nowMs: number;
}): React.JSX.Element | null {
  if (atMs == null) return null;
  const age = nowMs - atMs;
  const verdict = carryStaleness(age, mode);
  const label = formatAgeShort(age);
  if (!label) return null;
  return (
    <span className={`pc-orders__age pc-orders__age--${verdict}`} data-verdict={verdict}>
      {label}
    </span>
  );
}

export interface AgentOrdersProps {
  ownerId: string;
  /** False while the panel is collapsed — skips the fetch entirely. */
  enabled?: boolean;
  onClose?: () => void;
}

export default function AgentOrders({
  ownerId,
  enabled = true,
  onClose,
}: AgentOrdersProps): React.JSX.Element {
  const { orders, error, loading } = useAgentOrders(ownerId || null, enabled);
  const nowMs = useMemo(() => Date.now(), []);
  /* Collapse state lives in the URL, shared with the Activity rail — see
     rail-sections.tsx for why one param and why not useState. */
  const rail = useRailCollapse();

  const unavailable = useMemo(
    () => new Set<AgentOrdersSignalKey>(orders?.unavailable ?? []),
    [orders?.unavailable],
  );

  const carry = orders?.carry ?? null;
  const carryMode = carry?.mode ?? null;

  return (
    <aside className="pc-orders" aria-label="Agent orders" data-testid="agent-orders">
      {/* The ZONE title (owner-approved Framed look, artifact 6379bb65): a
          vertical zone is tall and narrow, so a full-width filled bar across its
          top costs nothing you care about — unlike the three horizontal bands,
          which are named by an inline cap inside their existing row. It is
          sticky, so the column never scrolls away from its own name. */}
      <header className="pc-orders__tag pc-zone-title">
        <span className="pc-orders__tag-name">Orders</span>
        {/* "they", not "it" [owner 2026-08-02]: an agent is referred to as a
            person throughout this UI, and the singular they keeps that voice
            without gendering a session. */}
        <span className="pc-orders__tag-sub pc-zone-title__sub">— what they were told</span>
        {onClose ? (
          <button
            type="button"
            className="pc-orders__close pc-zone-title__close"
            onClick={onClose}
            aria-label="Hide orders panel"
            data-testid="agent-orders-close"
          >
            ✕
          </button>
        ) : null}
      </header>

      {/* The whole payload is new on the wire (see use-agent-orders.ts): an
          operator predating it serves nothing, which must read as "this
          operator can't answer", never as "the agent has no orders". */}
      {!orders && !loading ? (
        <div className="pc-orders__sec">
          <Unavailable what={error ? `orders (${error})` : 'orders from this operator'} />
        </div>
      ) : null}
      {!orders && loading ? (
        <div className="pc-orders__sec">
          <Empty text="Loading orders…" />
        </div>
      ) : null}

      {orders ? (
        <>
          {/* ── Mission: the section that explains every other section ── */}
          <section
            className="pc-orders__sec pc-orders__sec--mission"
            id="pc-orders-mission"
            data-collapsed={rail.closed('o-mission') ? 'true' : 'false'}
          >
            <RailSectionHead
              sectionId="o-mission"
              label="Mission"
              className="pc-orders__h"
              closed={rail.closed('o-mission')}
              onToggle={() => rail.toggle('o-mission')}
            />
            {unavailable.has('mission') ? (
              <Unavailable what="the instruction precedence" />
            ) : orders.mission ? (
              <>
                <div className="pc-orders__kv">
                  <span className="k">effective</span>
                  <span className="v">{orders.mission.constraint ?? '—'}</span>
                </div>
                <div className="pc-orders__kv">
                  <span className="k">authority</span>
                  <span
                    className="v"
                    data-authority={orders.mission.authority ?? undefined}
                  >
                    {orders.mission.authority ?? '—'}
                  </span>
                </div>
                <div className="pc-orders__kv">
                  <span className="k">route</span>
                  <span className="v">{orders.mission.route ?? '—'}</span>
                </div>
                {orders.mission.explanation ? (
                  <p className="pc-orders__note">{orders.mission.explanation}</p>
                ) : null}
                {/* Nothing else in the UI can answer "why is this agent
                    ignoring that rule?" — a suppressed rule looks identical to
                    a disobeyed one until you can see the suppression. */}
                {(orders.mission.suppressed ?? []).length > 0 ? (
                  <div className="pc-orders__suppressed" data-testid="orders-suppressed">
                    {(orders.mission.suppressed ?? []).map((s, i) => (
                      <div className="pc-orders__row" key={`${s.key}:${s.value}:${i}`}>
                        <span className="pc-orders__glyph pc-orders__glyph--off">◇</span>
                        <span className="pc-orders__txt" title={s.reason}>
                          suppressed: {s.value}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </>
            ) : (
              <Empty text="No resolved mission on record." />
            )}
          </section>

          {/* ── Modes + wake mode ── */}
          <section
            className="pc-orders__sec"
            id="pc-orders-modes"
            data-collapsed={rail.closed('o-modes') ? 'true' : 'false'}
          >
            <RailSectionHead
              sectionId="o-modes"
              label="Modes"
              className="pc-orders__h"
              closed={rail.closed('o-modes')}
              onToggle={() => rail.toggle('o-modes')}
            >
              {(orders.modes ?? []).length > 0 ? (
                <span className="pc-orders__n">{(orders.modes ?? []).length}</span>
              ) : null}
            </RailSectionHead>
            {unavailable.has('modes') ? (
              <Unavailable what="the mode registry" />
            ) : (orders.modes ?? []).length > 0 ? (
              (orders.modes ?? []).map((m) => (
                <div className="pc-orders__row" key={m.mode}>
                  <span
                    className={`pc-orders__glyph ${m.ownerDirected ? 'pc-orders__glyph--owner' : ''}`}
                    title={m.ownerDirected ? 'owner-directed' : 'set by the agent itself'}
                  >
                    ◆
                  </span>
                  <span className="pc-orders__txt">
                    <b>{m.mode.toUpperCase()}</b>
                    {m.ownerDirected ? (
                      <span className="pc-orders__badge">owner</span>
                    ) : m.setBy ? (
                      <span className="pc-orders__badge pc-orders__badge--self">self</span>
                    ) : null}
                    {m.reason ? <span className="pc-orders__reason">{m.reason}</span> : null}
                  </span>
                </div>
              ))
            ) : (
              <Empty text="No modes registered — default posture." />
            )}

            {/* Wake mode is here because it is an instruction ABOUT the agent,
                and because it is load-bearing for the composer directly above:
                a manual-mode agent has every wake STAGED, so a message sent
                from this popup is a silent no-op reported as "Sent". */}
            {unavailable.has('wakeMode') ? (
              <Unavailable what="wake mode" />
            ) : orders.wakeMode ? (
              <div className="pc-orders__kv" data-testid="orders-wake-mode">
                <span className="k">wakes</span>
                <span className="v" data-wake={orders.wakeMode.effective}>
                  {orders.wakeMode.effective === 'manual'
                    ? 'manual — staged for you to release'
                    : 'auto — delivered immediately'}
                  {orders.wakeMode.overridden ? (
                    <span className="pc-orders__badge">override</span>
                  ) : null}
                </span>
              </div>
            ) : null}
          </section>

          {/* ── Owner directives, verbatim ── */}
          <section className="pc-orders__sec" id="pc-orders-directives">
            <h4 className="pc-orders__h">
              Owner directives
              {(orders.directivesTotalOpen ?? 0) > 0 ? (
                <span className="pc-orders__n pc-orders__n--hot">
                  {orders.directivesTotalOpen}
                </span>
              ) : null}
            </h4>
            {(orders.directives ?? []).length > 0 ? (
              <>
                {(orders.directives ?? []).map((d) => (
                  <blockquote className="pc-orders__verbatim" key={d.id}>
                    {d.verbatimText}
                    <cite className="pc-orders__cite">
                      {formatAgeShort(nowMs - d.createdAtMs) ?? ''}
                      {d.dispositionStatus ? ` · ${d.dispositionStatus}` : ' · open'}
                    </cite>
                  </blockquote>
                ))}
                {(orders.directivesTotalOpen ?? 0) > (orders.directives ?? []).length ? (
                  <div className="pc-orders__empty">
                    showing {(orders.directives ?? []).length} of {orders.directivesTotalOpen}
                  </div>
                ) : null}
              </>
            ) : (
              <Empty text="No open owner directives." />
            )}
          </section>

          {/* ── Standing facts ── */}
          <section className="pc-orders__sec" id="pc-orders-facts">
            <h4 className="pc-orders__h">
              Standing facts
              {(orders.facts ?? []).length > 0 ? (
                <span className="pc-orders__n">{(orders.facts ?? []).length}</span>
              ) : null}
            </h4>
            {(orders.facts ?? []).length > 0 ? (
              (orders.facts ?? []).map((f) => (
                <div className="pc-orders__row" key={f.key}>
                  <span className="pc-orders__glyph pc-orders__glyph--fact">§</span>
                  <span className="pc-orders__txt" title={f.key}>
                    {f.body}
                    {f.possiblyStale ? (
                      <span className="pc-orders__badge pc-orders__badge--warn">
                        source drifted
                      </span>
                    ) : null}
                  </span>
                </div>
              ))
            ) : (
              <Empty text="No standing facts in scope." />
            )}
          </section>

          {/* ── Walls: blocked on the owner ── */}
          <section className="pc-orders__sec" id="pc-orders-walls">
            <h4 className="pc-orders__h">
              Walls
              {(orders.walls ?? []).length > 0 ? (
                <span className="pc-orders__n pc-orders__n--hot">
                  {(orders.walls ?? []).length}
                </span>
              ) : null}
            </h4>
            {(orders.walls ?? []).length > 0 ? (
              (orders.walls ?? []).map((w, i) => (
                <div className="pc-orders__wall" key={`${w.claim}:${i}`}>
                  <span className="pc-orders__wall-ask">{w.claim}</span>
                  <span className="pc-orders__wall-meta">
                    {w.sinceMs ? `waiting ${formatAgeShort(nowMs - w.sinceMs) ?? ''}` : 'waiting'}
                    {w.recheck ? ` · recheck: ${w.recheck}` : ''}
                  </span>
                </div>
              ))
            ) : (
              <Empty text="Nothing blocked on you." />
            )}
          </section>

          {/* ── Carry: what it is tracking, and how old that is ── */}
          <section className="pc-orders__sec" id="pc-orders-carry">
            <h4 className="pc-orders__h">
              Carry
              {carryMode ? (
                <span
                  className="pc-orders__n"
                  title={
                    carryMode === 'cold'
                      ? 'Cold carry: every wake rebuilds from the checkpoint, so the checkpoint is this agent’s only memory.'
                      : 'Warm carry: each wake resumes the live context.'
                  }
                >
                  {carryMode}
                </span>
              ) : null}
            </h4>
            {unavailable.has('carry') ? (
              <Unavailable what="the carry brief" />
            ) : carry ? (
              <>
                <div className="pc-orders__kv">
                  <span className="k">loop</span>
                  <span className="v">
                    {carry.loopActive
                      ? `armed${carry.loopIntervalSec ? ` · every ${carry.loopIntervalSec}s` : ''}`
                      : 'not armed'}
                  </span>
                </div>

                {/* neverWritten is a FINDING about the agent, not a gap in our
                    data — an agent running a loop with no carry-note loses its
                    thread at the next cold wake. Say so plainly. */}
                {carry.neverWritten ? (
                  <div className="pc-orders__empty" data-testid="orders-carry-never">
                    No carry-note ever written{carry.loopActive ? ' — a cold wake would start blank' : ''}.
                  </div>
                ) : (
                  <>
                    <div className="pc-orders__sub">
                      carry-note
                      <AgeChip atMs={carry.noteUpdatedAtMs} mode={carryMode} nowMs={nowMs} />
                    </div>
                    <blockquote className="pc-orders__verbatim pc-orders__verbatim--note">
                      {carry.note}
                    </blockquote>
                  </>
                )}

                {(carry.heldItems ?? []).length > 0 ? (
                  <>
                    <div className="pc-orders__sub">checkpoints</div>
                    {(carry.heldItems ?? []).map((h) => (
                      <div className="pc-orders__row" key={h.id}>
                        <span className="pc-orders__glyph">▪</span>
                        <span className="pc-orders__txt">
                          <b>{h.id}</b>
                          {h.checkpoint ? (
                            <span className="pc-orders__reason">{h.checkpoint}</span>
                          ) : (
                            <span className="pc-orders__reason pc-orders__reason--none">
                              never checkpointed
                            </span>
                          )}
                        </span>
                        <AgeChip atMs={h.checkpointUpdatedAtMs} mode={carryMode} nowMs={nowMs} />
                      </div>
                    ))}
                  </>
                ) : null}

                {/* The #1 stale-conclusion tell, per carry-brief.ts itself. */}
                {(carry.citedRefsTerminal ?? []).length > 0 ? (
                  <div className="pc-orders__drift" data-testid="orders-cited-drift">
                    ⚠ cited and since changed: {(carry.citedRefsTerminal ?? []).join(', ')}
                  </div>
                ) : null}

                {carry.postNoteInbox && carry.postNoteInbox.count > 0 ? (
                  <div className="pc-orders__kv">
                    <span className="k">since note</span>
                    <span className="v">
                      {carry.postNoteInbox.count} directed message
                      {carry.postNoteInbox.count === 1 ? '' : 's'} — the note predates them
                    </span>
                  </div>
                ) : null}

                {(carry.checks ?? []).length > 0 ? (
                  <>
                    <div className="pc-orders__sub">checks</div>
                    {(carry.checks ?? []).map((c, i) => (
                      <div className="pc-orders__row" key={`${c.claim}:${i}`}>
                        <span
                          className={`pc-orders__glyph ${c.verified ? 'pc-orders__glyph--ok' : ''}`}
                          title={c.verified ? 'verified' : 'predicted — not yet confirmed'}
                        >
                          {c.verified ? '✓' : '?'}
                        </span>
                        <span className="pc-orders__txt">
                          {c.claim}
                          {c.recheck ? (
                            <span className="pc-orders__reason">probe: {c.recheck}</span>
                          ) : null}
                        </span>
                      </div>
                    ))}
                  </>
                ) : null}

                {(carry.awaits ?? []).length > 0 ? (
                  <>
                    <div className="pc-orders__sub">awaits that survive a respawn</div>
                    {(carry.awaits ?? []).map((a) => (
                      <div className="pc-orders__row" key={a.eventKey}>
                        <span className="pc-orders__glyph">◉</span>
                        <span className="pc-orders__txt" title={a.note ?? undefined}>
                          {a.eventKey}
                        </span>
                      </div>
                    ))}
                  </>
                ) : null}
              </>
            ) : (
              <Empty text="No carry state." />
            )}
          </section>
        </>
      ) : null}
    </aside>
  );
}
