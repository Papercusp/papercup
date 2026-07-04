/**
 * Swarm / Colony tab — the live fleet roster, split into SU agents (🛠) and Bees
 * (🐝) with the zellij dock glyphs. Each row EXPANDS inline on click to that
 * agent's task-list + plan-progress + recent comms (owner ask 2026-06-23):
 *
 *   1. expandable rows — tasks/plans/comms live under the agent, not in a
 *      separate section that a click merely filters.
 *   2. zellij SU/Bee icons (apps/tui agent_pane_kind glyphs).
 *   3. comms folded per-agent (the old global "comms" toggle is gone — its
 *      data was live but read as dead when empty; per-agent mail is clearer).
 *   4. SU agents and Bees in separate sections (classified by presence source).
 *
 * Selection lives in the URL (nuqs `?lsa=…`) so it stays deep-linkable +
 * agent-driveable (ui:get_state / ui:dispatch).
 */
import { useMemo } from 'react';
import { Link } from '@tanstack/react-router';
import { useSyncQuery } from '@papercusp/sync';
import { useQueryState, parseAsString } from 'nuqs';

interface PresenceRecord {
  ownerId: string;
  ownerLabel: string;
  source?: string | null;
  agentRole?: string | null;
  intent: string | null;
  currentPlanSlug: string | null;
  heartbeatAt: string | number | null;
  stale: boolean;
}

interface WorkListItem {
  id: string;
  itemKind?: string | null;
  title?: string | null;
  status?: string | null;
  rank?: number | null;
}

interface AgentClaimLite {
  type?: string | null;
  id?: string | null;
  harnessSlug?: string | null;
  planSlug?: string | null;
}

interface BeeGroup {
  agentId: string;
  label?: string | null;
  name?: string | null;
  alive: boolean;
  intent?: string | null;
  declaredPlanSlug?: string | null;
  claims?: AgentClaimLite[];
  doing?: WorkListItem | null;
  queued: WorkListItem[];
  load: number;
}

interface PlanRow {
  slug: string;
  harness?: string | null;
  archived?: boolean;
  priority?: number | null;
  itemCounts?: { todo?: number; done?: number; blocked?: number; failed?: number } | null;
}

interface MailEntry {
  msg_id?: string;
  kind?: string;
  from?: string | null;
  to?: string[];
  summary?: string | null;
  ts?: string;
}

interface BeeMailRow {
  owner: string;
  inbox: MailEntry[];
  outbox: MailEntry[];
}

function planTotals(p: PlanRow): { done: number; total: number } {
  const c = p.itemCounts ?? {};
  const done = c.done ?? 0;
  const total = done + (c.todo ?? 0) + (c.blocked ?? 0) + (c.failed ?? 0);
  return { done, total };
}

/**
 * Rows used to be plain `<a href>` anchors — which TanStack Router cannot
 * intercept, so every click did a FULL PAGE RELOAD (owner bug 2026-06-23). They
 * are now `<Link to search>` for client-side nav: the destination route's
 * `useSyncQuery`s hydrate the right pane in place, no reload.
 *
 * The `search` is always applied as a MERGE over the live URL (the `(prev) =>`
 * updater below), never a plain object — because the Colony rail's own state
 * (`?lsb`/`lst`/`lsa`) rides in the same search string, so a wholesale replace
 * would collapse/reset the sidebar on every click. (Same convention as
 * QueenTab's navigate() in this directory.) Empty values are dropped.
 */
type RowSearch = Record<string, string | number | null | undefined>;

function mergeSearch(params: RowSearch) {
  return (prev: Record<string, unknown>) => {
    const next: Record<string, unknown> = { ...prev };
    for (const [key, value] of Object.entries(params)) {
      if (value == null || value === '') delete next[key];
      else next[key] = value;
    }
    return next;
  };
}

/** Work-item → its harness Working pane (needs the owning harness from the claim). */
function taskSearch(w: WorkListItem, g: BeeGroup | undefined): RowSearch | null {
  const claim = g?.claims?.find((c) => c.type === 'work-item' && c.id === w.id && c.harnessSlug);
  if (!claim?.harnessSlug) return null;
  return { tab: 'harnesses', slug: claim.harnessSlug, scope: 'self', sel: w.id };
}

function planSearch(p: PlanRow): RowSearch {
  return { view: 'plans', plan: p.slug, h: p.harness };
}

function mailSearch(ownerId: string, mm: MailEntry): RowSearch {
  return { tab: 'conversations', conv: 'feed', fagent: ownerId, fmsg: mm.msg_id };
}

