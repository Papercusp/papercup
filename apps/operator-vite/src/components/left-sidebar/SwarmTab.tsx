/**
 * Swarm tab (left-sidebar-tauri-2026-06-07) — the desktop twin of the pui
 * Swarm/Fleet tab: the live agent roster over the fleet dossier.
 *
 *   - Roster: live coord agents (dev.coordPresence) joined to their assignment
 *     groups (sidebar.fleetBees) for the ⇄done/queued load cell.
 *   - Dossier: defaults to the WHOLE-FLEET task list (every agent's claimed
 *     work-items, busiest first); selecting an agent filters to its ranked
 *     work-list. Plan progress narrows to the selected agent's plans
 *     (declared + claim slugs) the same way.
 *   - Comms: a toggle swaps the dossier for the selected agent's coord
 *     inbox/outbox (sidebar.beeMail) over the whole-fleet conversations
 *     (sidebar.conversations) — mirroring the pui comms sub-view.
 *
 * Selection + the comms toggle live in the URL (nuqs `?lsa=…&lsc=1`) so the
 * view is deep-linkable and agent-driveable.
 */
import { useMemo } from 'react';
import { useSyncQuery } from '@papercusp/sync';
import { useQueryState, parseAsBoolean, parseAsString } from 'nuqs';
import { useLexicon } from '@/lib/useLexicon';
import { Chip } from '../ui';

