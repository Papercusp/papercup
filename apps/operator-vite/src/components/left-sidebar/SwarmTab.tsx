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

  const taskRow = (w: WorkListItem, i: number) => (
    <div className="pclsb-task" key={`${w.id}-${i}`}>
      <span className="pclsb-task__rank">{w.rank != null ? `#${w.rank}` : '—'}</span>
      <span className="pclsb-task__title" title={w.title ?? w.id}>
        {w.title || w.id}
      </span>
      <span className="pclsb-task__st">{w.status ?? ''}</span>
    </div>
  );

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
        <div className="pclsb-expand__head">tasks{g ? ` · ${g.load} claimed` : ''}</div>
        {g && g.queued.length > 0 ? (
          g.queued.map(taskRow)
        ) : (
          <div className="pclsb-expand__empty">{g ? 'no work-items claimed' : 'no fleet task data'}</div>
        )}

        <div className="pclsb-expand__head">plan progress</div>
        {agentPlans.length > 0 ? (
          agentPlans.slice(0, 8).map((p) => {
            const { done, total } = planTotals(p);
            const pct = total > 0 ? Math.round((done / total) * 100) : 0;
            return (
              <div className="pclsb-plan" key={p.slug}>
                <span className="pclsb-plan__slug" title={p.slug}>
                  {p.slug}
                </span>
                <span className="pclsb-plan__bar">
                  <span className="pclsb-plan__fill" style={{ width: `${pct}%` }} />
                </span>
                <span className="pclsb-plan__nums">
                  {done}/{total}
                </span>
              </div>
            );
          })
        ) : (
          <div className="pclsb-expand__empty">no linked plans</div>
        )}

        {(hasMail || (selected === r.ownerId && mail.loading)) && (
          <>
            <div className="pclsb-expand__head">recent comms</div>
            {mail.loading && !hasMail && <div className="pclsb-expand__empty">loading…</div>}
            {inbox.map((mm, i) => (
              <div className="pclsb-mail" key={`in-${mm.msg_id ?? i}`}>
                <div className="pclsb-mail__meta">
                  ↘ {mm.from ?? '?'} · {mm.kind ?? 'message'}
                </div>
                {mm.summary ?? ''}
              </div>
            ))}
            {outbox.map((mm, i) => (
              <div className="pclsb-mail" key={`out-${mm.msg_id ?? i}`}>
                <div className="pclsb-mail__meta">
                  ↗ {(mm.to ?? []).join(', ') || '*'} · {mm.kind ?? 'message'}
                </div>
                {mm.summary ?? ''}
              </div>
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
          <div className="pclsb-sec__head">🐝 Bees ({beeAgents.length})</div>
          {beeAgents.map((r) => renderAgentRow(r, '🐝'))}
        </div>
      )}
    </div>
  );
}