/**
 * Classify a presence row: `fleet-spawn`/`signed-spawn` (or agentRole 'bee') is
 * a fleet Bee; everything else (omp-hook-session / static-client = SU, plus the
 * human power-user) sits in the SU/agents section.
 */
function isBee(r: PresenceRecord): boolean {
  const s = r.source ?? '';
  return r.agentRole === 'bee' || s === 'fleet-spawn' || s === 'signed-spawn';
}

export default function SwarmTab({ active }: { active: boolean }) {
  const [selected, setSelected] = useQueryState('lsa', parseAsString);

  const presence = useSyncQuery<PresenceRecord>({
    queryName: 'dev.coordPresence',
    enabled: active,
    staleTime: 8_000,
  });
  const bees = useSyncQuery<BeeGroup>({
    queryName: 'sidebar.fleetBees',
    enabled: active,
    staleTime: 8_000,
  });
  const plans = useSyncQuery<PlanRow>({
    queryName: 'plans.list',
    enabled: active,
    staleTime: 15_000,
  });
  // Per-agent comms: only fetched for the expanded agent.
  const mail = useSyncQuery<BeeMailRow>({
    queryName: 'sidebar.beeMail',
    args: { owner: selected ?? '' },
    enabled: active && !!selected,
    staleTime: 8_000,
  });

  const roster = useMemo(() => (presence.data ?? []).filter((r) => !r.stale), [presence.data]);
  const byAgent = useMemo(() => {
    const m = new Map<string, BeeGroup>();
    for (const g of bees.data ?? []) m.set(g.agentId, g);
    return m;
  }, [bees.data]);

  const suAgents = useMemo(() => roster.filter((r) => !isBee(r)), [roster]);
  const beeAgents = useMemo(() => roster.filter((r) => isBee(r)), [roster]);

  const toggle = (id: string) => {
    void setSelected(selected === id ? null : id);
  };

  const taskRow = (w: WorkListItem, i: number, g: BeeGroup | undefined) => {
    const search = taskSearch(w, g);
    const label = w.title || w.id;
    const body = (
      <>
        <span className="pclsb-task__rank">{w.rank != null ? `#${w.rank}` : '—'}</span>
        <span className="pclsb-task__main">
          <span className="pclsb-task__title">{label}</span>
          <span className="pclsb-task__id">{w.id}</span>
        </span>
        {w.status && <span className="pclsb-task__st">{w.status}</span>}
      </>
    );
    return search ? (
      <Link
        className="pclsb-task pclsb-linkrow"
        key={`${w.id}-${i}`}
        to="/adv"
        search={mergeSearch(search)}
        aria-label={`Open task ${w.id}: ${label}`}
      >
        {body}
      </Link>
    ) : (
      <div className="pclsb-task" key={`${w.id}-${i}`}>
        {body}
      </div>
    );
  };

  const renderExpansion = (r: PresenceRecord) => {
    const g = byAgent.get(r.ownerId);
    const slugs = new Set<string>();
    if (g?.declaredPlanSlug) slugs.add(g.declaredPlanSlug);
    for (const c of g?.claims ?? []) if (c.planSlug) slugs.add(c.planSlug);
    if (r.currentPlanSlug) slugs.add(r.currentPlanSlug);
    const agentPlans = (plans.data ?? [])
      .filter((p) => !p.archived && slugs.has(p.slug) && planTotals(p).total > 0)
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

    const m = mail.data?.[0];
    const inbox = [...(m?.inbox ?? [])].reverse().slice(0, 6);
    const outbox = [...(m?.outbox ?? [])].reverse().slice(0, 6);
    const hasMail = inbox.length > 0 || outbox.length > 0;

    return (
      <div className="pclsb-expand" data-testid={`swarm-expand-${r.ownerId}`}>
        <div className="pclsb-expand__head">Tasks{g ? ` · ${g.load} claimed` : ''}</div>
        {g && g.queued.length > 0 ? (
          g.queued.map((w, i) => taskRow(w, i, g))
        ) : (
          <div className="pclsb-expand__empty">{g ? 'no work-items claimed' : 'no fleet task data'}</div>
        )}

        <div className="pclsb-expand__head">Plan progress</div>
        {agentPlans.length > 0 ? (
          agentPlans.slice(0, 8).map((p) => {
            const { done, total } = planTotals(p);
            const pct = total > 0 ? Math.round((done / total) * 100) : 0;
            return (
              <Link
                className="pclsb-plan pclsb-linkrow"
                key={p.slug}
                to="/admin/plans"
                search={mergeSearch(planSearch(p))}
                aria-label={`Open plan ${p.slug}`}
              >
                <span className="pclsb-plan__slug">
                  {p.slug}
                </span>
                <span className="pclsb-plan__bar" aria-hidden="true">
                  <span className="pclsb-plan__fill" style={{ width: `${pct}%` }} />
                </span>
                <span className="pclsb-plan__pct">{pct}%</span>
                <span className="pclsb-plan__nums">
                  {done}/{total}
                </span>
              </Link>
            );
          })
        ) : (
          <div className="pclsb-expand__empty">no linked plans</div>
        )}

        {(hasMail || (selected === r.ownerId && mail.loading)) && (
          <>
            <div className="pclsb-expand__head">Recent messages</div>
            {mail.loading && !hasMail && <div className="pclsb-expand__empty">loading…</div>}
            {inbox.map((mm, i) => (
              <Link
                className="pclsb-mail pclsb-linkrow"
                to="/adv"
                search={mergeSearch(mailSearch(r.ownerId, mm))}
                key={`in-${mm.msg_id ?? i}`}
                aria-label={`Open inbound message from ${mm.from ?? 'unknown'}`}
              >
                <div className="pclsb-mail__meta">
                  Inbox · {mm.from ?? '?'} · {mm.kind ?? 'message'}
                </div>
                <span className="pclsb-mail__summary">{mm.summary ?? '(no summary)'}</span>
              </Link>
            ))}
            {outbox.map((mm, i) => (
              <Link
                className="pclsb-mail pclsb-linkrow"
                to="/adv"
                search={mergeSearch(mailSearch(r.ownerId, mm))}
                key={`out-${mm.msg_id ?? i}`}
                aria-label={`Open outbound message to ${(mm.to ?? []).join(', ') || 'all'}`}
              >
                <div className="pclsb-mail__meta">
                  Outbox · {(mm.to ?? []).join(', ') || '*'} · {mm.kind ?? 'message'}
                </div>
                <span className="pclsb-mail__summary">{mm.summary ?? '(no summary)'}</span>
              </Link>
            ))}
          </>
        )}
      </div>
    );
  };

  const renderAgentRow = (r: PresenceRecord, icon: string) => {
    const g = byAgent.get(r.ownerId);
    const isSel = selected === r.ownerId;
    return (
      <div className="pclsb-agent" key={r.ownerId}>
        <div
          className={`pclsb-row is-clickable${isSel ? ' is-selected' : ''}`}
          data-testid={`swarm-agent-${r.ownerId}`}
          onClick={() => toggle(r.ownerId)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') toggle(r.ownerId);
          }}
        >
          <span className="pclsb-row__icon" aria-hidden="true">
            {icon}
          </span>
          <div className="pclsb-row__main">
            <div className="pclsb-row__title" title={r.ownerId}>
              {r.ownerLabel || r.ownerId}
            </div>
            <div className="pclsb-row__sub" title={r.intent ?? undefined}>
              {r.intent || g?.intent || 'no declared intent'}
            </div>
          </div>
          {g && g.load > 0 && <span className="pclsb-pill">⇄{g.load}</span>}
          <span className="pclsb-row__chev" aria-hidden="true">
            {isSel ? '▾' : '▸'}
          </span>
        </div>
        {isSel && renderExpansion(r)}
      </div>
    );
  };

  return (
    <div className="pclsb-panel" data-testid="left-sidebar-swarm">
      <div className="pclsb-panel__bar">
        <span className="pclsb-panel__bar-label">colony · {roster.length} live</span>
      </div>

      {presence.error && <div className="pclsb-panel__error">{String(presence.error)}</div>}
      {roster.length === 0 && !presence.loading && (
        <div className="pclsb-panel__empty">No agents active right now.</div>
      )}

      {suAgents.length > 0 && (
        <div className="pclsb-sec" data-testid="swarm-su">
          <div className="pclsb-sec__head">🛠 SU agents ({suAgents.length})</div>
          {suAgents.map((r) => renderAgentRow(r, '🛠'))}
        </div>
      )}

      {beeAgents.length > 0 && (
        <div className="pclsb-sec" data-testid="swarm-bees">
          <div className="pclsb-sec__head">☕ Bees ({beeAgents.length})</div>
          {beeAgents.map((r) => renderAgentRow(r, '☕'))}
        </div>
      )}
    </div>
  );
}