interface PresenceRecord {
  ownerId: string;
  ownerLabel: string;
  source?: string | null;
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

interface ConversationRowLite {
  id: string;
  title?: string | null;
  state?: string | null;
  kind?: string | null;
  asker_id?: string | null;
}

function planTotals(p: PlanRow): { done: number; total: number } {
  const c = p.itemCounts ?? {};
  const done = c.done ?? 0;
  const total = done + (c.todo ?? 0) + (c.blocked ?? 0) + (c.failed ?? 0);
  return { done, total };
}

/** Every plan slug an agent is linked to — declared + claim slugs (pui parity). */
function agentPlanSlugs(g: BeeGroup): Set<string> {
  const out = new Set<string>();
  if (g.declaredPlanSlug) out.add(g.declaredPlanSlug);
  for (const c of g.claims ?? []) if (c.planSlug) out.add(c.planSlug);
  return out;
}

export default function SwarmTab({ active }: { active: boolean }) {
  const t = useLexicon();
  // Selected agent (ownerId) + the comms toggle — URL state (nuqs default).
  const [selected, setSelected] = useQueryState('lsa', parseAsString);
  const [comms, setComms] = useQueryState('lsc', parseAsBoolean.withDefault(false));

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
  const mail = useSyncQuery<BeeMailRow>({
    queryName: 'sidebar.beeMail',
    args: { owner: selected ?? '' },
    enabled: active && comms && !!selected,
    staleTime: 8_000,
  });
  const convs = useSyncQuery<ConversationRowLite>({
    queryName: 'sidebar.conversations',
    args: { limit: 30 },
    enabled: active && comms,
    staleTime: 15_000,
  });

  const roster = useMemo(
    () => (presence.data ?? []).filter((r) => !r.stale),
    [presence.data],
  );
  const groups = useMemo(() => bees.data ?? [], [bees.data]);
  const byAgent = useMemo(() => {
    const m = new Map<string, BeeGroup>();
    for (const g of groups) m.set(g.agentId, g);
    return m;
  }, [groups]);

  const selectedGroup = selected ? byAgent.get(selected) : undefined;

  // Plan progress — fleet-wide, narrowed to the selected agent's plans (#2).
  const visiblePlans = useMemo(() => {
    const all = (plans.data ?? []).filter((p) => !p.archived && planTotals(p).total > 0);
    const filterSet = selectedGroup ? agentPlanSlugs(selectedGroup) : null;
    const filtered = filterSet ? all.filter((p) => filterSet.has(p.slug)) : all;
    return filtered.sort((a, b) => {
      const pa = b.priority ?? 0;
      const pb = a.priority ?? 0;
      if (pa !== pb) return pa - pb;
      const ra = planTotals(b);
      const rb = planTotals(a);
      return ra.total - ra.done - (rb.total - rb.done);
    });
  }, [plans.data, selectedGroup]);

  // Whole-fleet task list: every agent's claimed work, busiest first.
  const fleetTaskGroups = useMemo(
    () => [...groups].filter((g) => g.load > 0 || g.alive).sort((a, b) => b.load - a.load),
    [groups],
  );
  const totalClaimed = groups.reduce((n, g) => n + g.load, 0);

  const selectRow = (ownerId: string) => {
    void setSelected(selected === ownerId ? null : ownerId);
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

  return (
    <div className="pclsb-panel" data-testid="left-sidebar-swarm">
      {/* Roster */}
      <div className="pclsb-panel__bar">
        <span className="pclsb-panel__bar-label">
          {t('fleet')} · {roster.length} live
        </span>
        <span className="pclsb-panel__bar-spacer" />
        <Chip
          active={comms}
          data-testid="left-sidebar-comms-toggle"
          onClick={() => setComms(!comms)}
        >
          comms
        </Chip>
        {selected && (
          <Chip onClick={() => setSelected(null)}>
            ✕ filter
          </Chip>
        )}
      </div>

      {presence.error && <div className="pclsb-panel__error">{String(presence.error)}</div>}
      {roster.length === 0 && !presence.loading && (
        <div className="pclsb-panel__empty">No agents active right now.</div>
      )}
      {roster.map((r) => {
        const g = byAgent.get(r.ownerId);
        const isSel = selected === r.ownerId;
        return (
          <div
            key={r.ownerId}
            className={`pclsb-row is-clickable${isSel ? ' is-selected' : ''}`}
            data-testid={`swarm-agent-${r.ownerId}`}
            onClick={() => selectRow(r.ownerId)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') selectRow(r.ownerId);
            }}
          >
            <span className="pclsb-dot is-up" aria-hidden="true" />
            <div className="pclsb-row__main">
              <div className="pclsb-row__title" title={r.ownerId}>
                {r.ownerLabel || r.ownerId}
              </div>
              <div className="pclsb-row__sub" title={r.intent ?? undefined}>
                {r.intent || g?.intent || 'no declared intent'}
              </div>
            </div>
            {g && g.load > 0 && <span className="pclsb-pill">⇄{g.load}</span>}
          </div>
        );
      })}

      {comms ? (
        <>
          {/* Comms: the selected agent's direct mail over fleet conversations. */}
          <div className="pclsb-sec">
            <div className="pclsb-sec__head">
              ↘ inbox / ↗ outbox{selected ? '' : ' — select an agent'}
            </div>
            {selected && mail.data?.[0] && (
              <>
                {[...(mail.data[0].inbox ?? [])].reverse().slice(0, 12).map((m, i) => (
                  <div className="pclsb-mail" key={`in-${m.msg_id ?? i}`}>
                    <div className="pclsb-mail__meta">↘ {m.from ?? '?'} · {m.kind ?? 'message'}</div>
                    {m.summary ?? ''}
                  </div>
                ))}
                {[...(mail.data[0].outbox ?? [])].reverse().slice(0, 12).map((m, i) => (
                  <div className="pclsb-mail" key={`out-${m.msg_id ?? i}`}>
                    <div className="pclsb-mail__meta">↗ to {(m.to ?? []).join(', ') || '*'} · {m.kind ?? 'message'}</div>
                    {m.summary ?? ''}
                  </div>
                ))}
              </>
            )}
          </div>
          <div className="pclsb-sec">
            <div className="pclsb-sec__head">fleet conversations ({(convs.data ?? []).length})</div>
            {(convs.data ?? []).slice(0, 15).map((c) => (
              <div className="pclsb-mail" key={c.id}>
                <div className="pclsb-mail__meta">
                  {c.kind ?? 'thread'} · {c.state ?? ''} · {c.asker_id ?? ''}
                </div>
                {c.title ?? c.id}
              </div>
            ))}
            {(convs.data ?? []).length === 0 && (
              <div className="pclsb-panel__empty">(no fleet conversations)</div>
            )}
          </div>
        </>
      ) : (
        <>
          {/* Dossier: the selected agent's ranked work-list, else the fleet's. */}
          <div className="pclsb-sec" data-testid="swarm-dossier">
            <div className="pclsb-sec__head">
              {selectedGroup
                ? `task list — ${selectedGroup.name ?? selectedGroup.label ?? selected} (${selectedGroup.load} claimed)`
                : `fleet task list (${totalClaimed} claimed)`}
            </div>
            {selectedGroup ? (
              selectedGroup.queued.length > 0 ? (
                selectedGroup.queued.map(taskRow)
              ) : (
                <div className="pclsb-panel__empty">(no work-items claimed)</div>
              )
            ) : fleetTaskGroups.length > 0 ? (
              fleetTaskGroups.map((g) => (
                <div key={g.agentId}>
                  <div className="pclsb-mail__meta" style={{ padding: '4px 2px 0' }}>
                    {g.name ?? g.label ?? g.agentId} ({g.load})
                  </div>
                  {g.queued.map(taskRow)}
                </div>
              ))
            ) : (
              <div className="pclsb-panel__empty">
                {bees.loading ? 'loading fleet task list…' : '(no claimed work in the fleet)'}
              </div>
            )}
          </div>

          {/* Plan progress — fleet-wide, or the selected agent's plans. */}
          <div className="pclsb-sec" data-testid="swarm-plans">
            <div className="pclsb-sec__head">
              plan progress{selectedGroup ? ` — ${selectedGroup.name ?? selected}` : ''}
            </div>
            {visiblePlans.slice(0, 12).map((p) => {
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
            })}
            {visiblePlans.length === 0 && (
              <div className="pclsb-panel__empty">
                {selectedGroup ? '(no plans for this agent — ✕ filter for the whole fleet)' : '(no plan items)'}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
